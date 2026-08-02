import type { MemoryKind } from './types.ts';
import { MS_PER_DAY, type MemoryPolicy } from './policy.ts';

/**
 * The deterministic half of recall. Pure functions, no clock, no database, no model.
 *
 * `now` is always a parameter rather than a call to the system clock. That is what makes these
 * functions testable at an exact instant, and it is why a decay test can pin a number rather than
 * asserting a range and hoping.
 */

export function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * Time decay: what fraction of its original confidence a memory of this kind still carries.
 *
 * Exponential with a per-kind half-life, so freshness(oneHalfLife) is exactly 0.5 and the number
 * has a meaning anyone can check by hand. Ages before the reference instant are treated as brand
 * new rather than as freshness above 1: a clock skew must not manufacture confidence.
 */
export function freshness(
  kind: MemoryKind,
  lastConfirmedAt: Date,
  now: Date,
  policy: MemoryPolicy,
): number {
  const halfLifeDays = policy.halfLifeDays[kind];
  if (!(halfLifeDays > 0)) {
    throw new Error(
      `Memory kind "${kind}" has no positive half-life in the policy. ` +
        `Add one to policy.halfLifeDays before recalling memories of this kind.`,
    );
  }
  const ageMs = now.getTime() - lastConfirmedAt.getTime();
  if (ageMs <= 0) return 1;
  const ageDays = ageMs / MS_PER_DAY;
  return clamp(Math.pow(0.5, ageDays / halfLifeDays), 0, 1);
}

/** Past one half-life for its kind, a memory is flagged rather than dropped. */
export function isStale(freshnessValue: number, policy: MemoryPolicy): boolean {
  return freshnessValue < policy.staleFloor;
}

/**
 * Saturating support from repeated evidence: one confirmation matters a lot, the tenth barely
 * moves the number. Linear counting would let a chatty integration outrank a human.
 */
export function saturate(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return 1 - 1 / (1 + count);
}

export interface ScoreInputs {
  readonly similarity: number;
  readonly freshness: number;
  readonly confirmCount: number;
  readonly contradictCount: number;
}

/**
 * The single number that orders recall results.
 *
 *   score = w_sim * similarity
 *         + w_fresh * freshness
 *         + w_confirm * saturate(confirmations)
 *         - w_contradict * saturate(contradictions)
 *
 * Contradiction is weighted heavier than confirmation on purpose. Evidence that something is
 * wrong should sink it faster than agreement floats it, because during an incident the cost of
 * acting on a contradicted memory is far higher than the cost of ranking a good one third.
 *
 * The result is clamped to [0, 1] so it can be displayed as a confidence without further scaling.
 */
export function scoreMemory(inputs: ScoreInputs, policy: MemoryPolicy): number {
  const { similarity, freshness: freshnessValue, confirmCount, contradictCount } = inputs;
  const weights = policy.weights;
  const raw =
    weights.similarity * clamp(similarity, 0, 1) +
    weights.freshness * clamp(freshnessValue, 0, 1) +
    weights.confirmation * saturate(confirmCount) -
    weights.contradiction * saturate(contradictCount);
  return clamp(raw, 0, 1);
}

/**
 * Cosine similarity mapped into [0, 1], because a raw cosine in [-1, 1] displayed as a percentage
 * is a reliable way to confuse everyone reading the receipt.
 *
 * Throws on a dimension mismatch rather than returning a plausible number from a truncated
 * comparison. A silently wrong similarity is worse than a loud failure: it produces confident
 * ranking from vectors that were never comparable.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Cannot compare vectors of different dimensions (${a.length} and ${b.length}). ` +
        `This usually means the embedding model changed without the column being migrated.`,
    );
  }
  if (a.length === 0) {
    throw new Error('Cannot compare empty vectors.');
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] as number;
    const right = b[i] as number;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return clamp((cosine + 1) / 2, 0, 1);
}
