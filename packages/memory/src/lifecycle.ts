import type { MemoryRecord, MemoryState } from './types.ts';

/**
 * Where a row sits in its own history, derived from the row rather than stored beside it.
 *
 * ONE DEFINITION, because two callers need this decision and this repository has already paid for
 * the alternative twice: when two code paths must make the same judgement, the judgement goes in a
 * module they both import, and a comment asking a reader to keep them in step does not stop drift.
 * The HTTP mapper needs it to label a strip and the archive page needs it to choose a holder
 * colour, so it lives here and neither of them re-derives it.
 *
 * `is_live` in the database is NOT this function. That column is `evicted_at IS NULL`, a stored
 * computed column, and it says nothing about supersession: a superseded row is still live and still
 * queryable, which is the entire point of superseding rather than overwriting. So a caller that
 * needs the three-way distinction cannot get it from `is_live`, and one that filters on `is_live`
 * is asking a different question.
 */

/**
 * Tombstoned WINS over superseded when a row is both, and the precedence is a decision rather than
 * an accident of ordering.
 *
 * A row can be superseded in June and evicted by the sweep in August, so both fields are set and
 * both facts are true. The label answers "why is this not the current answer", and eviction is the
 * stronger reason: a superseded row is still returned to a recall as an excluded candidate, while a
 * tombstoned one has left the live set altogether.
 *
 * Nothing is hidden by the choice. `supersededBy`, `evictedAt` and `evictionReason` all travel with
 * the row independently of this label, so a reader who needs the other half of the history has it.
 */
export function memoryState(
  memory: Pick<MemoryRecord, 'evictedAt' | 'supersededBy'>,
): MemoryState {
  if (memory.evictedAt !== null) return 'tombstoned';
  if (memory.supersededBy !== null) return 'superseded';
  return 'current';
}
