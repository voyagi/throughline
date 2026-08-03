import pg from 'pg';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { describeTarget, redact, secretsOf, type DatabaseConfig } from './config.ts';

/**
 * The connection layer.
 *
 * Two things it is careful about. Every connection is pinned to the Throughline schema and given a
 * statement timeout the moment it is handed out, so no caller has to remember either. And every
 * error that leaves this file has been through `redact`, message, stack and cause alike.
 *
 * On that second point, an earlier version of this comment asserted that `pg` puts the connection
 * string into some failure messages. That was written from memory and it is NOT true of pg 8.22:
 * `pg-connection-string` overwrites `err.input` with a redaction marker of its own. The redaction
 * here stays anyway, as defence in depth against a driver upgrade, a different driver, or an error
 * raised by something other than pg. It is a belt, and the fact that the braces currently hold is
 * not a reason to remove it. Recording the correction rather than quietly deleting the claim,
 * because the next reader deserves to know which parts were measured.
 */

const { Pool: PgPool } = pg;

export interface Database {
  /** Run a query. The generic is the ROW shape, not the result wrapper. */
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row[]>;
  /** Run a function inside a transaction, rolling back on any throw. */
  transaction<Result>(work: (client: PoolClient) => Promise<Result>): Promise<Result>;
  /** Host, port, database and schema. Safe to print. */
  describe(): string;
  close(): Promise<void>;
}

export class DatabaseError extends Error {
  override readonly name = 'DatabaseError';
  /** The driver's own code, when it had one. `undefined` means the failure was not a SQL error. */
  readonly code: string | undefined;

  constructor(message: string, code: string | undefined, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export function createDatabase(config: DatabaseConfig): Database {
  const secrets = secretsOf(config);
  const pool: Pool = new PgPool({
    connectionString: config.connectionString,
    application_name: config.applicationName,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    // Session setup as STARTUP options rather than as a query after connecting.
    //
    // The obvious alternative, a `pool.on('connect')` handler issuing `SET`, was measured emitting
    // pg's "client is already executing a query" deprecation warning, because the pool hands the
    // client to a waiting caller without awaiting anything the handler started. Ordering happens to
    // survive today via the client's internal queue, and pg 9 removes that behaviour. Startup
    // options are applied by the server before the connection is usable at all, so there is no
    // window and nothing to order. Verified against the live cluster: SHOW search_path returns
    // "throughline, public" and an unqualified SELECT resolves into the schema.
    //
    // The schema name is interpolated into a space-separated option string, which is the second and
    // last place in this codebase where a value reaches SQL-adjacent text unparameterised. It is
    // validated against a bare-identifier pattern before it gets here, so it cannot contain the
    // space or dash that would be needed to inject another `-c`.
    options: `-c search_path=${config.schema},public -c statement_timeout=${Math.trunc(config.statementTimeoutMs)}`,
    // Long enough that a warm Lambda keeps its connection between invocations, short enough that
    // an idle container is not holding a cluster connection all afternoon.
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  });

  // An idle client can be killed by the cluster, a proxy, or a laptop sleeping. Without this
  // listener `pg` emits an unhandled 'error' event and Node terminates the process.
  pool.on('error', (error) => {
    console.error(`[db] idle client error: ${describeError(error, secrets)}`);
  });

  return {
    async query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<Row[]> {
      try {
        const result = await pool.query<Row>(text, values as unknown[]);
        return result.rows;
      } catch (error) {
        throw toDatabaseError(error, secrets);
      }
    },

    async transaction<Result>(work: (client: PoolClient) => Promise<Result>): Promise<Result> {
      const client = await pool.connect().catch((error: unknown) => {
        throw toDatabaseError(error, secrets);
      });
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // A rollback can itself fail, typically because the connection is already gone. Losing the
        // original error to a secondary failure would hide the actual cause, so the rollback's own
        // failure is reported and discarded.
        await client.query('ROLLBACK').catch((rollbackError: unknown) => {
          console.error(`[db] rollback failed: ${describeError(rollbackError, secrets)}`);
        });
        throw toDatabaseError(error, secrets);
      } finally {
        client.release();
      }
    },

    describe(): string {
      return describeTarget(config);
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Quote a SQL identifier by doubling any embedded quote.
 *
 * The schema name is already validated against a bare-identifier pattern before it reaches here,
 * so this is the second layer rather than the only one. It exists because `search_path` cannot
 * take a bind parameter, which makes this the one place in the codebase where a value is
 * interpolated into SQL text.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Wrap a driver failure as a `DatabaseError` whose message AND cause are both redacted.
 *
 * Exported so a test can pin the WIRING, not just the helper. Testing `sanitizeError` alone proved
 * the redaction works and proved nothing about whether this function calls it: reverting the call
 * here left the whole suite green, which is the same blind spot in a new place.
 */
export function toDatabaseError(error: unknown, secrets: readonly string[]): DatabaseError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined;
  // The cause is SANITISED, not the original.
  //
  // Attaching the raw error here cancelled the redaction entirely, and did so precisely where it
  // mattered: if the driver's message carried no secret there was nothing to redact, and if it did,
  // the cause kept it verbatim. `console.error(err)`, `util.inspect`, and Node's own uncaught
  // exception handler all walk the cause chain and print it.
  return new DatabaseError(describeError(error, secrets), code, {
    cause: sanitizeError(error, secrets),
  });
}

function describeError(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redact(raw, secrets);
}

/** Diagnostic fields `pg` sets that are worth keeping. `constraint` in particular: the repository
 * layer maps a CHECK violation to a domain error by NAME, and CockroachDB puts the name here while
 * the message carries only the expression. */
const CARRIED_FIELDS = ['code', 'detail', 'hint', 'constraint', 'table', 'column', 'routine'] as const;

/**
 * Rebuild an error with every string it carries put through `redact`.
 *
 * A copy rather than a mutation, because mutating the driver's error object would edit something
 * the caller may also hold, and because a frozen error would silently refuse the write.
 *
 * The stack is redacted too: a connection string can appear in a stack frame's source text, and a
 * stack is printed by exactly the same code paths as a message.
 */
export function sanitizeError(
  error: unknown,
  secrets: readonly string[],
  depth = 0,
): Error | undefined {
  if (depth > 4) return undefined; // A cause chain long enough to matter is already a bug.
  if (error === undefined || error === null) return undefined;
  if (!(error instanceof Error)) return new Error(redact(String(error), secrets));

  const clean = new Error(redact(error.message, secrets));
  clean.name = error.name;
  if (typeof error.stack === 'string') clean.stack = redact(error.stack, secrets);

  const source = error as unknown as Record<string, unknown>;
  const target = clean as unknown as Record<string, unknown>;
  for (const field of CARRIED_FIELDS) {
    const value = source[field];
    if (typeof value === 'string') target[field] = redact(value, secrets);
  }

  const nested = sanitizeError(source['cause'], secrets, depth + 1);
  if (nested) target['cause'] = nested;

  return clean;
}
