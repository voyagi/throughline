import type { Database } from './db.ts';
import { quoteIdentifier } from './db.ts';
import type { Embedder } from './embeddings.ts';
import { retrievalPathFor } from './capability.ts';
import { graceDeadline, planEviction, type EvictionCandidate, type EvictionPlan } from './eviction.ts';
import { DEFAULT_POLICY, type MemoryPolicy } from './policy.ts';
import { formatVector, parseVector, rowToMemory, type MemoryRow } from './rows.ts';
import { cosineSimilarity, freshness, isStale, scoreMemory } from './scoring.ts';
import { decideCoverage } from './coverage.ts';
import type {
  Capabilities,
  CoverageCause,
  Exclusion,
  ExclusionRule,
  ListFailureCause,
  MemoryKind,
  MemoryPage,
  MemoryRecord,
  Provenance,
  RecallResult,
  ScoredMemory,
} from './types.ts';

/**
 * The memory operations, against real rows.
 *
 * Capabilities are INJECTED rather than probed on every call, because probing costs several round
 * trips and recall is the hot path. The consequence is honest rather than hidden: the receipt
 * reports the retrieval path that was DECIDED from those capabilities, and a caller holding stale
 * capabilities gets a receipt saying so. Re-probe when the schema changes or the embedder changes.
 */

const MEMORY_COLUMNS = `id, workspace_id, kind, content, embedding, embedding_model, asserted_by,
  incident_id, source_ref, created_at, last_confirmed_at, confirm_count, contradict_count,
  valid_from, valid_until, superseded_by, protected_until, evicted_at, eviction_reason`;

export interface RememberInput {
  readonly workspaceId: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly provenance: Provenance;
  /** Omit to store the memory unembedded. It will be recorded and will not be semantically recalled. */
  readonly embedding?: readonly number[] | null;
  readonly validFrom?: Date;
  readonly validUntil?: Date | null;
}

export interface RecallQuery {
  readonly workspaceId: string;
  readonly text: string;
  /** How many scored memories to return. Candidates examined is a separate, larger number. */
  readonly limit?: number;
  /** Reference instant for decay and validity. Injected so a test can pin an exact value. */
  readonly now?: Date;
}

/**
 * Browse the archive, bounded and filtered, with no query text and therefore no ranking.
 *
 * NOT A RECALL WITH AN EMPTY QUERY, and the distinction is why this is a separate method rather than
 * an option on `RecallQuery`. A recall embeds text, walks a vector index and produces a similarity
 * for every row it returns. There is no query here, so there is no similarity to produce, and the
 * page this feeds must not print one: a number invented to fill a column is the exact failure the
 * missing workspace total on `RecallReceipt` was refused for.
 */
export interface ListQuery {
  readonly workspaceId: string;
  /**
   * Which kinds to include. Omit, or pass an empty array, for every kind.
   *
   * A kind the caller repeats is harmless and a kind nobody knows cannot arrive: the type is the
   * union, and the HTTP surface validates a query string against `MEMORY_KINDS` before it gets here.
   */
  readonly kinds?: readonly MemoryKind[];
  /** Clamped to `policy.listCap`. The receipt reports the bound that was actually applied. */
  readonly limit?: number;
  /** Reference instant for decay. Injected so a test can pin an exact freshness. */
  readonly now?: Date;
}

export interface EvictionOutcome {
  readonly plan: EvictionPlan;
  readonly evicted: readonly string[];
}

export interface RepositoryOptions {
  readonly db: Database;
  readonly embedder: Embedder;
  readonly schema: string;
  readonly capabilities: Capabilities;
  readonly policy?: MemoryPolicy;
}

export interface MemoryRepository {
  remember(input: RememberInput): Promise<MemoryRecord>;
  recall(query: RecallQuery): Promise<RecallResult>;
  list(query: ListQuery): Promise<MemoryPage>;
  supersede(previousId: string, input: RememberInput): Promise<{
    previous: MemoryRecord;
    replacement: MemoryRecord;
  }>;
  evict(workspaceId: string, requested: number, now?: Date): Promise<EvictionOutcome>;
  getById(workspaceId: string, id: string): Promise<MemoryRecord | null>;
}

