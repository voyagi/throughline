import { z } from 'zod';

/**
 * Database configuration, parsed from the environment.
 *
 * `loadDatabaseConfig` takes an environment record rather than reading `process.env` itself, so
 * every branch in here is testable without mutating global state.
 *
 * One rule runs through this file: a connection string holds a password, so it must never reach a
 * log, an error message, or a thrown stack. `redact` exists for that and is used at every boundary
 * that formats text a human will read.
 */

export interface DatabaseConfig {
  readonly connectionString: string;
  /**
   * The SQL schema holding every Throughline table.
   *
   * A dedicated SCHEMA rather than a dedicated DATABASE, deliberately. A CockroachDB Cloud cluster
   * arrives with `defaultdb` and the connection string points at it, so requiring a separate
   * database would mean every operator has to edit a credential before anything runs. A schema
   * gives the same namespacing, works identically whether the URL points at `defaultdb` or at a
   * database somebody made on purpose, and costs one `search_path`.
   */
  readonly schema: string;
  /** Shows up in `SHOW SESSIONS` on the cluster, which is what makes a stray connection traceable. */
  readonly applicationName: string;
  /**
   * A hard ceiling on any single statement.
   *
   * Present because recall runs on a public demo: without it, one pathological query holds a
   * connection until the pool starves, and the failure surfaces somewhere unrelated.
   */
  readonly statementTimeoutMs: number;
  /** Small on purpose. Lambda reuses one execution environment; it does not need a wide pool. */
  readonly maxConnections: number;
  readonly connectionTimeoutMs: number;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

const configSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is empty')
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// URL',
    ),
  THROUGHLINE_SCHEMA: z
    .string()
    .regex(SCHEMA_NAME, 'must be a bare lowercase SQL identifier')
    .default('throughline'),
  THROUGHLINE_APP_NAME: z.string().min(1).default('throughline'),
  THROUGHLINE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  THROUGHLINE_MAX_CONNECTIONS: z.coerce.number().int().positive().max(20).default(4),
  THROUGHLINE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadDatabaseConfig(env: Record<string, string | undefined>): DatabaseConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    // Only the field NAMES and the rule that failed. Never the values: the first field here is a
    // credential, and a validation error that echoes its input is the classic way a password ends
    // up in a CI log.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(
      `Database configuration is not usable: ${problems}. ` +
        'Copy .env.example to .env and fill it in. No value is shown here on purpose.',
    );
  }

  const values = parsed.data;
  return {
    connectionString: values.DATABASE_URL,
    schema: values.THROUGHLINE_SCHEMA,
    applicationName: values.THROUGHLINE_APP_NAME,
    statementTimeoutMs: values.THROUGHLINE_STATEMENT_TIMEOUT_MS,
    maxConnections: values.THROUGHLINE_MAX_CONNECTIONS,
    connectionTimeoutMs: values.THROUGHLINE_CONNECT_TIMEOUT_MS,
  };
}

/**
 * Replace every occurrence of each secret with a marker.
 *
 * Used on anything derived from a driver error before it is printed. `pg` puts the connection
 * string into some failure messages, and a stack trace is text like any other.
 *
 * Short secrets are ignored rather than replaced: blanking a two character value would corrupt
 * unrelated text for no security benefit, and an empty or missing secret must not turn the whole
 * message into markers.
 */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    output = output.split(secret).join('[redacted]');
  }
  return output;
}

/**
 * Every secret-bearing string derived from a config, for handing to `redact`.
 *
 * Includes the password on its own as well as the whole URL, because a driver can report just the
 * password, or a URL it has re-encoded so that a whole-string match misses.
 */
export function secretsOf(config: DatabaseConfig): string[] {
  const secrets: string[] = [config.connectionString];
  try {
    const url = new URL(config.connectionString);
    if (url.password) {
      secrets.push(url.password, decodeURIComponent(url.password));
    }
  } catch {
    // An unparseable URL still gets redacted as a whole string above. Nothing to add and nothing
    // worth failing over here.
  }
  return secrets;
}

/**
 * A description of the connection target that is safe to print.
 *
 * Host, port and database name only. This exists because "which cluster am I actually talking to"
 * is the first question during an incident, and the usual way to answer it is to log the URL.
 */
export function describeTarget(config: DatabaseConfig): string {
  try {
    const url = new URL(config.connectionString);
    const database = url.pathname.replace(/^\//, '') || '(default)';
    return `${url.hostname}:${url.port || '26257'}/${database} schema=${config.schema}`;
  } catch {
    return `(unparseable connection string) schema=${config.schema}`;
  }
}
