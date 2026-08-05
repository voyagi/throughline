/**
 * The vocabulary of the memory layer.
 *
 * One rule shapes every type here: a caller must never be able to read recalled memories without
 * also holding the receipt that says whether the search actually ran. There is no function in this
 * package that returns a bare array of memories, and that is deliberate rather than stylistic.
 */

/**
 * What kind of thing is being remembered. The kind is not a label, it drives the half-life and it
 * changes what recall does with the row.
 *
 * `rejected_hypothesis` earns its place: knowing what did NOT fix an outage is half the value of
 * an incident archive, and it is the first thing a conversation summariser throws away.
 */
export type MemoryKind =
  | 'observation'
  | 'resolution'
  | 'runbook_fact'
  | 'rejected_hypothesis'
  | 'entity_fact';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'observation',
  'resolution',
  'runbook_fact',
  'rejected_hypothesis',
  'entity_fact',
] as const;

/**
 * Whether the search that produced a result actually covered the memory it claims to have searched.
 *
 * COVERED  the search ran over everything it was meant to.
 * PARTIAL  the search ran but was cut short by a cap or a deadline. Results are real but incomplete.
 * UNKNOWN  the search could not be completed. An empty result under UNKNOWN means nothing at all.
 *
 * UNKNOWN is the whole point. Every other memory system collapses it into an empty list, and an
 * empty list reads as "there is nothing", which is a different and much more dangerous claim.
 */
export type Coverage = 'COVERED' | 'PARTIAL' | 'UNKNOWN';

/** Which retrieval strategy actually executed. Reported, never assumed. */
export type RetrievalPath = 'ann_index' | 'exact_scan' | 'none';

/**
 * Which stage of a recall stopped it, as a value rather than as a sentence.
 *
 * Exists so that a caller can say WHY a search did not run without quoting whatever threw. The
 * stages are the ones `runRecall` actually catches, in the order it meets them, and each maps to
 * exactly one `catch` block so a new failure mode cannot quietly reuse an existing label.
 */
export type CoverageCause =
  | 'no_retrieval_path'
  | 'embedder_failed'
  | 'exclusion_counts_failed'
  | 'candidate_query_failed'
  | 'scoring_failed';

/** Named reasons a candidate was dropped. Every exclusion is counted and attributed. */
export type ExclusionRule =
  | 'superseded'
  | 'tombstoned'
  | 'outside_validity_window'
  | 'below_similarity_floor'
  | 'not_embedded'
  | 'candidate_cap_reached';

export interface Exclusion {
  readonly rule: ExclusionRule;
  readonly count: number;
}

/**
 * Where a memory came from. A write without this is rejected at the boundary rather than warned
 * about, because a memory you cannot attribute is a rumour.
 */
export interface Provenance {
  /** Who or what asserted it. For example `human:oncall-ana`, `agent`, `alert:cloudwatch`. */
  readonly assertedBy: string;
  /** The incident this came out of, when there was one. */
  readonly incidentId: string | null;
  /** A pointer back to the original artifact: a message id, a URL, a log line reference. */
  readonly sourceRef: string | null;
}

export interface MemoryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly provenance: Provenance;
  readonly createdAt: Date;
  /** Last time something confirmed this was still true. Drives decay alongside createdAt. */
  readonly lastConfirmedAt: Date;
  readonly confirmCount: number;
  readonly contradictCount: number;
  /** The interval over which this is claimed to hold. `validUntil` is set when it is superseded. */
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  /** The memory that replaced this one, if any. The old row stays queryable on purpose. */
  readonly supersededBy: string | null;
  /** Before this instant the row cannot be evicted at any score. The grace window. */
  readonly protectedUntil: Date;
  readonly evictedAt: Date | null;
  readonly evictionReason: string | null;
}

/** A memory plus the deterministic numbers that ordered it. Both are shown to the user. */
export interface ScoredMemory {
  readonly memory: MemoryRecord;
  /** Cosine similarity to the query embedding, in [0, 1] after normalisation. */
  readonly similarity: number;
  /** Time decay for this memory's kind, in (0, 1]. 1 means brand new. */
  readonly freshness: number;
  /** The single number that ordered the results. Computed in code, never by a model. */
  readonly score: number;
  /**
   * True when freshness has fallen past this kind's floor. The row is still returned, flagged,
   * because a stale memory a human can see is safer than one that quietly vanished.
   */
  readonly stale: boolean;
}

