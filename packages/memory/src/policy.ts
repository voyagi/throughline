import type { MemoryKind } from './types.ts';

/**
 * Every tunable number in the memory layer, in one place, with the reasoning attached.
 *
 * These are DEFAULTS, and the defaults are informed guesses. They are written down here rather
 * than scattered through the code so that when real usage argues with one of them, there is a
 * single thing to change and a single place where the old reasoning is visible.
 *
 * Nothing here is produced by a language model at runtime. The model writes the narrative around
 * a result. It never produces the number that ordered the result.
 */
export interface MemoryPolicy {
  /**
   * How long it takes for a memory of each kind to lose half its freshness.
   *
   * The spread is the interesting part, and it is the reason `kind` exists at all:
   *
   * - `entity_fact` decays fastest. "The primary is db-7" is exactly the sort of thing that is
   *   true on Tuesday and dangerously wrong on Friday.
   * - `observation` is a single reading. It ages, but it was true when recorded.
   * - `runbook_fact` should be durable, and usually is, right up until a migration silently
   *   invalidates it. Ninety days is short enough to force reconfirmation.
   * - `resolution` is what actually fixed something. Worth keeping.
   * - `rejected_hypothesis` decays slowest of all. "Restarting the pods did not help" stays true
   *   more or less forever, and it is the cheapest thing an on-call engineer can be told.
   */
  readonly halfLifeDays: Readonly<Record<MemoryKind, number>>;

  /**
   * Below this freshness a memory is FLAGGED stale. It is still returned. Hiding it would remove
   * the human's ability to notice that the system is running on old information.
   *
   * 0.5 means "older than one half-life for its kind".
   */
  readonly staleFloor: number;

  /**
   * Similarity below this is not a weak match, it is a different subject.
   *
   * Expressed in the SAME remapped space `cosineSimilarity` returns, which is `(cosine + 1) / 2`.
   * That matters and it is easy to get wrong: orthogonal vectors land on 0.5, not 0, and text
   * embedders rarely produce negative cosines, so real similarities occupy roughly 0.5 to 1.
   * A floor below 0.5 therefore excludes NOTHING, and the exclusion count it feeds sits at zero
   * forever while looking like a working filter.
   *
   * 0.6 here corresponds to a raw cosine of 0.2.
   */
  readonly similarityFloor: number;

  /**
   * The most candidates a single recall will examine. Hitting it produces a PARTIAL coverage
   * verdict rather than a silently truncated result, which is the whole reason the cap is
   * counted rather than just applied.
   */
  readonly candidateCap: number;

  /**
   * The most rows one listing will return, whatever a caller asks for.
   *
   * A CEILING RATHER THAN A DEFAULT, and the difference matters because this one is reachable from
   * the public internet. `GET /memories` takes its bound from a query string, so without a clamp
   * here `?limit=100000` is a way to make somebody else's database build a very large result set
   * with no credentials, which is the same shape of problem the daily ceiling exists for.
   *
   * Fifty because the archive page racks strips a human reads, and a page nobody scrolls to the
   * bottom of is not more honest than a bounded one that says it was bounded. Reaching it produces
   * PARTIAL coverage rather than a silently truncated list, which is the whole reason the bound is
   * reported rather than just applied.
   */
  readonly listCap: number;

  /**
   * No memory can be evicted before this much time has passed, at any score.
   *
   * This exists because value-based eviction ranks by usage, a memory written four minutes ago
   * has no usage, and the incident that just happened is the one most likely to recur within the
   * hour. Without a grace window the newest entry is always the first eviction candidate: it gets
   * eaten by the same write that stored it.
   */
  readonly graceWindowMs: number;

  /** Weights for the deterministic score. Documented in `scoreMemory`. */
  readonly weights: {
    readonly similarity: number;
    readonly freshness: number;
    readonly confirmation: number;
    readonly contradiction: number;
  };
}

export const DEFAULT_POLICY: MemoryPolicy = {
  halfLifeDays: {
    entity_fact: 14,
    observation: 30,
    runbook_fact: 90,
    resolution: 180,
    rejected_hypothesis: 365,
  },
  staleFloor: 0.5,
  similarityFloor: 0.6,
  candidateCap: 200,
  listCap: 50,
  graceWindowMs: 24 * 60 * 60 * 1000,
  weights: {
    similarity: 0.6,
    freshness: 0.25,
    confirmation: 0.15,
    contradiction: 0.3,
  },
};

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
