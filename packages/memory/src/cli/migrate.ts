import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDatabaseConfig } from '../config.ts';
import { createDatabase } from '../db.ts';
import { loadMigrations, runMigrations } from '../migrate.ts';

/**
 * Apply every pending migration, then say exactly what was done.
 *
 * Prints the target as host, port, database and schema. Never the connection string: it carries a
 * password, and a migration log is one of the most-pasted artifacts there is.
 */
async function main(): Promise<void> {
  const config = loadDatabaseConfig(process.env);
  const db = createDatabase(config);
  const migrationsDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'migrations',
  );

  try {
    console.log(`[migrate] target: ${db.describe()}`);
    const migrations = await loadMigrations(migrationsDirectory);
    if (migrations.length === 0) {
      // Zero migrations found is a broken path, not a clean database. Reported as a failure so it
      // cannot read as "nothing to do".
      throw new Error(`No migration files found in ${migrationsDirectory}`);
    }
    console.log(`[migrate] ${migrations.length} migration file(s) found`);

    const report = await runMigrations(db, config.schema, migrations);
    for (const outcome of report.outcomes) {
      const detail =
        outcome.status === 'applied'
          ? `applied (${outcome.statements} statements)`
          : 'already applied';
      console.log(`[migrate]   ${outcome.version}: ${detail}`);
    }

    const appliedCount = report.outcomes.filter((o) => o.status === 'applied').length;
    console.log(
      appliedCount === 0
        ? '[migrate] database already up to date'
        : `[migrate] ${appliedCount} migration(s) applied to schema "${report.schema}"`,
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[migrate] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