export function createRepository(options: RepositoryOptions): MemoryRepository {
  const { db, embedder, capabilities } = options;
  const policy = options.policy ?? DEFAULT_POLICY;
  const table = `${quoteIdentifier(options.schema)}.${quoteIdentifier('memory')}`;
  const auditTable = `${quoteIdentifier(options.schema)}.${quoteIdentifier('memory_audit')}`;

  async function audit(
    workspaceId: string,
    memoryId: string | null,
    operation: string,
    actor: string,
    detail: unknown,
  ): Promise<void> {
    await db.query(
      `INSERT INTO ${auditTable} (workspace_id, memory_id, operation, actor, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [workspaceId, memoryId, operation, actor, JSON.stringify(detail)],
    );
  }

  return {
    async remember(input: RememberInput): Promise<MemoryRecord> {
      assertProvenance(input);
      const now = new Date();
      // The memory and its audit row land in ONE transaction. They were separate, so a failing
      // audit insert left a memory with no audit trail and a caller who saw an error and would
      // retry, producing a duplicate. `supersede` already did this correctly, which is what made
      // the difference an oversight rather than a decision.
      return db.transaction(async (client) => {
        const inserted = await client.query<MemoryRow>(insertSql(table), insertValues(input, now, embedder, policy));
        const row = inserted.rows[0];
        if (!row) throw new Error('The insert returned no row, which should be impossible');

        await client.query(
          `INSERT INTO ${auditTable} (workspace_id, memory_id, operation, actor, detail)
           VALUES ($1, $2, 'remember', $3, $4)`,
          [
            input.workspaceId,
            row.id,
            input.provenance.assertedBy,
            JSON.stringify({ kind: input.kind, embedded: Boolean(input.embedding) }),
          ],
        );

        return rowToMemory(row);
      });
    },

    async recall(query: RecallQuery): Promise<RecallResult> {
      return runRecall({ db, embedder, capabilities, policy, table, audit }, query);
    },

    async list(query: ListQuery): Promise<MemoryPage> {
      return runList({ db, policy, table }, query);
    },

    async supersede(previousId, input) {
      assertProvenance(input);
      const now = new Date();
      return db.transaction(async (client) => {
        // FOR UPDATE, because the check below is a read-then-write and two concurrent supersedes of
        // the same memory would otherwise both pass it. The loser would silently overwrite
        // `superseded_by`, leaving one replacement orphaned and the chain claiming an ordering that
        // never happened. The lock makes the second transaction wait and then fail the check, which
        // is the outcome the check was written for.
        const existing = await client.query<MemoryRow>(
          `SELECT ${MEMORY_COLUMNS} FROM ${table} WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
          [previousId, input.workspaceId],
        );
        const previousRow = existing.rows[0];
        if (!previousRow) {
          throw new Error(
            `Cannot supersede ${previousId}: no such memory in workspace ${input.workspaceId}.`,
          );
        }
        if (previousRow.superseded_by !== null) {
          // Refusing rather than chaining, because a fact with two successors has no defensible
          // reading and the supersede chain is what "why did you tell me that" depends on.
          throw new Error(
            `Memory ${previousId} was already superseded by ${previousRow.superseded_by}. ` +
              'Supersede the current head of the chain instead.',
          );
        }

        const inserted = await client.query<MemoryRow>(
          insertSql(table),
          insertValues(input, now, embedder, policy),
        );
        const replacementRow = inserted.rows[0];
        if (!replacementRow) throw new Error('The replacement insert returned no row');

        // The old row is CLOSED, never deleted: its validity interval ends and it points at what
        // replaced it, so both remain queryable with their dates.
        await client.query(
          `UPDATE ${table} SET superseded_by = $1, valid_until = $2 WHERE id = $3`,
          [replacementRow.id, now, previousId],
        );

        await client.query(
          `INSERT INTO ${auditTable} (workspace_id, memory_id, operation, actor, detail)
           VALUES ($1, $2, 'supersede', $3, $4)`,
          [
            input.workspaceId,
            previousId,
            input.provenance.assertedBy,
            JSON.stringify({ replacedBy: replacementRow.id }),
          ],
        );

        const previous = await client.query<MemoryRow>(
          `SELECT ${MEMORY_COLUMNS} FROM ${table} WHERE id = $1`,
          [previousId],
        );
        const refreshed = previous.rows[0];
        if (!refreshed) throw new Error('The superseded row vanished inside its own transaction');

        return { previous: rowToMemory(refreshed), replacement: rowToMemory(replacementRow) };
      });
    },

    async evict(workspaceId, requested, now = new Date()) {
      const rows = await db.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS} FROM ${table} WHERE workspace_id = $1 AND is_live`,
        [workspaceId],
      );
      const memories = rows.map(rowToMemory);

      const candidates: EvictionCandidate[] = memories.map((memory) => ({
        id: memory.id,
        // Similarity is zero for every candidate, because eviction is not query driven. Adding the
        // same constant to every score leaves the ORDER untouched, which is all that matters here.
        score: scoreMemory(
          {
            similarity: 0,
            freshness: freshness(memory.kind, memory.lastConfirmedAt, now, policy),
            confirmCount: memory.confirmCount,
            contradictCount: memory.contradictCount,
          },
          policy,
        ),
        createdAt: memory.createdAt,
        protectedUntil: memory.protectedUntil,
        evictedAt: memory.evictedAt,
      }));

      const plan = planEviction({ candidates, requested, now, policy });
      if (plan.evict.length === 0) {
        for (const refusal of plan.refused) {
          await audit(workspaceId, refusal.id, 'evict_refused', 'system', {
            rule: refusal.reason,
            detail: refusal.detail,
          });
        }
        return { plan, evicted: [] };
      }

      const evicted = await db.transaction(async (client) => {
        const ids = plan.evict.map((decision) => decision.id);
        // `evicted_at IS NULL` guards the gap between planning and writing: the plan was computed
        // from a snapshot taken outside this transaction, so another sweep could have tombstoned a
        // row in between. Without it, the second run would overwrite the first run's eviction
        // timestamp and reason, quietly rewriting when a memory was removed and why.
        await client.query(
          `UPDATE ${table} SET evicted_at = $1, eviction_reason = $2
            WHERE id = ANY($3::UUID[]) AND workspace_id = $4 AND evicted_at IS NULL`,
          [now, 'evicted by the scheduled sweep', ids, workspaceId],
        );
        for (const decision of plan.evict) {
          await client.query(
            `INSERT INTO ${auditTable} (workspace_id, memory_id, operation, actor, detail)
             VALUES ($1, $2, 'evict', 'system', $3)`,
            [workspaceId, decision.id, JSON.stringify({ score: decision.score })],
          );
        }
        return ids;
      });

      // Refusals are audited too. An eviction run that records only removals cannot be told apart
      // from one whose protections never fired.
      for (const refusal of plan.refused) {
        await audit(workspaceId, refusal.id, 'evict_refused', 'system', {
          rule: refusal.reason,
          detail: refusal.detail,
        });
      }

      return { plan, evicted };
    },

    async getById(workspaceId, id) {
      const rows = await db.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS} FROM ${table} WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      );
      const row = rows[0];
      return row ? rowToMemory(row) : null;
    },
  };
}

/**
 * The insert shared by `remember` and `supersede`.
 *
 * One definition rather than two copies, because the two had drifted already: only one of them
 * wrote its audit row inside the transaction. Two code paths that must make the same decision
 * belong in one place, and a comment asking a future reader to keep them in step does not stop
 * them drifting.
 */
function insertSql(table: string): string {
  return `INSERT INTO ${table}
            (workspace_id, kind, content, embedding, embedding_model, asserted_by, incident_id,
             source_ref, valid_from, valid_until, protected_until)
          VALUES ($1, $2, $3, $4::VECTOR, $5, $6, $7, $8, $9, $10, $11)
          RETURNING ${MEMORY_COLUMNS}`;
}

function insertValues(
  input: RememberInput,
  now: Date,
  embedder: Embedder,
  policy: MemoryPolicy,
): unknown[] {
  const embedding = input.embedding ? formatVector([...input.embedding]) : null;
  return [
    input.workspaceId,
    input.kind,
    input.content,
    embedding,
    embedding ? embedder.id : null,
    input.provenance.assertedBy,
    input.provenance.incidentId,
    input.provenance.sourceRef,
    input.validFrom ?? now,
    input.validUntil ?? null,
    graceDeadline(now, policy),
  ];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertProvenance(input: RememberInput): void {
  if (!input.provenance.assertedBy.trim()) {
    // Rejected at the boundary, not warned about. The database has the same CHECK; this one gives
    // a better message and fails before a round trip.
    throw new Error(
      'A memory needs provenance: provenance.assertedBy must say who or what asserted it. ' +
        'A memory nobody can attribute is a rumour.',
    );
  }
}

interface RecallContext {
  readonly db: Database;
  readonly embedder: Embedder;
  readonly capabilities: Capabilities;
  readonly policy: MemoryPolicy;
  readonly table: string;
  readonly audit: (
    workspaceId: string,
    memoryId: string | null,
    operation: string,
    actor: string,
    detail: unknown,
  ) => Promise<void>;
}

interface WorkspaceCounts {
  readonly tombstoned: number;
  readonly unembedded: number;
}

async function runRecall(context: RecallContext, query: RecallQuery): Promise<RecallResult> {
  const { db, embedder, capabilities, policy, table } = context;
  const now = query.now ?? new Date();
  const startedAt = Date.now();
  const limit = query.limit ?? 5;
  const retrieval = retrievalPathFor(capabilities);

  if (retrieval.path === 'none') {
    // The one reason on this path that is NOT written here: `retrievalPathFor` composes it from
    // capability observations, and those are written from scratch in `capability.ts` for the same
    // reason the four below are. It says which dimensions disagreed, which is the useful fact and
    // carries nothing a driver threw.
    return emptyUnknown(query, now, startedAt, retrieval.reason, 'no_retrieval_path');
  }

  let queryVector: number[];
  try {
    // 'query' matters: some hosted models embed a stored document and a search query into
    // different spaces, and asking for the wrong one degrades retrieval without failing anything.
    queryVector = await embedder.embed(query.text, 'query');
  } catch {
    // The embedder failing is the canonical UNKNOWN. It is NOT an empty result, and it is not a
    // reason to fall back to a weaker embedder: a silent substitution produces confident answers
    // from a different measurement.
    //
    // THE THROWN MESSAGE IS NOT READ. An embedding provider is a hosted AWS service, and its
    // rejections carry role ARNs and account ids; this reason ends up in a `tool_result`, in the
    // transcript, in a 200 body and on the console's screen. Proven, not hypothesised: the control
    // in `apps/api/test/server.test.ts` failed against the previous version of this line with a
    // role ARN in the response body.
    return emptyUnknown(
      query,
      now,
      startedAt,
      'the embedding provider failed, so the query could not be turned into a vector and neither ' +
        'retrieval path could run',
      'embedder_failed',
    );
  }

  // A full-workspace aggregate is the statement most likely to hit the statement timeout, and it
  // used to throw straight past every coverage decision in this function. A recall that cannot
  // complete its own accounting is UNKNOWN, not a crash.
  let counts: WorkspaceCounts;
  try {
    counts = await workspaceCounts(db, table, query.workspaceId);
  } catch {
    return emptyUnknown(
      query,
      now,
      startedAt,
      'the exclusion counts could not be read, so this search cannot say what it left out',
      'exclusion_counts_failed',
    );
  }

  let rows: MemoryRow[];
  try {
    rows = await db.query<MemoryRow>(candidateSql(table, retrieval.path), [
      query.workspaceId,
      formatVector(queryVector),
      policy.candidateCap,
    ]);
  } catch {
    return emptyUnknown(
      query,
      now,
      startedAt,
      'the candidate query failed, so no rows were examined',
      'candidate_query_failed',
    );
  }

  // Scoring can throw on a single malformed row: an unparseable vector, a kind the code does not
  // know. One bad row used to take the entire recall down. UNKNOWN is the honest verdict, because
  // the search genuinely could not be completed.
  let scoredCandidates: { scored: ScoredMemory[]; exclusions: Exclusion[] };
  try {
    scoredCandidates = scoreCandidates(rows, queryVector, now, policy, counts);
  } catch {
    return emptyUnknown(
      query,
      now,
      startedAt,
      'a candidate could not be scored, so the ranking is incomplete and the search is not usable',
      'scoring_failed',
    );
  }
  const { scored, exclusions } = scoredCandidates;
  const ranked = [...scored].sort((left, right) => right.score - left.score).slice(0, limit);

  const verdict = decideCoverage({
    retrievalFailed: false,
    failureReason: null,
    retrievalPath: retrieval.path,
    candidateCapReached: rows.length >= policy.candidateCap,
    deadlineExceeded: false,
    candidatesConsidered: rows.length,
  });

  const result: RecallResult = {
    memories: ranked,
    receipt: {
      query: query.text,
      workspaceId: query.workspaceId,
      requestedAt: now,
      elapsedMs: Date.now() - startedAt,
      retrievalPath: retrieval.path,
      candidatesConsidered: rows.length,
      returned: ranked.length,
      exclusions,
      coverage: verdict.coverage,
      coverageReason: verdict.reason,
      // Nothing stopped this search. A COVERED empty result has no cause, and inventing one here
      // would let a console print "stopped by" over a search that ran to completion.
      coverageCause: null,
      degradations: retrieval.path === 'exact_scan' ? [retrieval.reason] : [],
    },
  };

  // The audit write must not discard a search that already succeeded. Failing here loses an audit
  // row, which is worth reporting loudly and is not worth throwing away a correct answer for. The
  // console is the right channel: the caller asked for memories, not for audit plumbing.
  await context
    .audit(query.workspaceId, null, 'recall', 'system', {
      coverage: result.receipt.coverage,
      retrievalPath: result.receipt.retrievalPath,
      candidates: result.receipt.candidatesConsidered,
      returned: result.receipt.returned,
    })
    .catch((error: unknown) => {
      console.error(`[memory] the recall audit row could not be written: ${describe(error)}`);
    });

  return result;
}

interface ListContext {
  readonly db: Database;
  readonly policy: MemoryPolicy;
  readonly table: string;
}

/**
 * One listing, with a receipt, and no ranking anywhere in it.
 *
 * Built on the same discipline as `runRecall` and for the same reason: every stage that can fail has
 * its own `catch` returning a receipt whose `coverageCause` is a VALUE, so a caller learns which
 * stage stopped without any caught error's message being interpolated into anything. This page is
 * rendered into a public HTML page, so that is a security boundary rather than a style.
 *
 * NO AUDIT ROW IS WRITTEN. A read that changes nothing and names nobody is not an auditable event,
 * and `memory_audit`'s CHECK constraint lists the operations it permits: adding a row per page view
 * would need a migration and would grow the audit table with the least interesting fact in the
 * system. `recall` audits because it is the model's own tool use; this is a person paging a screen.
 */
async function runList(context: ListContext, query: ListQuery): Promise<MemoryPage> {
  const { db, policy, table } = context;
  const now = query.now ?? new Date();
  const startedAt = Date.now();
  const kinds = query.kinds ?? [];
  const limit = boundedLimit(query.limit, policy.listCap);

  // ONE MORE THAN THE BOUND, so PARTIAL is measured rather than inferred. `returned === limit` is
  // not evidence that more exist: an archive holding exactly `limit` rows would be reported as
  // truncated forever, and a page claiming there is more behind it when there is not is the same
  // class of lie as a page claiming there is nothing when it could not look.
  const probe = limit + 1;

  let rows: MemoryRow[];
  try {
    const statement = listStatement(table, query.workspaceId, kinds, probe);
    rows = await db.query<MemoryRow>(statement.sql, statement.params);
  } catch {
    return emptyUnknownPage(
      query.workspaceId,
      kinds,
      limit,
      now,
      startedAt,
      'the archive query failed, so no rows were read and this page cannot say the archive is empty',
      'listing_query_failed',
    );
  }

  const more = rows.length > limit;

  let memories: MemoryRecord[];
  try {
    // Sliced BEFORE mapping, so the extra probe row is never parsed and never returned. Mapping
    // first and slicing after would do the same work and then throw it away, and a malformed row
    // sitting in the probe position would fail a listing that did not need it.
    memories = rows.slice(0, limit).map(rowToMemory);
  } catch {
    // `rowToMemory` throws when a row's kind is not one this code knows, which means the database
    // CHECK and MEMORY_KINDS have diverged. A shorter archive would hide that; UNKNOWN reports it.
    return emptyUnknownPage(
      query.workspaceId,
      kinds,
      limit,
      now,
      startedAt,
      'a row could not be read, so this page would be missing rows without being able to say which',
      'row_unreadable',
    );
  }

  return {
    memories,
    receipt: {
      workspaceId: query.workspaceId,
      requestedAt: now,
      elapsedMs: Date.now() - startedAt,
      kinds,
      limit,
      returned: memories.length,
      coverage: more ? 'PARTIAL' : 'COVERED',
      coverageReason: more
        ? `the archive holds more than ${limit} rows matching this filter, so this page is the ` +
          'newest of them and not all of them'
        : 'every row matching this filter fitted inside the bound',
      // Nothing stopped this listing. A COVERED empty archive has no cause, and PARTIAL is a bound
      // that was reached rather than a stage that failed.
      coverageCause: null,
    },
  };
}

/**
 * The listing statement and its parameters, produced together.
 *
 * ONE FUNCTION RETURNING BOTH, deliberately, because the two shapes need different parameter
 * numbering and a builder that returned only SQL would leave the caller to number a `$n` list that
 * shifts when the filter is absent. `candidateSql` below can safely return a string alone: its two
 * branches differ by a WHERE clause with no parameter in it. This one does not have that luxury, and
 * an off-by-one in bind parameters is a runtime error on a public route.
 *
 * That risk is now GUARDED rather than merely explained. A review planted `LIMIT $3` -> `LIMIT $2`
 * here and the whole suite stayed green, because the test double recorded a statement's text and its
 * values and compared neither. `createFakeDatabase` now refuses a placeholder mismatch the way a real
 * driver would, and the filtered branch's bound has its position asserted by name.
 *
 * TOMBSTONED AND SUPERSEDED ROWS ARE INCLUDED, and there is no `is_live` filter here on purpose.
 * They are the two things this archive can show that a plain vector store cannot, so excluding them
 * would remove the page's entire argument. `memoryState` labels each row and the caller renders the
 * difference.
 *
 * `created_at DESC, id DESC` rather than `created_at DESC` alone. The tiebreak makes the order
 * TOTAL: two rows written in the same transaction share a timestamp, and without it their relative
 * order is whatever the storage engine feels like, so the same request could return them in a
 * different order each time and a PARTIAL page's boundary would move under the reader.
 */
function listStatement(
  table: string,
  workspaceId: string,
  kinds: readonly MemoryKind[],
  limit: number,
): { sql: string; params: unknown[] } {
  const select = `SELECT ${MEMORY_COLUMNS} FROM ${table} WHERE workspace_id = $1`;
  const order = 'ORDER BY created_at DESC, id DESC';

  if (kinds.length === 0) {
    return { sql: `${select} ${order} LIMIT $2`, params: [workspaceId, limit] };
  }
  return {
    sql: `${select} AND kind = ANY($2::TEXT[]) ${order} LIMIT $3`,
    params: [workspaceId, [...kinds], limit],
  };
}

/**
 * Clamp a caller's bound into something this route will actually run.
 *
 * Every rejected input becomes the CAP rather than an error, because the bound is a display
 * preference and refusing a whole page over a bad query string would turn a typo into an outage.
 * `?limit=abc` is `NaN` and lands on the cap rather than on a `LIMIT NaN` the driver would reject.
 *
 * THE FLOOR HAPPENS BEFORE THE POSITIVE TEST, and the order is the whole correctness of this
 * function. The first version tested `requested <= 0` first, so `?limit=0.5` passed the guard as a
 * positive number and then floored to ZERO. A bound of zero is not a smaller page, it is a
 * self-contradicting one: the probe still fetches one row, `rows.length > limit` is `1 > 0`, and the
 * receipt reports PARTIAL with `returned: 0` while claiming "the archive holds more than 0 rows".
 * A review reproduced that from the public query string against a twelve-row archive, and the page
 * rendered "no row in the archive matches it" on the same strip. Anything that does not floor to a
 * positive integer is therefore "no preference", exactly like zero and like a negative.
 */
function boundedLimit(requested: number | undefined, cap: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return cap;
  const whole = Math.floor(requested);
  if (whole <= 0) return cap;
  return Math.min(whole, cap);
}

/** A page that could not be read, with the receipt saying so. Never an empty array on its own. */
function emptyUnknownPage(
  workspaceId: string,
  kinds: readonly MemoryKind[],
  limit: number,
  now: Date,
  startedAt: number,
  reason: string,
  cause: ListFailureCause,
): MemoryPage {
  return {
    memories: [],
    receipt: {
      workspaceId,
      requestedAt: now,
      elapsedMs: Date.now() - startedAt,
      kinds,
      limit,
      returned: 0,
      coverage: 'UNKNOWN',
      coverageReason: reason,
      coverageCause: cause,
    },
  };
}

/**
 * The candidate query, which differs by retrieval path for one measured reason.
 *
 * CockroachDB sorts NULLs FIRST by default, the opposite of PostgreSQL: `null_ordered_last` is
 * `off`, and `ORDER BY v ASC` over (1.0, NULL, 2.0) really does return NULL first. A memory can be
 * stored without an embedding, deliberately, so `embedding <=> $2` is NULL for those rows and they
 * would sort ahead of every real match and consume the whole candidate cap. The scenario that
 * creates unembedded rows in bulk is an embedder outage, which is exactly when recall matters most.
 *
 * The obvious fix, `AND embedding IS NOT NULL` on both paths, is wrong. Measured against the live
 * cluster: that filter turns the ANN plan into a FULL SCAN, the same trap that an `evicted_at IS
 * NULL` filter set earlier, because CockroachDB only accelerates a filtered vector search on the
 * index's prefix columns.
 *
 * Measured on the same cluster, the filter is also UNNECESSARY on the ANN path: with three
 * embedded and five unembedded live rows and a LIMIT of four, the query returned exactly the three
 * embedded rows. The vector index does not contain NULL vectors, so it cannot return them.
 *
 * So the filter goes on the exact-scan path only, where there is no acceleration to lose and where
 * the NULLs-first default really would eat the cap. Both branches are justified by their own
 * measurement rather than by making the two look symmetrical.
 */
function candidateSql(table: string, path: 'ann_index' | 'exact_scan'): string {
  const embeddingFilter = path === 'exact_scan' ? 'AND embedding IS NOT NULL' : '';
  return `SELECT ${MEMORY_COLUMNS} FROM ${table}
           WHERE workspace_id = $1 AND is_live ${embeddingFilter}
           ORDER BY embedding <=> $2::VECTOR
           LIMIT $3`;
}

/**
 * Counts the candidate query structurally cannot report.
 *
 * The candidate query filters `is_live` in SQL, because that column is an index prefix and moving
 * the filter into the application would cost the ANN path. Rows it excludes therefore never reach
 * the scoring loop and cannot be counted there. One aggregate covers both, so the receipt can name
 * them rather than quietly omitting them.
 */
async function workspaceCounts(
  db: Database,
  table: string,
  workspaceId: string,
): Promise<WorkspaceCounts> {
  const rows = await db.query<{ tombstoned: string; unembedded: string }>(
    `SELECT count(*) FILTER (WHERE NOT is_live)                      AS tombstoned,
            count(*) FILTER (WHERE is_live AND embedding IS NULL)    AS unembedded
       FROM ${table} WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = rows[0];
  return {
    tombstoned: Number(row?.tombstoned ?? 0),
    unembedded: Number(row?.unembedded ?? 0),
  };
}

