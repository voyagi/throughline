import type { Database } from './db.ts';
import { quoteIdentifier } from './db.ts';
import type { Embedder } from './embeddings.ts';
import { observed, unknown, type Capabilities, type Observation, type RetrievalPath } from './types.ts';

/**
 * Ask the LIVE database what it can actually do.
 *
 * Nothing downstream is allowed to assume a capability that was not observed here. Every check
 * returns a tri-state, so a probe that could not run reports `unknown` with a reason rather than
 * defaulting to `false` and reading as a definite absence.
 *
 * The single largest open question this answers: whether the cluster tier in use permits vector
 * indexing at all. That is undocumented for the free tier, so it is measured rather than assumed.
 */

const PROBE_TEXT = 'throughline capability probe';

/**
 * A workspace that does not exist, used only to shape the query plan.
 *
 * EXPLAIN does not execute, so no rows are needed. A real workspace id is deliberately NOT used:
 * the probe must not have its answer depend on whose data happens to be present.
 */
const PROBE_WORKSPACE = '__throughline_capability_probe__';

export interface ProbeOptions {
  readonly schema: string;
  readonly embedder: Embedder;
  /** Defaults to the memory table. Parameterised so a test can point it at a fixture table. */
  readonly table?: string;
}

export async function probeCapabilities(
  db: Database,
  options: ProbeOptions,
): Promise<Capabilities> {
  const table = options.table ?? 'memory';

  // The column width is read first because the plan probe needs it to build a probe vector of the
  // right shape. Everything else is independent and runs together.
  const vectorColumnDimensions = await probeVectorColumn(db, options.schema, table);

  const [serverVersion, vectorIndex, vectorIndexingEnabled, embedderDimensions, annPlanUsesIndex] =
    await Promise.all([
      probeServerVersion(db),
      probeVectorIndex(db, options.schema, table),
      probeVectorIndexingEnabled(db),
      probeEmbedder(options.embedder),
      probeAnnPlan(db, options.schema, table, vectorColumnDimensions),
    ]);

  return {
    observedAt: new Date(),
    target: db.describe(),
    serverVersion,
    vectorColumnDimensions,
    vectorIndex,
    annPlanUsesIndex,
    vectorIndexingEnabled,
    embedderDimensions,
  };
}

async function probeServerVersion(db: Database): Promise<Observation<string>> {
  try {
    const rows = await db.query<{ version: string }>('SELECT version() AS version');
    const version = rows[0]?.version;
    return version ? observed(version) : unknown('version() returned no rows');
  } catch {
    return unknown('could not read the server version');
  }
}

/**
 * Read the declared dimension of the embedding column from the catalog.
 *
 * CockroachDB reports a vector column's type as `VECTOR(n)` in `information_schema`, so the
 * dimension is parsed out of the type string rather than trusted from configuration. The point of
 * this check is to catch the case where the column and the embedder disagree, which writes
 * silently truncated or rejected vectors.
 */
async function probeVectorColumn(
  db: Database,
  schema: string,
  table: string,
): Promise<Observation<number>> {
  try {
    const rows = await db.query<{ data_type: string | null; crdb_sql_type: string | null }>(
      `SELECT data_type, crdb_sql_type
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = 'embedding'`,
      [schema, table],
    );
    const row = rows[0];
    if (!row) {
      return unknown(`no embedding column found on ${schema}.${table}; has the migration run?`);
    }
    const declared = row.crdb_sql_type ?? row.data_type ?? '';
    const match = /VECTOR\s*\(\s*(\d+)\s*\)/i.exec(declared);
    if (!match?.[1]) {
      return unknown(`the embedding column reports type "${declared}", which carries no dimension`);
    }
    return observed(Number.parseInt(match[1], 10));
  } catch {
    return unknown(`could not inspect the embedding column on ${schema}.${table}`);
  }
}

