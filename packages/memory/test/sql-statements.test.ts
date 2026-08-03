import { describe, expect, it } from 'vitest';
import { splitStatements } from '../src/sql-statements.ts';

describe('splitStatements', () => {
  it('splits on statement terminators and drops the empties', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('tolerates a missing trailing semicolon', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('returns nothing for whitespace and comments alone', () => {
    expect(splitStatements('   \n\n  -- just a note\n')).toEqual([]);
    expect(splitStatements('/* nothing here */')).toEqual([]);
  });

  it('does not split on a semicolon inside a string literal', () => {
    // The specific bug a naive splitter has: this would become two invalid statements.
    const sql = "INSERT INTO t VALUES ('a;b'); SELECT 1;";
    expect(splitStatements(sql)).toEqual(["INSERT INTO t VALUES ('a;b')", 'SELECT 1']);
  });

  it('handles a doubled quote inside a string', () => {
    // SQL escapes a quote by doubling it, so '' is a literal quote and not a terminator. Treating
    // it as one cuts the statement in half at the next semicolon.
    const sql = "SELECT 'it''s; fine' AS v; SELECT 2";
    expect(splitStatements(sql)).toEqual(["SELECT 'it''s; fine' AS v", 'SELECT 2']);
  });

  it('does not split on a semicolon inside a quoted identifier', () => {
    const sql = 'SELECT "weird;name" FROM t; SELECT 2';
    expect(splitStatements(sql)).toEqual(['SELECT "weird;name" FROM t', 'SELECT 2']);
  });

  it('does not split on a semicolon inside a line comment', () => {
    const sql = 'SELECT 1; -- a note; with a semicolon\nSELECT 2;';
    expect(splitStatements(sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('does not split on a semicolon inside a block comment', () => {
    const sql = 'SELECT 1; /* a note; with a semicolon */ SELECT 2;';
    expect(splitStatements(sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('strips comments from the statements it returns', () => {
    const statements = splitStatements('-- leading\nSELECT 1; /* inline */ SELECT 2');
    expect(statements[0]).toBe('SELECT 1');
    expect(statements[1]).toBe('SELECT 2');
  });

  it('lets an unterminated block comment swallow the rest, as the server would', () => {
    // Matching the database's own behaviour rather than inventing a boundary it would not see.
    expect(splitStatements('SELECT 1; /* never closed SELECT 2;')).toEqual(['SELECT 1']);
  });

  it('lets an unterminated string run to the end rather than throwing', () => {
    // The server gives a better error for malformed SQL than this function could.
    expect(splitStatements("SELECT 'unterminated; SELECT 2")).toEqual([
      "SELECT 'unterminated; SELECT 2",
    ]);
  });

  it('splits the real migration shape: a comment header then guarded DDL', () => {
    const sql = [
      '-- 00X: a migration',
      '--',
      '-- Explaining something; with punctuation.',
      '',
      'CREATE TABLE IF NOT EXISTS t (',
      "    kind STRING NOT NULL CHECK (kind IN ('a', 'b'))",
      ');',
      '',
      'CREATE INDEX IF NOT EXISTS t_kind ON t (kind);',
    ].join('\n');

    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS t');
    expect(statements[0]).toContain("kind IN ('a', 'b')");
    expect(statements[1]).toContain('CREATE INDEX IF NOT EXISTS t_kind');
  });
});
