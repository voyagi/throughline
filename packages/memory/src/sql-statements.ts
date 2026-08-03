/**
 * Split a SQL file into individual statements.
 *
 * Migrations are executed one statement at a time rather than as one multi-statement query,
 * because a multi-statement query runs as a single implicit transaction and CockroachDB restricts
 * what a transaction containing schema changes may also do. One statement at a time removes that
 * whole class of problem, and it means a failure names the exact statement instead of the file.
 *
 * A naive split on ';' is wrong the moment a migration contains a semicolon inside a string
 * literal, a quoted identifier or a comment. None do today, which is exactly why this is worth
 * writing now: the migration that breaks a naive splitter is the one nobody is looking at.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      index = skipLineComment(sql, index);
      continue;
    }
    if (char === '/' && next === '*') {
      index = skipBlockComment(sql, index);
      continue;
    }
    if (char === "'" || char === '"') {
      const end = skipQuoted(sql, index, char);
      current += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

function skipLineComment(sql: string, start: number): number {
  const newline = sql.indexOf('\n', start);
  return newline === -1 ? sql.length : newline + 1;
}

function skipBlockComment(sql: string, start: number): number {
  const close = sql.indexOf('*/', start + 2);
  // An unterminated block comment swallows the rest of the file. That is the same thing the
  // database would do, so matching it keeps the split honest rather than inventing a statement
  // boundary the server would not see.
  return close === -1 ? sql.length : close + 2;
}

/**
 * Return the index just past a quoted run starting at `start`.
 *
 * SQL escapes a quote by doubling it, so `''` inside a string is a literal quote and not a
 * terminator. Treating it as a terminator is the specific bug that makes a splitter cut a
 * statement in half.
 */
function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  // Unterminated. Return the end rather than throwing: the server is the authority on malformed
  // SQL, and it gives a better error than this function could.
  return sql.length;
}