/**
 * Does an index exist on the embedding column.
 *
 * Read from the catalog rather than inferred from whether a CREATE succeeded earlier, because the
 * only trustworthy answer to "is the accelerator there" is the one the database gives now.
 *
 * The `storing` and `implicit` filters are load-bearing, and they are here because the obvious
 * version of this check was measured returning a FALSE POSITIVE on a live cluster. A CockroachDB
 * primary index STORES every non-key column, so `embedding` appears under `memory_pkey`, and a
 * query that merely asks "does any index mention this column" answers yes on a table with no
 * vector index at all. That would have made recall report an ANN path while doing a full scan,
 * which is this system's own thesis failing inside its own probe.
 *
 * `information_schema.statistics` cannot express the distinction, and `crdb_internal.table_indexes`
 * (which carries `index_type`) is REFUSED on CockroachDB Cloud Basic with "Access to crdb_internal
 * and system is restricted". `SHOW INDEXES` is what is left, and it does carry both flags.
 */
async function probeVectorIndex(
  db: Database,
  schema: string,
  table: string,
): Promise<Observation<boolean>> {
  try {
    const rows = await db.query<{ index_name: string }>(
      `SELECT index_name FROM [SHOW INDEXES FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}]
        WHERE column_name = 'embedding' AND storing = false AND implicit = false`,
    );
    return observed(rows.length > 0);
  } catch {
    return unknown(`could not list indexes on ${schema}.${table}`);
  }
}

/**
 * Does the planner ACTUALLY use the vector index for the query recall runs.
 *
 * Separate from "an index exists", because those are different claims and only this one predicts
 * what happens at query time. An index can exist and be ignored: the wrong operator class, a
 * filter the index cannot serve, a planner that decides a scan is cheaper. Reporting the existence
 * of an accelerator as proof that it will be used is the same mistake as trusting a tool's success
 * response instead of looking at the system.
 *
 * The probe vector is built at the column's real width, so a dimension mismatch surfaces here as a
 * database error rather than as a silently different plan.
 */
async function probeAnnPlan(
  db: Database,
  schema: string,
  table: string,
  dimensions: Observation<number>,
): Promise<Observation<boolean>> {
  if (dimensions.status === 'unknown') {
    return unknown(`the embedding column width is unknown, so no probe vector could be built`);
  }
  const probeVector = `[${new Array<string>(dimensions.value).fill('0.01').join(',')}]`;
  try {
    // The filter here MUST match the one recall uses, or this probe answers a question nobody
    // asked. Measured on a live cluster: the same table and index plan as a vector search under
    // `workspace_id = $1 AND is_live` and as a FULL SCAN under `evicted_at IS NULL`, because
    // CockroachDB only accelerates a filtered vector search on the index's prefix columns. A probe
    // written against the wrong filter would have reported "no acceleration" forever while the
    // real query was fine, or the reverse.
    const rows = await db.query<Record<string, unknown>>(
      `EXPLAIN SELECT id FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
         WHERE workspace_id = $2 AND is_live
         ORDER BY embedding <=> $1::VECTOR
         LIMIT 5`,
      [probeVector, PROBE_WORKSPACE],
    );
    const plan = rows
      .map((row) => Object.values(row).join(' '))
      .join('\n')
      .toLowerCase();
    // A vector index scan names the index and reports a vector search operator. Matching on the
    // operator rather than only on the index name, because an index can be named anything.
    const usesVectorSearch = plan.includes('vector search') || plan.includes('vecindex');
    return observed(usesVectorSearch);
  } catch {
    return unknown('the query plan could not be read');
  }
}

/**
 * Whether this cluster reports vector indexing as available.
 *
 * A managed tier can refuse to expose or change this setting. A refusal is `unknown` with the
 * database's own words attached, never `false`: "you may not ask" and "the answer is no" are
 * different, and only one of them means the feature is missing.
 */
async function probeVectorIndexingEnabled(db: Database): Promise<Observation<boolean>> {
  try {
    const rows = await db.query<Record<string, unknown>>(
      'SHOW CLUSTER SETTING feature.vector_index.enabled',
    );
    const row = rows[0];
    if (!row) return unknown('the cluster returned no value for feature.vector_index.enabled');
    const value = Object.values(row)[0];
    if (typeof value === 'boolean') return observed(value);
    if (typeof value === 'string') return observed(value === 'true' || value === 'on');
    return unknown(`feature.vector_index.enabled reported an unrecognised value: ${String(value)}`);
  } catch {
    return unknown('this cluster would not report feature.vector_index.enabled');
  }
}