/**
 * What actually happened during a recall. Returned with every result, never optional.
 */
export interface RecallReceipt {
  readonly query: string;
  readonly workspaceId: string;
  readonly requestedAt: Date;
  readonly elapsedMs: number;
  readonly retrievalPath: RetrievalPath;
  /** How many rows were examined before filtering. Zero with COVERED means the store is empty. */
  readonly candidatesConsidered: number;
  readonly returned: number;
  readonly exclusions: readonly Exclusion[];
  readonly coverage: Coverage;
  /**
   * Always populated, in plain language. For UNKNOWN this is the only useful prose field.
   *
   * WRITTEN FROM SCRATCH, ALWAYS. No caught error's message is ever interpolated into it, and that
   * is a security boundary rather than a style preference. This receipt is rendered into a
   * `tool_result`, `/agent/turn` returns the whole transcript on a 200, and the console prints it
   * on a screen that gets recorded. A review reproduced a role ARN reaching a caller through
   * exactly this field, twice: once from an embedder rejection and once from a capability probe on
   * a COVERED turn with nothing wrong. Both controls live in `apps/api/test/server.test.ts`.
   *
   * What a reader loses is the driver's own words. What they get instead is `coverageCause`, which
   * says which stage failed and is a value rather than a sentence, so a console can branch on it
   * and an operator knows where to look.
   */
  readonly coverageReason: string;
  /**
   * Which stage stopped the search, as a value.
   *
   * `null` whenever the search completed, which includes a COVERED empty result: nothing stopped,
   * there was simply nothing to find. A cause is never inferred from the prose.
   */
  readonly coverageCause: CoverageCause | null;
  /**
   * Capabilities that were expected and were not available, in the words a human needs.
   * An empty list means nothing degraded, not that nothing was checked.
   */
  readonly degradations: readonly string[];
}

/**
 * The only shape recall returns. Memories and receipt travel together so that no caller can read
 * one without the other.
 */
export interface RecallResult {
  readonly memories: readonly ScoredMemory[];
  readonly receipt: RecallReceipt;
}

/**
 * One capability check.
 *
 * A tri-state rather than a value that might be null, because "checked, and it is absent" and
 * "could not check" are different facts and a boolean collapses them into the same `false`. That
 * collapse is the failure this whole product exists to argue against, so the type that describes
 * the system's own capabilities is the last place it should be tolerated.
 */
export type Observation<Value> =
  | { readonly status: 'observed'; readonly value: Value }
  | { readonly status: 'unknown'; readonly reason: string };

export function observed<Value>(value: Value): Observation<Value> {
  return { status: 'observed', value };
}

export function unknown<Value>(reason: string): Observation<Value> {
  return { status: 'unknown', reason };
}

/** What the capability probe observed on a live database. Observations, never assumptions. */
export interface Capabilities {
  readonly observedAt: Date;
  readonly target: string;
  readonly serverVersion: Observation<string>;
  /** Whether a vector index exists on the memory table's embedding column. */
  readonly vectorIndex: Observation<boolean>;
  /**
   * Whether the planner actually chooses that index for the query recall runs.
   *
   * A separate claim from existence, and the only one that predicts query time behaviour. An index
   * can exist and be ignored, and reporting existence as proof of use is the same mistake as
   * trusting a tool's success response instead of looking at the system.
   */
  readonly annPlanUsesIndex: Observation<boolean>;
  /** The dimension the column is actually declared with, read from the catalog. */
  readonly vectorColumnDimensions: Observation<number>;
  /** The dimension the configured embedder actually produces, measured by embedding a probe string. */
  readonly embedderDimensions: Observation<number>;
  /**
   * Whether this cluster reports vector indexing as enabled.
   *
   * Kept separate from `vectorIndex` because they answer different questions: one is "may this
   * cluster have such an index", the other is "does this table have one". On a managed tier the
   * first can be refused outright, and conflating them would report a permission problem as a
   * missing index.
   */
  readonly vectorIndexingEnabled: Observation<boolean>;
}
