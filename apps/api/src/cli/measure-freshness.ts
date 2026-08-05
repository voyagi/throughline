import { createRepository, deleteWorkspaceRows, probeCapabilities, secretsOf } from '@throughline/memory';
import { buildVerificationQuery } from '../mcp-verifier.ts';
import { openLiveChannels } from './live-channels.ts';

/**
 * How long after the application writes a row can the verification channel not see it yet?
 *
 * This exists because `mcp-verifier.ts` states, as a settled fact, that a row the application holds
 * and the channel cannot find is a FINDING rather than a replication artifact. That sentence was
 * standing on one sample of 436 ms, which rules out a multi-second follower-read window and says
 * nothing whatsoever about a shorter one. If a shorter window exists, the component produces a
 * false DIVERGES, which is the single output it was built to prevent.
 *
 * WHAT THIS CAN AND CANNOT ESTABLISH, because the difference decides how the claim may be worded.
 * The instrument reads through the channel, so it can never observe faster than one round trip of
 * that channel. A row found on the FIRST read therefore proves the window is shorter than that
 * round trip; it does not prove the window is zero. The useful number is not really the latency at
 * all. It is the count of trials in which a read that came AFTER a completed write failed to find
 * the row. That count is what the verifier's claim rests on, and it is what this prints.
 *
 * A trial that needs more than one read has measured a real window, and the polls-per-trial column
 * is where that would show up. Reading it as "the window is X ms" when every trial hit on the
 * first read is reading the channel's latency, not the database's.
 *
 * Run: `npm run measure:freshness -- [trials]` (default 25). Needs a live cluster and a real key.
 */

const WORKSPACE = `measure-freshness-${process.pid}`;
const DEFAULT_TRIALS = 25;
/** A trial that cannot see its own row after this long has found something worth reporting. */
const GIVE_UP_MS = 20_000;

interface Trial {
  /** 1 means the row was there on the first read. Anything higher has measured a real window. */
  readonly polls: number;
  readonly visibleAfterMs: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? Number.NaN;
}

async function main(): Promise<void> {
  const trialCount = Number(process.argv[2] ?? DEFAULT_TRIALS);
  if (!Number.isInteger(trialCount) || trialCount <= 0) {
    throw new Error(`Trial count must be a positive whole number, and this one was ${process.argv[2]}.`);
  }

  const { dbConfig, mcpConfig, database, db, embedder, client } = openLiveChannels(process.env);

  const trials: Trial[] = [];
  let neverVisible = 0;

  try {
    console.log(`\n  application channel: ${db.describe()}`);
    console.log(`  verification channel: ${mcpConfig.url} database=${database}`);
    console.log(`  workspace: ${WORKSPACE}`);
    console.log(`  trials: ${trialCount}\n`);

    const capabilities = await probeCapabilities(db, { schema: dbConfig.schema, embedder });
    const repository = createRepository({ db, embedder, schema: dbConfig.schema, capabilities });
    const embedding = await embedder.embed('freshness measurement row');

    for (let trial = 1; trial <= trialCount; trial += 1) {
      const written = await repository.remember({
        workspaceId: WORKSPACE,
        kind: 'observation',
        content: `Freshness trial ${trial}: written over pg, looked for over MCP, then deleted.`,
        provenance: { assertedBy: 'system:freshness-measurement', incidentId: null, sourceRef: null },
        embedding,
      });

      // The clock starts when the write has COMMITTED, which is the moment the application would
      // start believing it holds the row.
      const wroteAt = Date.now();
      const sql = buildVerificationQuery(dbConfig.schema, WORKSPACE, written.id);

      let polls = 0;
      let visibleAfterMs = Number.NaN;
      while (Date.now() - wroteAt < GIVE_UP_MS) {
        polls += 1;
        // The query the verifier itself sends, not a cheaper stand-in: a measurement of a
        // different read is a measurement of a different thing.
        const result = await client.select({ database, sql, limit: 2 });
        if (result.rows.length > 0) {
          visibleAfterMs = Date.now() - wroteAt;
          break;
        }
      }

      if (Number.isNaN(visibleAfterMs)) {
        neverVisible += 1;
        console.log(`  trial ${String(trial).padStart(3)}  NOT VISIBLE within ${GIVE_UP_MS} ms after ${polls} reads`);
        continue;
      }

      trials.push({ polls, visibleAfterMs });
      console.log(
        `  trial ${String(trial).padStart(3)}  visible after ${String(visibleAfterMs).padStart(5)} ms  ` +
          `(${polls} read${polls === 1 ? '' : 's'})`,
      );
    }

    const missedOnFirstRead = trials.filter((trial) => trial.polls > 1);
    const latencies = trials.map((trial) => trial.visibleAfterMs).sort((a, b) => a - b);

    console.log('\n  ---');
    console.log(`  trials:                       ${trialCount}`);
    console.log(`  never visible at all:         ${neverVisible}`);
    console.log(`  MISSED ON THE FIRST READ:     ${missedOnFirstRead.length}`);
    console.log(`  fastest read that found it:   ${latencies[0] ?? Number.NaN} ms`);
    console.log(`  median:                       ${percentile(latencies, 0.5)} ms`);
    console.log(`  WORST CASE:                   ${latencies[latencies.length - 1] ?? Number.NaN} ms`);

    if (missedOnFirstRead.length === 0 && neverVisible === 0) {
      console.log(
        '\n  Every trial found the row on the FIRST read attempted after the write, and THAT is the\n' +
          '  result to quote: no read arriving after a completed write failed to find the row.\n' +
          '\n' +
          '  Do not turn it into "the invisible window is under X ms". Each trial bounds the window\n' +
          '  by its own read time, so the fastest read is a bound resting on ONE observation rather\n' +
          '  than on all of them, and reading it as a bound on the NEXT write assumes the window\n' +
          '  does not vary. An instrument that looks through this channel cannot observe faster than\n' +
          '  the channel either, so no run of this can measure the window at all.\n',
      );
    } else {
      console.log(
        `\n  ${missedOnFirstRead.length + neverVisible} trial(s) did NOT find the row immediately. A real\n` +
          '  window exists and the verifier must not call an absent row a finding without accounting\n' +
          '  for it. This is the result that changes the code.\n',
      );
      process.exitCode = 1;
    }
  } finally {
    await deleteWorkspaceRows(db, {
      schema: dbConfig.schema,
      workspaceId: WORKSPACE,
      secrets: secretsOf(dbConfig),
    });
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `\n[measure-freshness] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
