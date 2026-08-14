import { loadDatabaseConfig, loadEmbeddingConfig } from '../config.ts';
import { createDatabase } from '../db.ts';
import { probeCapabilities, retrievalPathFor } from '../capability.ts';
import { createOfflineEmbedder } from './offline-embedder.ts';
import { createRepository } from '../repository.ts';
import { decideSeed, describeSeedDecision } from '../seed-plan.ts';

/**
 * Put a small, honest incident on the demo workspace so the console and the archive have something
 * to show.
 *
 * WHY THIS EXISTS. The first time anything drove the console in a real browser against a running
 * API, every page worked and every page was empty: the archive drew a correct COVERED receipt over
 * zero rows, and the agent answered "There are no prior incidents like this on record". Both were
 * telling the truth. The demo workspace had never had a row written to it, because `verify-live`
 * writes to a workspace of its own and deletes it again. So the product's central claim - a recall
 * you can audit, and an archive whose history you can read - had nothing to demonstrate itself with.
 *
 * `assertedBy` IS `system:demo-seed` ON EVERY ROW, and that is the whole argument of this project
 * applied to its own demo data. Writing `human:oncall-ana` would have read better on the page and
 * would have been an invented person asserting an invented claim, on the one screen whose purpose is
 * showing where a claim came from. A reader who looks at the provenance column learns immediately
 * that these are seeded rows. That is a stronger demonstration of the column working than a
 * plausible name would have been.
 *
 * The scenario itself is scripted and says so. `INC-1042` is a scenario identifier, not a record of
 * anything that happened.
 *
 * IDEMPOTENT: it refuses to write when the workspace already holds rows, rather than stacking a
 * second copy of the same incident on every run.
 *
 * `--force` APPENDS A SECOND INCIDENT. It does not delete anything and it does not re-seed from
 * scratch; there is no delete path in this file at all. An earlier version of this paragraph said
 * "re-seeding from scratch" and "it says what it is about to do", and a review found both false -
 * the flag skipped the guard silently. It now prints what it is about to do, and the sentence
 * matches the code. To actually start over, remove the workspace's rows first.
 *
 * A HALF-WRITTEN WORKSPACE IS REPORTED, NOT TREATED AS DONE. The six writes are separate statements
 * and nothing wraps them in one transaction, so an interruption can leave an incident with no
 * resolution or a resolution with no chain. A guard that only asks "are there rows" would then say
 * "already here, nothing written" forever and exit 0, while the archive drew a confident COVERED
 * receipt over a broken incident. So the guard looks for the SHAPE of a finished seed, and when it
 * finds something in between it DESCRIBES what is there and exits non-zero without writing.
 *
 * It describes rather than diagnoses. A workspace holding four rows might be an interrupted seed or
 * might be rows the agent wrote itself, and nothing available here distinguishes them, so naming one
 * would be the invented certainty this whole project argues against. A page the API BOUNDED gets the
 * same treatment for the same reason: it is not the archive, so no count taken from it settles
 * anything, and the run says so and exits non-zero instead of reporting a clean skip.
 *
 * A LISTING THAT COULD NOT BE READ AT ALL IS THE ONE CASE `--force` DOES NOT OVERRIDE. The flag
 * means "append on top of what is there", and on an unreadable listing nobody knows what is there.
 * That refusal used to be a `throw` in this file, which put it out of reach of every test, so it is
 * now one of the outcomes `seed-plan.ts` decides and this file prints.
 */

const WORKSPACE = process.env['DEMO_WORKSPACE_ID'] ?? 'demo';
const SEEDER = 'system:demo-seed';
const INCIDENT = 'INC-1042';

interface Seed {
  readonly kind: 'observation' | 'resolution' | 'runbook_fact' | 'rejected_hypothesis' | 'entity_fact';
  readonly content: string;
  readonly incidentId: string | null;
}

/**
 * Five kinds, one incident, and a chain.
 *
 * One of each kind, because the archive's filter chips are one per kind and a filter that can only
 * ever return the same rows demonstrates nothing. The resolution is superseded by a second one after
 * the writes, which is what gives the archive a row in the `superseded` state and a `supersededBy`
 * pointer to follow - the thing that makes a chain a chain, and the only part of the archive that
 * cannot be shown with a flat list.
 */
const SEEDS: readonly Seed[] = [
  {
    kind: 'observation',
    content:
      'Checkout p99 latency rose from 180 ms to 4.2 s within four minutes of the 14:02 payment-service deploy.',
    incidentId: INCIDENT,
  },
  {
    kind: 'rejected_hypothesis',
    content:
      'Restarting the checkout pods did not help. Latency was unchanged across two full rolling restarts, so the pods were not the cause.',
    incidentId: INCIDENT,
  },
  {
    kind: 'entity_fact',
    content: 'The payment gateway connection pool is sized at 120 connections in production.',
    incidentId: null,
  },
  {
    kind: 'runbook_fact',
    content:
      'Checkout latency alerts page the payments on-call rota first, not the platform rota. The runbook is at ops/runbooks/checkout-latency.',
    incidentId: null,
  },
];

const FIRST_RESOLUTION =
  'Rolling back the 14:02 payment-service deploy returned checkout p99 to 180 ms within two minutes.';

