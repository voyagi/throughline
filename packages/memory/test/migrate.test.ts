import { describe, expect, it } from 'vitest';
import { checksumOf, MigrationDriftError, runMigrations, type Migration } from '../src/migrate.ts';
import { createFakeDatabase, mentions, type Responder } from './fake-database.ts';

const migration = (version: string, sql: string): Migration => ({
  version,
  sql,
  checksum: checksumOf(sql),
});

/** Respond as a database whose schema_migrations holds exactly `applied`. */
const responderFor = (applied: { version: string; checksum: string }[]): Responder => {
  return (text) => (mentions(text, 'select version, checksum') ? applied : []);
};

describe('checksumOf', () => {
  it('is stable across line-ending styles', () => {
    // Without this, the same file checksums differently after a Windows checkout and every
    // migration reports drift on a machine that did nothing wrong.
    expect(checksumOf('SELECT 1;\nSELECT 2;\n')).toBe(checksumOf('SELECT 1;\r\nSELECT 2;\r\n'));
  });

  it('changes when the SQL actually changes', () => {
    expect(checksumOf('SELECT 1')).not.toBe(checksumOf('SELECT 2'));
  });
});

describe('runMigrations', () => {
  it('applies a pending migration and records it afterwards', async () => {
    const db = createFakeDatabase(responderFor([]));
    const report = await runMigrations(db, 'throughline', [
      migration('001_a', 'CREATE TABLE a (id INT); CREATE INDEX ON a (id);'),
    ]);

    expect(report.outcomes).toEqual([{ version: '001_a', status: 'applied', statements: 2 }]);

    const texts = db.texts();
    const insertIndex = texts.findIndex((text) => mentions(text, 'insert into', 'schema_migrations'));
    const lastStatementIndex = texts.findIndex((text) => mentions(text, 'create index on a'));
    // Ordering is the property that matters: the version row must land AFTER every statement, so an
    // interrupted migration is re-run rather than recorded as done.
    expect(insertIndex).toBeGreaterThan(lastStatementIndex);
  });

  it('skips a migration already recorded with a matching checksum', async () => {
    const sql = 'CREATE TABLE a (id INT);';
    const db = createFakeDatabase(responderFor([{ version: '001_a', checksum: checksumOf(sql) }]));
    const report = await runMigrations(db, 'throughline', [migration('001_a', sql)]);

    expect(report.outcomes).toEqual([{ version: '001_a', status: 'already-applied', statements: 0 }]);
    expect(db.texts().some((text) => mentions(text, 'create table a'))).toBe(false);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const db = createFakeDatabase(responderFor([{ version: '001_a', checksum: 'a-different-sum' }]));
    await expect(
      runMigrations(db, 'throughline', [migration('001_a', 'CREATE TABLE a (id INT);')]),
    ).rejects.toThrow(MigrationDriftError);
  });

  it('refuses when the DATABASE is ahead of the working tree', async () => {
    // The half of drift that used to go unnoticed. Checking out a branch that predates a migration
    // left the runner comparing only files it could see, so it printed "already up to date" against
    // a database carrying columns the code knows nothing about.
    const sql = 'CREATE TABLE a (id INT);';
    const db = createFakeDatabase(
      responderFor([
        { version: '001_a', checksum: checksumOf(sql) },
        { version: '002_b', checksum: 'whatever' },
      ]),
    );

    await expect(runMigrations(db, 'throughline', [migration('001_a', sql)])).rejects.toThrow(
      /database has applied 1 migration\(s\) this working tree does not contain: 002_b/i,
    );
  });

  it('refuses a pending migration that sorts before one already applied', async () => {
    // Two branches adding 004_a and 004_b, or a 002b inserted after 003 shipped. Applying it would
    // run schema changes in an order nobody tested.
    const applied = 'CREATE TABLE b (id INT);';
    const db = createFakeDatabase(
      responderFor([{ version: '003_b', checksum: checksumOf(applied) }]),
    );

    await expect(
      runMigrations(db, 'throughline', [
        migration('002_a', 'CREATE TABLE a (id INT);'),
        migration('003_b', applied),
      ]),
    ).rejects.toThrow(/sort before one already applied \(003_b\): 002_a/i);
  });

  it('allows a new migration that sorts after everything applied', async () => {
    const applied = 'CREATE TABLE a (id INT);';
    const db = createFakeDatabase(
      responderFor([{ version: '001_a', checksum: checksumOf(applied) }]),
    );
    const report = await runMigrations(db, 'throughline', [
      migration('001_a', applied),
      migration('002_b', 'CREATE TABLE b (id INT);'),
    ]);
    expect(report.outcomes.map((outcome) => outcome.status)).toEqual(['already-applied', 'applied']);
  });

  it('names the version, the position and the statement when one fails', async () => {
    const db = createFakeDatabase((text) => {
      if (mentions(text, 'select version, checksum')) return [];
      if (mentions(text, 'create index on a')) throw new Error('relation "a" does not exist');
      return [];
    });

    await expect(
      runMigrations(db, 'throughline', [
        migration('001_a', 'CREATE TABLE a (id INT); CREATE INDEX ON a (id);'),
      ]),
    ).rejects.toThrow(/001_a failed at statement 2 of 2/);
  });

  it('does not record a version when a statement failed', async () => {
    const db = createFakeDatabase((text) => {
      if (mentions(text, 'select version, checksum')) return [];
      if (mentions(text, 'create table a')) throw new Error('boom');
      return [];
    });

    await expect(
      runMigrations(db, 'throughline', [migration('001_a', 'CREATE TABLE a (id INT);')]),
    ).rejects.toThrow(/boom/);

    expect(db.texts().some((text) => mentions(text, 'insert into', 'schema_migrations'))).toBe(false);
  });

  it('quotes the schema everywhere it names it', async () => {
    const db = createFakeDatabase(responderFor([]));
    await runMigrations(db, 'throughline', []);
    const schemaStatements = db.texts().filter((text) => mentions(text, 'schema_migrations'));
    expect(schemaStatements.length).toBeGreaterThan(0);
    for (const statement of schemaStatements) {
      expect(statement).toContain('"throughline"');
    }
  });
});
