import type { MemoryPolicy } from './policy.ts';

/**
 * Eviction planning. Pure, testable, and separated from the transaction that carries it out, so
 * the decision can be examined without a database and the database work has no policy in it.
 *
 * The failure this is built against: value-based eviction ranks by usage, a memory written four
 * minutes ago has no usage, so the newest entry is always the first candidate. During an incident
 * that is exactly backwards. The memory most likely to be needed in the next hour is the one that
 * was just written.
 */

export interface EvictionCandidate {
  readonly id: string;
  readonly score: number;
  readonly createdAt: Date;
  readonly protectedUntil: Date;
  readonly evictedAt: Date | null;
}

export type RefusalReason = 'within_grace_window' | 'already_evicted';

export interface EvictionDecision {
  readonly id: string;
  readonly score: number;
}

export interface Refusal {
  readonly id: string;
  readonly reason: RefusalReason;
  readonly detail: string;
}

export interface EvictionPlan {
  /** Rows to remove, lowest score first. */
  readonly evict: readonly EvictionDecision[];
  /**
   * Rows that were eligible by score and were kept anyway, each with the rule that saved it.
   *
   * Reporting refusals is not decoration. An eviction run that only reports removals cannot be
   * distinguished from one whose protections never fired, and a protection nobody can see is a
   * protection nobody will notice losing.
   */
  readonly refused: readonly Refusal[];
  /** How many rows the caller asked to free. */
  readonly requested: number;
  /**
   * True when protections stopped the run reaching its target. The caller has to decide what to
   * do about that, and it must not look like success.
   */
  readonly shortfall: boolean;
}

export interface EvictionRequest {
  readonly candidates: readonly EvictionCandidate[];
  readonly requested: number;
  readonly now: Date;
  readonly policy: MemoryPolicy;
}

/**
 * Decide what to evict.
 *
 * The grace window is checked BEFORE the score is consulted, and that ordering is the entire
 * protection. Checking it afterwards, as a filter on an already-chosen set, produces the same
 * result in the easy case and silently fails in the case that matters: when every low scoring row
 * is new, a post-filter returns an empty eviction list and reports success, while a pre-filter
 * reports a shortfall and tells the operator the store is full of memories too young to touch.
 */
export function planEviction(request: EvictionRequest): EvictionPlan {
  const { candidates, requested, now, policy } = request;
  void policy; // The grace window is carried on each row, stamped at write time from the policy.

  const refused: Refusal[] = [];
  const eligible: EvictionCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.evictedAt !== null) {
      refused.push({
        id: candidate.id,
        reason: 'already_evicted',
        detail: `Already evicted at ${candidate.evictedAt.toISOString()}.`,
      });
      continue;
    }
    if (now.getTime() < candidate.protectedUntil.getTime()) {
      refused.push({
        id: candidate.id,
        reason: 'within_grace_window',
        detail:
          `Written ${candidate.createdAt.toISOString()} and protected until ` +
          `${candidate.protectedUntil.toISOString()}. Too new to evict at any score.`,
      });
      continue;
    }
    eligible.push(candidate);
  }

  const ordered = [...eligible].sort(byScoreThenAge);
  const evict = ordered.slice(0, Math.max(0, requested)).map((candidate) => ({
    id: candidate.id,
    score: candidate.score,
  }));

  return {
    evict,
    refused,
    requested,
    shortfall: evict.length < requested,
  };
}

/**
 * Lowest score first. Ties break on age, oldest first, so the order is total and an eviction run
 * is reproducible from the same inputs. An unstable order would make two runs over identical data
 * remove different rows, which is impossible to audit.
 */
function byScoreThenAge(left: EvictionCandidate, right: EvictionCandidate): number {
  if (left.score !== right.score) return left.score - right.score;
  return left.createdAt.getTime() - right.createdAt.getTime();
}

/** The instant before which a memory written now cannot be evicted. */
export function graceDeadline(writtenAt: Date, policy: MemoryPolicy): Date {
  return new Date(writtenAt.getTime() + policy.graceWindowMs);
}
