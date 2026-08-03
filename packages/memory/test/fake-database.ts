import type { Database } from '../src/db.ts';
import type { PoolClient, QueryResultRow } from 'pg';

/**
 * An in-memory stand-in for `Database`.
 *
 * Lives in a NON-test file because more than one test file imports it, and a fixture exported from
 * a `*.test.ts` breaks lint rules that forbid exports from test files.
 *
 * It exists so the migration runner and the capability probes can be tested at all. Those were the
 * parts with no coverage: the headline fix of the previous commit, the `storing = false AND
 * implicit = false` filter that stops a stored primary-index column being read as a vector index,
 * could have been reverted with the whole suite still green.
 */

export interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Return rows for a query, or throw to simulate a database error. */
export type Responder = (text: string, values: readonly unknown[]) => unknown[];

export interface FakeDatabase extends Database {
  readonly queries: RecordedQuery[];
  /** Every statement seen so far, whitespace collapsed, for readable assertions. */
  texts(): string[];
}

export function createFakeDatabase(respond: Responder): FakeDatabase {
  const queries: RecordedQuery[] = [];

  return {
    queries,
    texts(): string[] {
      return queries.map((query) => query.text.replace(/\s+/g, ' ').trim());
    },
    query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<Row[]> {
      queries.push({ text, values });
      try {
        return Promise.resolve(respond(text, values) as Row[]);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    transaction<Result>(work: (client: PoolClient) => Promise<Result>): Promise<Result> {
      return work({} as PoolClient);
    },
    describe(): string {
      return 'fake:0/testdb schema=throughline';
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** Match a statement regardless of how it is wrapped or indented. */
export function mentions(text: string, ...fragments: string[]): boolean {
  const flat = text.replace(/\s+/g, ' ').toLowerCase();
  return fragments.every((fragment) => flat.includes(fragment.toLowerCase()));
}