async function probeEmbedder(embedder: Embedder): Promise<Observation<number>> {
  try {
    const vector = await embedder.embed(PROBE_TEXT);
    if (!Array.isArray(vector) || vector.length === 0) {
      return unknown(`embedder ${embedder.id} returned an empty vector`);
    }
    return observed(vector.length);
  } catch {
    return unknown(`embedder ${embedder.id} failed`);
  }
}

/**
 * Decide which retrieval path is actually available, from observations alone.
 *
 * Pure and total, so the mapping from "what the database said" to "what recall may do" is testable
 * without a database and cannot drift between call sites.
 *
 * The ordering matters. A dimension mismatch produces `none` rather than falling back to an exact
 * scan, because comparing vectors of different widths does not give a worse answer, it gives a
 * meaningless one. `none` is what makes recall report coverage UNKNOWN.
 */
export function retrievalPathFor(capabilities: Capabilities): {
  path: RetrievalPath;
  reason: string;
} {
  const { vectorColumnDimensions: column, embedderDimensions: embedder } = capabilities;

  if (column.status === 'unknown') {
    return { path: 'none', reason: `the embedding column could not be inspected: ${column.reason}` };
  }
  if (embedder.status === 'unknown') {
    return { path: 'none', reason: `the embedder could not be measured: ${embedder.reason}` };
  }
  if (column.value !== embedder.value) {
    return {
      path: 'none',
      reason:
        `the embedding column is ${column.value} dimensions and the embedder produces ` +
        `${embedder.value}. Comparing them would not be less accurate, it would be meaningless.`,
    };
  }
  // The PLAN decides, not the existence of an index. An index the planner ignores accelerates
  // nothing, and claiming an ANN path on the strength of a catalog row is how a system ends up
  // reporting a capability it does not have.
  const plan = capabilities.annPlanUsesIndex;
  if (plan.status === 'observed' && plan.value) {
    return { path: 'ann_index', reason: 'the planner uses the vector index for the recall query' };
  }

  const why = explainNoAnn(capabilities);
  return {
    path: 'exact_scan',
    reason: `${why}, so recall compares every live row directly. Results are complete but slower.`,
  };
}

function explainNoAnn(capabilities: Capabilities): string {
  const { vectorIndex, annPlanUsesIndex } = capabilities;

  if (annPlanUsesIndex.status === 'unknown') {
    return `the query plan could not be read (${annPlanUsesIndex.reason})`;
  }
  if (vectorIndex.status === 'unknown') {
    return `the planner does not use a vector index, and whether one exists could not be determined (${vectorIndex.reason})`;
  }
  if (vectorIndex.value) {
    // The interesting case, and worth its own sentence: the accelerator is installed and being
    // ignored. That is an operator problem, not a missing feature, and the two need different fixes.
    return 'a vector index exists but the planner is not using it for this query';
  }
  return 'no vector index exists on the embedding column';
}

/*
 * WHY NO PROBE REASON ABOVE QUOTES WHAT WAS THROWN, and this used to be a helper called
 * `messageOf` that every `catch` in this file passed its error to.
 *
 * These reasons are not private diagnostics. `retrievalPathFor` composes them into the reason
 * recall reports for falling back to an exact scan, that reason becomes `receipt.degradations`,
 * `renderRecall` prints degradations into a `tool_result`, and `/agent/turn` returns the whole
 * transcript on a 200. So a driver message caught here is a public response body two hops later,
 * on a COVERED turn with nothing wrong, on every turn after a boot-time probe that failed once.
 *
 * That is not a hypothesis. The control named "does not carry a capability probe failure into a
 * COVERED transcript" in `apps/api/test/server.test.ts` failed against the previous version of
 * this file with a role ARN in the response body.
 *
 * What is lost is the driver's own words in `npm run probe` output. What is kept is the sentence
 * that says which check failed, which is the half an operator acts on.
 */