/**
 * What a finished seed looks like: every kind above, plus the resolution and the one that replaced
 * it. Derived from `SEEDS` rather than written as a literal, so adding a seed cannot leave this
 * behind and turn the completeness check into a test that always passes.
 */
const EXPECTED_ROWS = SEEDS.length + 2;

const REAL_RESOLUTION =
  'The rollback only masked it. The real fix was raising the payment gateway connection pool from 120 to 400: the deploy doubled connection hold time and the pool was saturating.';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const config = loadDatabaseConfig(process.env);
  const embeddingConfig = loadEmbeddingConfig(process.env);
  const db = createDatabase(config);
  // The CONFIGURED embedder, or a refusal. Seeding is where a silent substitution does the most
  // damage: the rows written here outlive the run, so a bedrock deployment seeded with hash vectors
  // carries two vector spaces in one column and nothing ever throws about it.
  const embedder = createOfflineEmbedder(embeddingConfig);

  try {
    console.log(`[seed] target: ${db.describe()}`);
    console.log(`[seed] workspace: ${WORKSPACE}`);

    const capabilities = await probeCapabilities(db, { schema: config.schema, embedder });
    const retrieval = retrievalPathFor(capabilities);
    if (retrieval.path === 'none') {
      // Refused rather than seeded blind. Rows written with no usable retrieval path would sit in a
      // demo that cannot recall them, which looks like a seeding failure and is not one.
      throw new Error(`No usable retrieval path, so seeding would produce an unsearchable demo: ${retrieval.reason}`);
    }
    console.log(`[seed] retrieval path: ${retrieval.path}`);

    const repository = createRepository({ db, embedder, schema: config.schema, capabilities });

    const existing = await repository.list({ workspaceId: WORKSPACE });
    const survey = {
      rows: existing.memories.length,
      superseded: existing.memories.filter((one) => one.supersededBy !== null).length,
      coverage: existing.receipt.coverage,
      coverageReason: existing.receipt.coverageReason,
      limit: existing.receipt.limit,
    };

    // THE DECISION AND ITS CONSEQUENCE BOTH LIVE IN `seed-plan.ts`. This block only carries them
    // out, and that is the whole reason both are testable. They were both here once, where nothing
    // could reach either without a database: one review restored the branching defect verbatim and
    // the suite stayed byte-identical at 993 passed, and the next deleted `process.exitCode = 1`
    // from a refusal and the suite stayed at 1004. A run that refuses to seed and exits 0 tells a
    // script it succeeded.
    const decision = decideSeed(survey, EXPECTED_ROWS, force);
    const report = describeSeedDecision(decision, survey, {
      workspace: WORKSPACE,
      expectedRows: EXPECTED_ROWS,
    });
    if (report.message !== null) {
      // The stream comes from the report rather than being chosen here, so a case can pin it. A
      // run that failed says so on stderr, which is where the unreadable refusal used to land back
      // when it was a throw.
      if (report.stream === 'stderr') console.error(report.message);
      else console.log(report.message);
    }
    process.exitCode = report.exitCode;
    if (!report.writes) return;

    const embed = (text: string): Promise<number[]> => embedder.embed(text);

    for (const seed of SEEDS) {
      const written = await repository.remember({
        workspaceId: WORKSPACE,
        kind: seed.kind,
        content: seed.content,
        provenance: { assertedBy: SEEDER, incidentId: seed.incidentId, sourceRef: null },
        embedding: await embed(seed.content),
      });
      console.log(`[seed]   ${seed.kind}: ${written.id}`);
    }

    const first = await repository.remember({
      workspaceId: WORKSPACE,
      kind: 'resolution',
      content: FIRST_RESOLUTION,
      provenance: { assertedBy: SEEDER, incidentId: INCIDENT, sourceRef: null },
      embedding: await embed(FIRST_RESOLUTION),
    });
    console.log(`[seed]   resolution: ${first.id}`);

    const { previous, replacement } = await repository.supersede(first.id, {
      workspaceId: WORKSPACE,
      kind: 'resolution',
      content: REAL_RESOLUTION,
      provenance: { assertedBy: SEEDER, incidentId: INCIDENT, sourceRef: null },
      embedding: await embed(REAL_RESOLUTION),
    });
    console.log(`[seed]   resolution: ${replacement.id} supersedes ${previous.id}`);

    // THE READ-BACK GETS THE SAME TREATMENT THE READ-BEFORE GOT. A count off a page the API bounded,
    // or could not read at all, is not a count of the archive, and printing it as one here would be
    // the confident number this file refuses to print everywhere else. The writes have already
    // happened either way, so this reports rather than refuses.
    const after = await repository.list({ workspaceId: WORKSPACE });
    const chained = after.memories.filter((one) => one.supersededBy !== null).length;
    if (after.receipt.coverage === 'COVERED') {
      console.log(
        `\n[seed] ${after.memories.length} row(s) on "${WORKSPACE}", ${chained} superseded. ` +
          `Every row is asserted by ${SEEDER}.\n`,
      );
    } else {
      console.log(
        `\n[seed] The writes are done. Reading "${WORKSPACE}" back came out ` +
          `${after.receipt.coverage} (${after.receipt.coverageReason}), so the ` +
          `${after.memories.length} row(s) below it are a page and not a count of the archive. ` +
          `Every row this run wrote is asserted by ${SEEDER}.\n`,
      );
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[seed] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