function scoreCandidates(
  rows: readonly MemoryRow[],
  queryVector: readonly number[],
  now: Date,
  policy: MemoryPolicy,
  counts: WorkspaceCounts,
): { scored: ScoredMemory[]; exclusions: Exclusion[] } {
  const dropped = new Map<ExclusionRule, number>();
  const drop = (rule: ExclusionRule): void => {
    dropped.set(rule, (dropped.get(rule) ?? 0) + 1);
  };
  if (counts.tombstoned > 0) dropped.set('tombstoned', counts.tombstoned);
  if (counts.unembedded > 0) dropped.set('not_embedded', counts.unembedded);

  const scored: ScoredMemory[] = [];
  for (const row of rows) {
    const memory = rowToMemory(row);
    if (memory.supersededBy !== null) {
      drop('superseded');
      continue;
    }
    if (isOutsideValidity(memory, now)) {
      drop('outside_validity_window');
      continue;
    }
    const embedding = parseVector(row.embedding);
    if (!embedding) {
      // Already counted by the aggregate; not counted twice.
      continue;
    }

    const similarity = cosineSimilarity(queryVector, embedding);
    if (similarity < policy.similarityFloor) {
      drop('below_similarity_floor');
      continue;
    }

    const freshnessValue = freshness(memory.kind, memory.lastConfirmedAt, now, policy);
    scored.push({
      memory,
      similarity,
      freshness: freshnessValue,
      score: scoreMemory(
        {
          similarity,
          freshness: freshnessValue,
          confirmCount: memory.confirmCount,
          contradictCount: memory.contradictCount,
        },
        policy,
      ),
      stale: isStale(freshnessValue, policy),
    });
  }

  const exclusions = [...dropped.entries()].map(([rule, count]) => ({ rule, count }));
  return { scored, exclusions };
}

