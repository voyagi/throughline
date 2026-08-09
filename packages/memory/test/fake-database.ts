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

/**
 * `via` is what makes "and both inside the transaction" an assertable claim.
 *
 * A review proved it was not one. The insert-path test's headline said both statements ran inside
 * `db.transaction`, and moving the audit write back OUTSIDE the transaction - literally the defect
 * that sentence describes - left the file at 40/40 green. Every statement went into one array with
 * no record of which client issued it, so no assertion built on this fixture could tell the two
 * apart. The claim was unmakeable rather than merely unmade.
 */
export interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly via: 'db' | 'tx';
}

/** Return rows for a query, or throw to simulate a database error. */
export type Responder = (text: string, values: readonly unknown[]) => unknown[];

export interface FakeDatabase extends Database {
  readonly queries: RecordedQuery[];
  /** Every statement seen so far, whitespace collapsed, for readable assertions. */
  texts(): string[];
}

/**
 * Refuse a statement whose placeholders and parameters do not agree.
 *
 * A REAL DRIVER WOULD, AND THIS ONE DID NOT, which made an entire class of mistake invisible. A
 * review planted `LIMIT $3` -> `LIMIT $2` in the kind-filtered branch of the archive listing and the
 * whole suite stayed green at 790 tests, because this double recorded the text and the values and
 * checked neither against the other. Against a real cluster that statement binds a TEXT[] to LIMIT
 * and errors, so every kind-filtered request would have read UNKNOWN forever.
 *
 * The check is the highest placeholder against the number of parameters, which catches both
 * directions: a `$3` with two values, and a `$2` where the third value is now unreferenced. It guards
 * every statement that a test actually EXECUTES, on the database or on a transaction client, rather
 * than one test guarding one query. It does not guard a statement no test runs: the insert path was
 * unexecuted until a test was written for it, and until then this guard could not see it however
 * broad it was. A guard only inspects what runs through it.
 *
 * A gap in the numbering is also refused. `$1, $3` with three values has a highest of 3 and a count
 * of 3, so counting alone would pass it while `$2` sat unused, which is the shape of a half-finished
 * edit.
 *
 * The scan is textual, so a literal `$1` inside a quoted string would be counted as a placeholder.
 * No statement in this package contains one, and the failure direction is a loud false positive on a
 * statement a test runs rather than a silent pass, so it is left simple deliberately.
 */
function assertPlaceholdersMatch(text: string, values: readonly unknown[]): void {
  const used = new Set<number>();
  for (const match of text.matchAll(/\$(\d+)/g)) used.add(Number(match[1]));
  if (used.size === 0) {
    if (values.length > 0) {
      throw new Error(
        `This statement binds ${values.length} parameter(s) and references none: ${text.trim().slice(0, 120)}`,
      );
    }
    return;
  }

  const highest = Math.max(...used);
  if (highest !== values.length) {
    throw new Error(
      `This statement references up to $${highest} but was given ${values.length} parameter(s). ` +
        `A real driver would refuse it. Statement: ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
    );
  }
  for (let index = 1; index <= highest; index += 1) {
    if (!used.has(index)) {
      throw new Error(
        `This statement skips $${index} while referencing $${highest}: ` +
          text.replace(/\s+/g, ' ').trim().slice(0, 160),
      );
    }
  }
}

export function createFakeDatabase(respond: Responder): FakeDatabase {
  const queries: RecordedQuery[] = [];

  /**
   * One path for every statement, whether it arrives on the database or on a transaction client.
   *
   * `transaction` used to hand out `{} as PoolClient`, so anything inside a transaction reached a
   * client with no `query` at all: `remember` and `supersede` both run their insert and their audit
   * write through `client.query`, and NONE of it was recorded or checked. A review planted an
   * off-by-one in `insertSql` and 822 of 822 stayed green, while the docblock below claimed this
   * guarded every statement in the package. Now it does, and the claim is true rather than aspirational.
   */
  function run(text: string, values: readonly unknown[], via: 'db' | 'tx'): Promise<unknown[]> {
    queries.push({ text, values, via });
    try {
      assertPlaceholdersMatch(text, values);
      return Promise.resolve(respond(text, values));
    } catch (error) {
      // Rejected rather than thrown synchronously, matching how a driver reports both a bad statement
      // and a failed one. A caller wrapping this in a try/catch around an await sees the same shape.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    queries,
    texts(): string[] {
      return queries.map((query) => query.text.replace(/\s+/g, ' ').trim());
    },
    query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<Row[]> {
      return run(text, values, 'db') as Promise<Row[]>;
    },
    transaction<Result>(work: (client: PoolClient) => Promise<Result>): Promise<Result> {
      // A client that records and checks, rather than an empty object. `pg` returns `{ rows }`, which
      // is why the repository reads `.rows` off a client result and a bare array off `db.query`.
      const client = {
        query: (text: string, values: readonly unknown[] = []) =>
          run(text, values, 'tx').then((rows) => ({ rows })),
      };
      return work(client as unknown as PoolClient);
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
