import { redact } from './config.ts';
import { quoteIdentifier, type Database } from './db.ts';

/**
 * Remove a throwaway workspace's rows at the end of a live proof, and SAY SO when that fails.
 *
 * Both live proofs used to end with `.catch(() => undefined)` on each DELETE. That keeps the
 * promise they make, that a failed check must not hide behind a failed cleanup, and pays for it
 * with the one sentence nobody wants to be missing: a DELETE that did not run leaves rows in a
 * live, billed cluster while the script prints ALL CHECKS PASSED. The rows are not the worst of
 * it. The next run of the same proof reads a workspace it believes it created empty.
 *
 * So the swallow stays and the silence goes. A failure never fails the run, it is reported, and
 * the outcome comes back as a value so a caller can decide for itself.
 *
 * ONE more thing has to be true before that warning is safe to print: `pg` puts the connection
 * string into some of its failure messages, and a connection string holds a password. `secrets` is
 * required rather than optional for exactly that reason: you cannot ask this function to speak
 * without telling it what it may not repeat.
 */

/**
 * The tables a workspace's rows live in, in the order they are removed.
 *
 * Shared rather than passed in by each caller, so two live proofs cannot end up cleaning different
 * halves of the same workspace. Audit rows go first: they are the dependent record, and a run that
 * dies between the two deletes leaves the parent row, which is the half a human can find.
 */
export const WORKSPACE_TABLES = ['memory_audit', 'memory'] as const;

export interface CleanupOutcome {
  readonly table: string;
  readonly failed: boolean;
  /** The redacted reason, when it failed. Null when it did not. */
  readonly reason: string | null;
}

export interface CleanupRequest {
  readonly schema: string;
  readonly workspaceId: string;
  /** Every secret that must not appear in a warning. Pass `secretsOf(config)`. */
  readonly secrets: readonly (string | undefined)[];
  readonly tables?: readonly string[];
  /** Injected in tests. Defaults to `console.warn`, which is where an operator will see it. */
  readonly warn?: (message: string) => void;
}

/**
 * Delete every row a workspace owns. This never throws, and a failure is never silent.
 *
 * Each table is attempted even when an earlier one failed: stopping at the first failure would
 * leave more behind than it had to, and the caller learns about both either way.
 *
 * "Never throws" is load bearing rather than tidy, and the first version of this function did not
 * manage it. Every caller runs it inside a `finally`, so anything thrown here replaces whatever
 * the run was already failing with AND skips the `await db.close()` on the next line: the pool
 * stays open and the script hangs instead of exiting. A failing DELETE could never do that. A
 * `warn` callback that throws could, and `warn` is public on `CleanupRequest`.
 *
 * So the reporter is called defensively. That is not the silence this function exists to end: the
 * outcome for every table is returned as a value regardless, carrying `failed` and the redacted
 * reason. A reporter that cannot report is a broken reporter, not a finding about the database,
 * and it must not be able to take the run down with it.
 */
export async function deleteWorkspaceRows(
  db: Pick<Database, 'query'>,
  request: CleanupRequest,
): Promise<CleanupOutcome[]> {
  const warn =
    request.warn ??
    ((message: string): void => {
      console.warn(message);
    });
  const outcomes: CleanupOutcome[] = [];

  for (const table of request.tables ?? WORKSPACE_TABLES) {
    try {
      await db.query(
        `DELETE FROM ${quoteIdentifier(request.schema)}.${quoteIdentifier(table)} ` +
          `WHERE workspace_id = $1`,
        [request.workspaceId],
      );
      outcomes.push({ table, failed: false, reason: null });
    } catch (error) {
      const reason = redact(
        error instanceof Error ? error.message : String(error),
        request.secrets,
      );
      outcomes.push({ table, failed: true, reason });
      try {
        warn(
          `[cleanup] could not remove workspace ${request.workspaceId} from ` +
            `${request.schema}.${table}: ${reason}. Those rows are still in the cluster. This does ` +
            'not fail the run, and it is not a finding about anything the run checked.',
        );
      } catch {
        // The outcome above already carries this failure, so nothing is lost here that a caller
        // cannot read. What would be lost by letting this escape is the rest of the cleanup and
        // the `db.close()` that every caller runs on the next line.
      }
    }
  }

  return outcomes;
}