function isOutsideValidity(memory: MemoryRecord, now: Date): boolean {
  if (memory.validFrom.getTime() > now.getTime()) return true;
  return memory.validUntil !== null && memory.validUntil.getTime() <= now.getTime();
}

/**
 * The UNKNOWN result, built in one place so every failed stage reports itself the same way.
 *
 * `reason` is CALLER-AUTHORED PROSE and must never contain a caught error's message. Every call
 * site above passes a literal for exactly that reason; see the docblock on
 * `RecallReceipt.coverageReason`. `cause` is the machine-readable half, so a console can say which
 * stage stopped without any caller having to parse the sentence.
 */
function emptyUnknown(
  query: RecallQuery,
  now: Date,
  startedAt: number,
  reason: string,
  cause: CoverageCause,
): RecallResult {
  const verdict = decideCoverage({
    retrievalFailed: true,
    failureReason: reason,
    retrievalPath: 'none',
    candidateCapReached: false,
    deadlineExceeded: false,
    candidatesConsidered: 0,
  });
  return {
    memories: [],
    receipt: {
      query: query.text,
      workspaceId: query.workspaceId,
      requestedAt: now,
      elapsedMs: Date.now() - startedAt,
      retrievalPath: 'none',
      candidatesConsidered: 0,
      returned: 0,
      exclusions: [],
      coverage: verdict.coverage,
      coverageReason: verdict.reason,
      coverageCause: cause,
      degradations: [reason],
    },
  };
}
