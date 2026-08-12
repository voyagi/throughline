import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, MS_PER_DAY } from '../src/policy.ts';
import { graceDeadline, planEviction, type EvictionCandidate } from '../src/eviction.ts';

const NOW = new Date('2026-08-02T12:00:00Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * MS_PER_DAY);
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

const candidate = (overrides: Partial<EvictionCandidate> & { id: string }): EvictionCandidate => {
  const createdAt = overrides.createdAt ?? daysAgo(30);
  return {
    score: 0.5,
    createdAt,
    protectedUntil: graceDeadline(createdAt, DEFAULT_POLICY),
    evictedAt: null,
    ...overrides,
  };
};

describe('planEviction', () => {
  it('refuses to evict a memory inside its grace window even when it scores lowest', () => {
    // This is the protection the whole eviction design exists for. A memory written four minutes
    // ago has no usage history, so a value ranking puts it first, and it is the memory most likely
    // to be needed in the next hour. Remove the grace check and this test goes red.
    const brandNew = candidate({ id: 'just-written', score: 0.01, createdAt: minutesAgo(4) });
    const old = candidate({ id: 'stale-but-used', score: 0.9, createdAt: daysAgo(200) });

    const plan = planEviction({
      candidates: [brandNew, old],
      requested: 1,
      now: NOW,
      policy: DEFAULT_POLICY,
    });

    expect(plan.evict.map((entry) => entry.id)).toEqual(['stale-but-used']);
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.id).toBe('just-written');
    expect(plan.refused[0]?.reason).toBe('within_grace_window');
  });

  it('reports a shortfall rather than reporting success when protections block the target', () => {
    // The failure mode a post-filter produces: every low scoring row is new, the eviction list
    // comes back empty, and the run reports success while the store is still full. A shortfall is
    // the operator's only signal that the store is full of memories too young to touch.
    const candidates = [
      candidate({ id: 'a', score: 0.1, createdAt: minutesAgo(1) }),
      candidate({ id: 'b', score: 0.2, createdAt: minutesAgo(2) }),
    ];

    const plan = planEviction({ candidates, requested: 2, now: NOW, policy: DEFAULT_POLICY });

    expect(plan.evict).toHaveLength(0);
    expect(plan.shortfall).toBe(true);
    expect(plan.refused).toHaveLength(2);
    expect(plan.refused.every((entry) => entry.reason === 'within_grace_window')).toBe(true);
  });

  it('does not report a shortfall when the target is met', () => {
    const candidates = [
      candidate({ id: 'a', score: 0.1, createdAt: daysAgo(50) }),
      candidate({ id: 'b', score: 0.2, createdAt: daysAgo(60) }),
    ];
    const plan = planEviction({ candidates, requested: 2, now: NOW, policy: DEFAULT_POLICY });
    expect(plan.evict).toHaveLength(2);
    expect(plan.shortfall).toBe(false);
  });

  it('evicts lowest score first', () => {
    const candidates = [
      candidate({ id: 'high', score: 0.9, createdAt: daysAgo(40) }),
      candidate({ id: 'low', score: 0.1, createdAt: daysAgo(40) }),
      candidate({ id: 'mid', score: 0.5, createdAt: daysAgo(40) }),
    ];
    const plan = planEviction({ candidates, requested: 2, now: NOW, policy: DEFAULT_POLICY });
    expect(plan.evict.map((entry) => entry.id)).toEqual(['low', 'mid']);
  });

  it('breaks score ties by age so two runs over the same data agree', () => {
    // An unstable order would make identical inputs remove different rows, which cannot be audited.
    const candidates = [
      candidate({ id: 'newer', score: 0.4, createdAt: daysAgo(10) }),
      candidate({ id: 'older', score: 0.4, createdAt: daysAgo(90) }),
    ];
    const first = planEviction({ candidates, requested: 1, now: NOW, policy: DEFAULT_POLICY });
    const second = planEviction({
      candidates: [...candidates].reverse(),
      requested: 1,
      now: NOW,
      policy: DEFAULT_POLICY,
    });
    expect(first.evict.map((entry) => entry.id)).toEqual(['older']);
    expect(second.evict).toEqual(first.evict);
  });

  it('does not mutate the caller list while sorting', () => {
    const candidates = [
      candidate({ id: 'high', score: 0.9, createdAt: daysAgo(40) }),
      candidate({ id: 'low', score: 0.1, createdAt: daysAgo(40) }),
    ];
    const order = candidates.map((entry) => entry.id);
    planEviction({ candidates, requested: 1, now: NOW, policy: DEFAULT_POLICY });
    expect(candidates.map((entry) => entry.id)).toEqual(order);
  });

  it('never re-evicts a tombstoned row, and says which rule saved it', () => {
    const tombstoned = candidate({
      id: 'gone',
      score: 0,
      createdAt: daysAgo(300),
      evictedAt: daysAgo(5),
    });
    const plan = planEviction({
      candidates: [tombstoned],
      requested: 1,
      now: NOW,
      policy: DEFAULT_POLICY,
    });
    expect(plan.evict).toHaveLength(0);
    // Counted, because one candidate went in and nothing was evicted, so exactly one refusal is the
    // claim. Reading index 0 alone would not notice the planner refusing the same row twice.
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.reason).toBe('already_evicted');
    expect(plan.shortfall).toBe(true);
  });

  it('treats a request of zero as a no-op rather than evicting everything', () => {
    const candidates = [candidate({ id: 'a', score: 0.1, createdAt: daysAgo(50) })];
    const plan = planEviction({ candidates, requested: 0, now: NOW, policy: DEFAULT_POLICY });
    expect(plan.evict).toHaveLength(0);
    expect(plan.shortfall).toBe(false);
  });

  it('protects a memory right up to the boundary and releases it at the boundary', () => {
    const createdAt = new Date(NOW.getTime() - DEFAULT_POLICY.graceWindowMs);
    const exactlyAtBoundary = candidate({ id: 'boundary', score: 0, createdAt });
    const oneMillisecondInside = candidate({
      id: 'inside',
      score: 0,
      createdAt: new Date(createdAt.getTime() + 1),
    });

    expect(
      planEviction({
        candidates: [exactlyAtBoundary],
        requested: 1,
        now: NOW,
        policy: DEFAULT_POLICY,
      }).evict,
    ).toHaveLength(1);

    expect(
      planEviction({
        candidates: [oneMillisecondInside],
        requested: 1,
        now: NOW,
        policy: DEFAULT_POLICY,
      }).evict,
    ).toHaveLength(0);
  });
});

describe('graceDeadline', () => {
  it('is the write instant plus the policy window', () => {
    const writtenAt = new Date('2026-08-02T00:00:00Z');
    expect(graceDeadline(writtenAt, DEFAULT_POLICY).toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });
});
