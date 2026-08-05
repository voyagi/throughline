import type { Database } from '@throughline/memory';
import { quoteIdentifier } from '@throughline/memory';

/**
 * The hard daily ceiling on agent turns, counted IN THE DATABASE.
 *
 * In the database rather than in the process, and that is the whole point of this file. The rate
 * limiter next door lives in memory and forgets everything on a cold start; a public demo running
 * on Lambda gets cold starts on purpose. A counter that resets whenever the platform feels like
 * scaling is not a budget, it is a suggestion. This one is a row.
 *
 * CHECKED BEFORE THE MODEL CALL, NEVER AFTER. Checking afterwards spends the money and then reports
 * that it should not have, which is an audit trail rather than a ceiling.
 *
 * Two statements rather than one `ON CONFLICT ... DO UPDATE ... WHERE`. The single-statement form
 * works and is tidier, and it was rejected anyway: the two here are the most ordinary SQL there is,
 * so the behaviour does not rest on how one engine resolves the conflict target inside its own
 * update clause. The atomicity that matters lives in the UPDATE, which reads and writes `calls` in
 * one row-locked statement, so two concurrent turns cannot both pass the ceiling on the last
 * available call. Nothing is spent between them, so no transaction is needed: an INSERT whose
 * UPDATE never happens leaves a row reading zero, which is exactly what a day with no calls looks
 * like.
 */

export interface BudgetDecision {
  readonly allowed: boolean;
  /**
   * Calls used today INCLUDING this one, or null when the claim was refused.
   *
   * Null rather than a number on refusal, because a refusal establishes only that the count is at
   * or above the ceiling. Reporting the ceiling there would be a measurement nobody took.
   */
  readonly used: number | null;
  readonly limit: number;
  /** The UTC day this decision was made against, so a log can be read a month later. */
  readonly day: string;
}

export interface DemoBudget {
  /** Take one call off today's budget, or refuse. Never throws for being over. */
  claim(): Promise<BudgetDecision>;
}

export interface DemoBudgetOptions {
  readonly database: Database;
  readonly schema: string;
  /** From `DEMO_MAX_AGENT_CALLS_PER_DAY`. Zero closes the agent, and that is a supported setting. */
  readonly limit: number;
  /** Injected so a test can cross midnight without waiting for one. */
  readonly now: () => Date;
}

/**
 * The UTC calendar day.
 *
 * Computed here and passed as a parameter rather than left to the database's `current_date`. The
 * cluster's idea of today depends on its session time zone, which is a setting somebody can change
 * without touching this repository, and a budget that silently rolls over at a different hour than
 * the operator believes is a bug that only shows up on the bill.
 */
export function utcDayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function createDemoBudget(options: DemoBudgetOptions): DemoBudget {
  const { database, schema, limit, now } = options;
  const table = `${quoteIdentifier(schema)}.${quoteIdentifier('demo_budget')}`;

  return {
    async claim(): Promise<BudgetDecision> {
      const day = utcDayOf(now());

      // Make sure today's row exists. Zero, not one: the increment below is the only thing that
      // ever spends a call, so the ceiling is enforced in exactly one place. Starting at one here
      // would hand out a free call on the first request of the day even with the limit set to zero.
      await database.query(`INSERT INTO ${table} (day, calls) VALUES ($1, 0) ON CONFLICT (day) DO NOTHING`, [day]);

      const rows = await database.query<{ calls: string | number }>(
        `UPDATE ${table} SET calls = calls + 1 WHERE day = $1 AND calls < $2 RETURNING calls`,
        [day, limit],
      );

      const row = rows[0];
      if (!row) return { allowed: false, used: null, limit, day };
      return { allowed: true, used: Number(row.calls), limit, day };
    },
  };
}
