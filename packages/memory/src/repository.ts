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
  Exclusion,
  ExclusionRule,
  MemoryKind,
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
    return emptyUnknown(query, now, startedAt, retrieval.reason);
  }

  let queryVector: number[];
  try {
    // 'query' matters: some hosted models embed a stored document and a search query into
    // different spaces, and asking for the wrong one degrades retrieval without failing anything.
    queryVector = await embedder.embed(query.text, 'query');
  } catch (error) {
    // The embedder failing is the canonical UNKNOWN. It is NOT an empty result, and it is not a
    // reason to fall back to a weaker embedder: a silent substitution produces confident answers
    // from a different measurement.
    return emptyUnknown(
      query,
      now,
      startedAt,
      `the embedding provider failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // A full-workspace aggregate is the statement most likely to hit the statement timeout, and it
  // used to throw straight past every coverage decision in this function. A recall that cannot
  // complete its own accounting is UNKNOWN, not a crash.
  let counts: WorkspaceCounts;
  try {
    counts = await workspaceCounts(db, table, query.workspaceId);
  } catch (error) {
    return emptyUnknown(
      query,
      now,
      startedAt,
      `the exclusion counts could not be read: ${describe(error)}`,
    );
  }

  let rows: MemoryRow[];
  try {
    rows = await db.query<MemoryRow>(candidateSql(table, retrieval.path), [
      query.workspaceId,
      formatVector(queryVector),
      policy.candidateCap,
    ]);
  } catch (error) {
    return emptyUnknown(
      query,
      now,
      startedAt,
      `the candidate query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Scoring can throw on a single malformed row: an unparseable vector, a kind the code does not
  // know. One bad row used to take the entire recall down. UNKNOWN is the honest verdict, because
  // the search genuinely could not be completed.
  let scoredCandidates: { scored: ScoredMemory[]; exclusions: Exclusion[] };
  try {
    scoredCandidates = scoreCandidates(rows, queryVector, now, policy, counts);
  } catch (error) {
    return emptyUnknown(query, now, startedAt, `a candidate could not be scored: ${describe(error)}`);
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

function emptyUnknown(
  query: RecallQuery,
  now: Date,
  startedAt: number,
  reason: string,
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
      degradations: [reason],
    },
  };
}
