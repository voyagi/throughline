import { describe, expect, it } from 'vitest';
import { memoryState } from '../src/lifecycle.ts';

/**
 * The precedence in `memoryState` had no test at all until a review planted the flip and watched the
 * whole suite stay green at 790/790.
 *
 * That mattered more than a mislabelled stamp. `Archive.tsx` gates the entire tombstone row on
 * `state === 'tombstoned'`, so a row labelled `superseded` by mistake loses its eviction DATE and its
 * eviction REASON from the archive page: a data-hiding regression on the page whose whole argument is
 * that nothing is hidden.
 *
 * The both-set state is reachable in production rather than hypothetical. `is_live` is
 * `evicted_at IS NULL`, `evict` selects `WHERE workspace_id = $1 AND is_live` with no supersession
 * filter, and `EvictionCandidate` carries nothing for `planEviction` to filter on. So a row
 * superseded in June is a live candidate the August sweep tombstones, and both fields end up set.
 */
describe('memoryState', () => {
  it('reads a row nothing has touched as current', () => {
    // `current` means unreplaced and unevicted. It does NOT mean verified as correct, which is a
    // claim about the world rather than about the archive.
    expect(memoryState({ evictedAt: null, supersededBy: null })).toBe('current');
  });

  it('reads a replaced row as superseded', () => {
    expect(
      memoryState({ evictedAt: null, supersededBy: '11111111-1111-4111-8111-111111111111' }),
    ).toBe('superseded');
  });

  it('reads an evicted row as tombstoned', () => {
    expect(memoryState({ evictedAt: new Date('2026-08-04T00:00:00Z'), supersededBy: null })).toBe(
      'tombstoned',
    );
  });

  // THE CASE THE DOCBLOCK IS ABOUT. Both facts are true, and the label answers "why is this not the
  // current answer": eviction is the stronger reason, because a superseded row is still returned to a
  // recall as an excluded candidate while a tombstoned one has left the live set.
  it('calls a row that was superseded AND then evicted a tombstone, not a supersession', () => {
    expect(
      memoryState({
        evictedAt: new Date('2026-08-04T00:00:00Z'),
        supersededBy: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe('tombstoned');
  });
});
