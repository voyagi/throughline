import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from './db.ts';
import { quoteIdentifier } from './db.ts';
import { splitStatements } from './sql-statements.ts';

/**
 * The migration runner.
 *
 * Two deliberate properties.
 *
 * Statements run one at a time, outside any explicit transaction, because CockroachDB restricts
 * what a transaction containing schema changes may also do. The cost is that an interrupted
 * migration leaves its version unrecorded, so every migration file must be idempotent and gets
 * re-run on the next attempt. That is written into the migration files as a requirement rather
 * than left as folklore.
 *
 * A file whose contents changed after it was applied is an ERROR, never a warning. Silent drift
 * between what a database contains and what the repository claims it contains is the thing this
 * check exists to prevent, and a warning nobody reads is the same as no check.
 */

export interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

export type MigrationStatus = 'applied' | 'already-applied';

export interface MigrationOutcome {
  readonly version: string;
  readonly status: MigrationStatus;
  readonly statements: number;
}

export interface MigrationReport {
  readonly schema: string;
  readonly outcomes: readonly MigrationOutcome[];
}

export class MigrationDriftError extends Error {
  override readonly name = 'MigrationDriftError';
}

export function checksumOf(sql: string): string {
  // Line endings are normalised first. Without it the same file checksums differently after a
  // Windows checkout, and every migration reports drift on a machine that did nothing wrong.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory);
  const files = entries.filter((entry) => entry.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(directory, file), 'utf8');
    migrations.push({ version: file.replace(/\.sql$/, ''), sql, checksum: checksumOf(sql) });
  }
  return migrations;
}

export async function runMigrations(
  db: Database,
  schema: string,
  migrations: readonly Migration[],
): Promise<MigrationReport> {
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(schema)}.schema_migrations (
       version     STRING       PRIMARY KEY,
       checksum    STRING       NOT NULL,
       applied_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
     )`,
  );

  const applied = await db.query<{ version: string; checksum: string }>(
    `SELECT version, checksum FROM ${quoteIdentifier(schema)}.schema_migrations`,
  );
  const appliedByVersion = new Map(applied.map((row) => [row.version, row.checksum]));

  const outcomes: MigrationOutcome[] = [];
  for (const migration of migrations) {
    const recorded = appliedByVersion.get(migration.version);
    if (recorded !== undefined) {
      if (recorded !== migration.checksum) {
        throw new MigrationDriftError(
          `Migration ${migration.version} was applied with a different checksum ` +
            `(database ${recorded.slice(0, 12)}, working tree ${migration.checksum.slice(0, 12)}). ` +
            'An already-applied migration was edited. Add a new migration instead of changing this ' +
            'one, or reconcile the database by hand and record what you did.',
        );
      }
      outcomes.push({ version: migration.version, status: 'already-applied', statements: 0 });
      continue;
    }

    const statements = splitStatements(migration.sql);
    for (const [position, statement] of statements.entries()) {
      try {
        await db.query(statement);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Migration ${migration.version} failed at statement ${position + 1} of ${statements.length}: ` +
            `${cause}\nThe statement was:\n${statement}`,
          { cause: error },
        );
      }
    }

    await db.query(
      `INSERT INTO ${quoteIdentifier(schema)}.schema_migrations (version, checksum) VALUES ($1, $2)`,
      [migration.version, migration.checksum],
    );
    outcomes.push({ version: migration.version, status: 'applied', statements: statements.length });
  }

  return { schema, outcomes };
}
