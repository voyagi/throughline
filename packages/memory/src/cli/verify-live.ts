import { loadDatabaseConfig, loadEmbeddingConfig, secretsOf } from '../config.ts';
import { deleteWorkspaceRows } from '../cleanup.ts';
import { createDatabase } from '../db.ts';
import { probeCapabilities, retrievalPathFor } from '../capability.ts';
import { createLocalEmbedder, type Embedder } from '../embeddings.ts';
import { createRepository } from '../repository.ts';
import { DEFAULT_POLICY } from '../policy.ts';
import { assertAnswerable, CoverageUnknownError, describeCoverage } from '../coverage.ts';

/**
 * End to end verification against a LIVE cluster.
 *
 * Every claim this project makes about its memory layer is exercised here against real rows, and
 * each one is asserted rather than printed for a human to eyeball. It exits non-zero on the first
 * broken expectation, so it is usable as a gate and not only as a demonstration.
 *
 * It writes to a dedicated workspace and removes it at the end, including on failure.
 */

const WORKSPACE = `verify-live-${process.pid}`;
let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1;
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark}  ${label}${detail ? ` ${detail}` : ''}`);
}

/** An embedder that fails on demand, to prove UNKNOWN coverage is reachable rather than theoretical. */
function brokenEmbedder(dimensions: number): Embedder {
  return {
    id: `broken-embedder:${dimensions}`,
    dimensions,
    embed(): Promise<number[]> {
      return Promise.reject(new Error('the embedding provider is unreachable'));
    },
  };
}

async function main(): Promise<void> {
  const config = loadDatabaseConfig(process.env);
  const embeddingConfig = loadEmbeddingConfig(process.env);
  const db = createDatabase(config);
  const embedder = createLocalEmbedder(embeddingConfig.dimensions);

  try {
    console.log(`\n  target: ${db.describe()}`);
    console.log(`  workspace: ${WORKSPACE}\n`);

    const capabilities = await probeCapabilities(db, { schema: config.schema, embedder });
    const retrieval = retrievalPathFor(capabilities);
    console.log(`  retrieval path: ${retrieval.path}\n`);
    if (retrieval.path === 'none') {
      throw new Error(`No usable retrieval path: ${retrieval.reason}`);
    }

    const repository = createRepository({
      db,
      embedder,
      schema: config.schema,
      capabilities,
    });

    console.log('  Writing memories');
    const embed = (text: string): Promise<number[]> => embedder.embed(text);

    const outage = await repository.remember({
      workspaceId: WORKSPACE,
      kind: 'resolution',
      content: 'Checkout latency spiked after the payment deploy. Rolling back the deploy fixed it.',
      provenance: { assertedBy: 'human:oncall-ana', incidentId: 'INC-1042', sourceRef: null },
      embedding: await embed('checkout latency spike payment deploy rollback fixed'),
    });
    check('a resolution is written with provenance', Boolean(outage.id));

    const redHerring = await repository.remember({
      workspaceId: WORKSPACE,
      kind: 'rejected_hypothesis',
      content: 'Restarting the checkout pods did not help during the payment latency incident.',
      provenance: { assertedBy: 'human:oncall-ana', incidentId: 'INC-1042', sourceRef: null },
      embedding: await embed('restarting checkout pods did not help payment latency'),
    });
    check('a rejected hypothesis is a first class memory', redHerring.kind === 'rejected_hypothesis');

    const unrelated = await repository.remember({
      workspaceId: WORKSPACE,
      kind: 'observation',
      content: 'The nightly backup job finished ahead of schedule.',
      provenance: { assertedBy: 'system:cron', incidentId: null, sourceRef: null },
      embedding: await embed('nightly backup job finished ahead of schedule'),
    });
    check('an unrelated observation is written', Boolean(unrelated.id));

    console.log('\n  Provenance is enforced at the boundary');
    let rejected = false;
    try {
      await repository.remember({
        workspaceId: WORKSPACE,
        kind: 'observation',
        content: 'anonymous claim',
        provenance: { assertedBy: '   ', incidentId: null, sourceRef: null },
      });
    } catch {
      rejected = true;
    }
    check('a write with no provenance is refused', rejected);

    console.log('\n  Recall returns a receipt');
    const recalled = await repository.recall({
      workspaceId: WORKSPACE,
      text: 'checkout latency spiked after a payment deploy, have we seen this before',
    });
    console.log(`    coverage:  ${recalled.receipt.coverage}`);
    console.log(`    path:      ${recalled.receipt.retrievalPath}`);
    console.log(`    candidates:${recalled.receipt.candidatesConsidered}  returned:${recalled.receipt.returned}`);
    console.log(
      `    exclusions:${recalled.receipt.exclusions.map((e) => `${e.rule}=${e.count}`).join(' ') || 'none'}`,
    );
    console.log(`    narrative: ${describeCoverage(recalled)}`);

    check('coverage is COVERED on a healthy search', recalled.receipt.coverage === 'COVERED');
    check('the search examined real candidates', recalled.receipt.candidatesConsidered > 0);
    check('the prior incident is recalled', recalled.memories.some((m) => m.memory.id === outage.id));
    check(
      'the unrelated observation does not outrank the incident',
      recalled.memories[0]?.memory.id !== unrelated.id,
    );
    check('assertAnswerable permits a covered result', passes(() => assertAnswerable(recalled)));

    console.log('\n  Superseding closes the old row rather than deleting it');
    const { previous, replacement } = await repository.supersede(outage.id, {
      workspaceId: WORKSPACE,
      kind: 'resolution',
      content: 'The real fix was raising the payment gateway pool size. The rollback only masked it.',
      provenance: { assertedBy: 'human:reviewer-sam', incidentId: 'INC-1042', sourceRef: null },
      embedding: await embed('real fix raising payment gateway pool size rollback masked'),
    });
    check('the old row still exists', Boolean(previous.id));
    check('the old row points at its replacement', previous.supersededBy === replacement.id);
    check('the old row has an end date', previous.validUntil !== null);

    const afterSupersede = await repository.recall({
      workspaceId: WORKSPACE,
      text: 'checkout latency spiked after a payment deploy, have we seen this before',
    });
    check(
      'a superseded memory is excluded and counted',
      afterSupersede.receipt.exclusions.some((e) => e.rule === 'superseded' && e.count >= 1),
    );
    check(
      'the superseded memory is not returned',
      !afterSupersede.memories.some((m) => m.memory.id === outage.id),
    );

    console.log('\n  Eviction refuses to eat the newest memory');
    const eviction = await repository.evict(WORKSPACE, 2);
    check('nothing was evicted', eviction.evicted.length === 0);
    check('the run reports a shortfall rather than success', eviction.plan.shortfall);
    check(
      'every refusal names the grace window',
      eviction.plan.refused.length > 0 &&
        eviction.plan.refused.every((r) => r.reason === 'within_grace_window'),
      `(${eviction.plan.refused.length} refused)`,
    );

    console.log('\n  Eviction leaves a tombstone rather than a hole');
    // A SECOND repository with a zero grace window, because with the default one every row here is
    // protected and the eviction UPDATE never runs at all. The previous version of this file
    // asserted only the refusal, then claimed to exercise eviction end to end.
    const impatient = createRepository({
      db,
      embedder,
      schema: config.schema,
      capabilities,
      policy: { ...DEFAULT_POLICY, graceWindowMs: 0 },
    });
    // The memory has to be WRITTEN by the zero-grace policy, not merely read by it. `protected_until`
    // is stamped at write time and stored on the row, so a policy applied at read time cannot
    // un-protect what another policy already protected. That is the design working, and asserting
    // it the wrong way round is what surfaced it.
    const evictable = await impatient.remember({
      workspaceId: WORKSPACE,
      kind: 'observation',
      content: 'A transient probe reading that is safe to evict immediately.',
      provenance: { assertedBy: 'system:probe', incidentId: null, sourceRef: null },
      embedding: await embed('transient probe reading safe to evict'),
    });
    check('an unprotected memory is written', Boolean(evictable.id));
    check(
      'its grace window is already closed',
      evictable.protectedUntil.getTime() <= Date.now(),
    );

    const realEviction = await impatient.evict(WORKSPACE, 1);
    check('exactly one memory was evicted', realEviction.evicted.length === 1);
    check('the run reports no shortfall', !realEviction.plan.shortfall);

    const evictedId = realEviction.evicted[0];
    const tombstone = evictedId ? await impatient.getById(WORKSPACE, evictedId) : null;
    check('the evicted memory is still queryable', tombstone !== null);
    check('it carries an eviction timestamp', tombstone?.evictedAt instanceof Date);
    check('it carries a reason', Boolean(tombstone?.evictionReason));

    const afterEviction = await repository.recall({
      workspaceId: WORKSPACE,
      text: 'checkout latency spiked after a payment deploy, have we seen this before',
    });
    check(
      'the tombstone is excluded from recall and counted',
      afterEviction.receipt.exclusions.some((e) => e.rule === 'tombstoned' && e.count >= 1),
    );

    console.log('\n  A broken embedder produces UNKNOWN, not an empty result');
    const brokenRepository = createRepository({
      db,
      embedder: brokenEmbedder(embeddingConfig.dimensions),
      schema: config.schema,
      capabilities,
    });
    const blind = await brokenRepository.recall({
      workspaceId: WORKSPACE,
      text: 'checkout latency spiked after a payment deploy, have we seen this before',
    });
    console.log(`    narrative: ${describeCoverage(blind)}`);
    check('coverage is UNKNOWN', blind.receipt.coverage === 'UNKNOWN');
    check('no memories are returned', blind.memories.length === 0);
    check('the reason names the embedder', /embedding provider/i.test(blind.receipt.coverageReason));
    check(
      'concluding absence from it throws',
      throwsCoverageUnknown(() => assertAnswerable(blind)),
    );
    check(
      'the narrative never reads as an empty result',
      !/found nothing/i.test(describeCoverage(blind)),
    );

    console.log(
      `\n  ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}  ` +
        `(grace window ${DEFAULT_POLICY.graceWindowMs / 3_600_000}h)\n`,
    );
    if (failures > 0) process.exitCode = 1;
  } finally {
    // Cleanup runs even when a check threw, so a failed run does not leave rows behind that would
    // skew the next one. A cleanup that FAILS is reported rather than swallowed: the same DELETEs
    // used to end in `.catch(() => undefined)`, which kept the run honest about its checks and
    // silent about rows left in a live cluster.
    await deleteWorkspaceRows(db, {
      schema: config.schema,
      workspaceId: WORKSPACE,
      secrets: secretsOf(config),
    });
    await db.close();
  }
}

function passes(action: () => void): boolean {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}

function throwsCoverageUnknown(action: () => void): boolean {
  try {
    action();
    return false;
  } catch (error) {
    return error instanceof CoverageUnknownError;
  }
}

main().catch((error: unknown) => {
  console.error(`\n[verify-live] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
