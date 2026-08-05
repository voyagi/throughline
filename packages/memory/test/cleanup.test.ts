import { describe, expect, it } from 'vitest';
import { deleteWorkspaceRows, WORKSPACE_TABLES } from '../src/cleanup.ts';
import { createFakeDatabase, mentions } from './fake-database.ts';

/**
 * The cleanup at the end of a live proof, and the thing it must never do again: fail quietly.
 *
 * Both live proofs ended each DELETE with `.catch(() => undefined)`. That is the right shape for
 * "a cleanup failure must not fail the checks" and the wrong shape for everything else: a DELETE
 * that did not run leaves rows in a live, billed cluster while the script prints ALL CHECKS
 * PASSED, and the next run of the same proof then reads a workspace it believes it created empty.
 */

const WORKSPACE = 'verify-live-12345';
const SECRET = 'postgresql://root:hunter2-not-a-real-password@host.cockroachlabs.cloud:26257/defaultdb';

describe('deleteWorkspaceRows', () => {
  it('deletes each table for the workspace, passing the id as a parameter', async () => {
    const db = createFakeDatabase(() => []);
    const outcomes = await deleteWorkspaceRows(db, {
      schema: 'throughline',
      workspaceId: WORKSPACE,
      secrets: [],
    });

    expect(outcomes.map((outcome) => outcome.table)).toEqual([...WORKSPACE_TABLES]);
    expect(outcomes.every((outcome) => !outcome.failed)).toBe(true);
    expect(db.queries).toHaveLength(WORKSPACE_TABLES.length);
    for (const query of db.queries) {
      // The workspace id travels as a value, never interpolated into the statement.
      expect(query.values).toEqual([WORKSPACE]);
      expect(query.text).not.toContain(WORKSPACE);
      expect(mentions(query.text, 'delete from', '"throughline"', 'where workspace_id = $1')).toBe(
        true,
      );
    }
  });

  it('reports a failed delete instead of swallowing it, and still does not throw', async () => {
    // The whole point. `.catch(() => undefined)` and this function differ in exactly one place:
    // whether anybody ever finds out.
    const warnings: string[] = [];
    const db = createFakeDatabase((text) => {
      if (text.includes('memory_audit')) throw new Error('permission denied for table memory_audit');
      return [];
    });

    const outcomes = await deleteWorkspaceRows(db, {
      schema: 'throughline',
      workspaceId: WORKSPACE,
      secrets: [],
      warn: (message) => warnings.push(message),
    });

    expect(outcomes[0]).toEqual({
      table: 'memory_audit',
      failed: true,
      reason: 'permission denied for table memory_audit',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('memory_audit');
    expect(warnings[0]).toContain(WORKSPACE);
    expect(warnings[0]).toContain('still in the cluster');
    // And it says what it is NOT, because this text lands in the middle of a run whose other
    // output is findings about a database.
    expect(warnings[0]).toContain('not a finding');
  });

  it('attempts every table even after an earlier one fails', async () => {
    // Stopping at the first failure would leave behind rows it could have removed, and the caller
    // would learn about one problem where there were two.
    const db = createFakeDatabase((text) => {
      if (text.includes('memory_audit')) throw new Error('nope');
      return [];
    });

    const outcomes = await deleteWorkspaceRows(db, {
      schema: 'throughline',
      workspaceId: WORKSPACE,
      secrets: [],
      warn: () => undefined,
    });

    expect(outcomes.map((outcome) => outcome.failed)).toEqual([true, false]);
    expect(db.queries).toHaveLength(2);
  });

  it('redacts the connection string out of a driver failure before printing it', async () => {
    // `pg` puts the connection string into some of its failure messages and a connection string
    // holds a password. Adding a warning without this turns a silent cleanup into a credential in
    // a terminal, which is a worse bug than the one being fixed.
    const warnings: string[] = [];
    const db = createFakeDatabase(() => {
      throw new Error(`connection terminated: ${SECRET}`);
    });

    const outcomes = await deleteWorkspaceRows(db, {
      schema: 'throughline',
      workspaceId: WORKSPACE,
      secrets: [SECRET, 'hunter2-not-a-real-password'],
      warn: (message) => warnings.push(message),
    });

    for (const text of [...warnings, ...outcomes.map((outcome) => outcome.reason ?? '')]) {
      expect(text).not.toContain('hunter2-not-a-real-password');
      expect(text).not.toContain(SECRET);
      expect(text).toContain('[redacted]');
    }
  });

  it('names the tables in the order a half-finished run should leave behind', async () => {
    // Audit rows first: they are the dependent record, so a run that dies between the two deletes
    // leaves the parent row, which is the half a human can find by looking for the workspace.
    expect([...WORKSPACE_TABLES]).toEqual(['memory_audit', 'memory']);
  });

  it('quotes a schema name into the statement rather than trusting it', async () => {
    const db = createFakeDatabase(() => []);
    await deleteWorkspaceRows(db, {
      schema: 'weird"schema',
      workspaceId: WORKSPACE,
      secrets: [],
    });
    expect(db.queries[0]?.text).toContain('"weird""schema"');
  });
});
