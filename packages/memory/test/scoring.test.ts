import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DEFAULT_POLICY, MS_PER_DAY } from '../src/policy.ts';
import {
  clamp,
  cosineSimilarity,
  freshness,
  isStale,
  saturate,
  scoreMemory,
} from '../src/scoring.ts';

const at = (isoDays: number): Date => new Date(Date.UTC(2026, 0, 1) + isoDays * MS_PER_DAY);
const NOW = at(400);

describe('freshness', () => {
  it('is exactly one half at exactly one half-life, for every kind', () => {
    // Pinning the exact value rather than a range: the point of an exponential with a named
    // half-life is that anyone can check it by hand, and a range assertion hides a wrong curve.
    for (const [kind, halfLifeDays] of Object.entries(DEFAULT_POLICY.halfLifeDays)) {
      const lastConfirmedAt = new Date(NOW.getTime() - halfLifeDays * MS_PER_DAY);
      const value = freshness(kind as never, lastConfirmedAt, NOW, DEFAULT_POLICY);
      expect(value, `${kind} at one half-life`).toBeCloseTo(0.5, 10);
    }
  });

  it('is a quarter at two half-lives', () => {
    const halfLife = DEFAULT_POLICY.halfLifeDays.entity_fact;
    const lastConfirmedAt = new Date(NOW.getTime() - 2 * halfLife * MS_PER_DAY);
    expect(freshness('entity_fact', lastConfirmedAt, NOW, DEFAULT_POLICY)).toBeCloseTo(0.25, 10);
  });

  it('treats a future timestamp as brand new rather than better than new', () => {
    // Clock skew between an ingest host and the database must never manufacture confidence above
    // what a just-written memory gets.
    const future = new Date(NOW.getTime() + 30 * MS_PER_DAY);
    expect(freshness('observation', future, NOW, DEFAULT_POLICY)).toBe(1);
  });

  it('ranks kinds in the intended order at the same age', () => {
    const oneYearAgo = new Date(NOW.getTime() - 365 * MS_PER_DAY);
    const value = (kind: Parameters<typeof freshness>[0]): number =>
      freshness(kind, oneYearAgo, NOW, DEFAULT_POLICY);

    expect(value('rejected_hypothesis')).toBeGreaterThan(value('resolution'));
    expect(value('resolution')).toBeGreaterThan(value('runbook_fact'));
    expect(value('runbook_fact')).toBeGreaterThan(value('observation'));
    expect(value('observation')).toBeGreaterThan(value('entity_fact'));
  });

  it('refuses a kind with no half-life instead of inventing one', () => {
    const brokenPolicy = { ...DEFAULT_POLICY, halfLifeDays: { ...DEFAULT_POLICY.halfLifeDays } };
    // @ts-expect-error deliberately removing a required entry to prove the guard fires
    delete brokenPolicy.halfLifeDays.observation;
    expect(() => freshness('observation', at(399), NOW, brokenPolicy)).toThrow(/no positive half-life/);
  });
});

describe('isStale', () => {
  it('flags below the floor and not at it', () => {
    expect(isStale(DEFAULT_POLICY.staleFloor - 0.001, DEFAULT_POLICY)).toBe(true);
    expect(isStale(DEFAULT_POLICY.staleFloor, DEFAULT_POLICY)).toBe(false);
  });
});

describe('saturate', () => {
  it.each([
    [0, 0],
    [1, 0.5],
    [3, 0.75],
  ])('saturate(%i) is %f', (count, expected) => {
    expect(saturate(count)).toBeCloseTo(expected, 10);
  });

  it('never reaches one, so evidence cannot be farmed', () => {
    expect(saturate(1_000_000)).toBeLessThan(1);
  });

  it('treats negative and non-finite counts as no evidence', () => {
    expect(saturate(-5)).toBe(0);
    expect(saturate(Number.NaN)).toBe(0);
  });
});

describe('scoreMemory', () => {
  it('weights contradiction more heavily than confirmation', () => {
    // Acting on a contradicted memory during an incident costs more than ranking a good one third,
    // so doubt has to sink a row faster than agreement floats it.
    const base = { similarity: 0.8, freshness: 0.8 };
    const confirmed = scoreMemory({ ...base, confirmCount: 3, contradictCount: 0 }, DEFAULT_POLICY);
    const contradicted = scoreMemory({ ...base, confirmCount: 0, contradictCount: 3 }, DEFAULT_POLICY);
    const neutral = scoreMemory({ ...base, confirmCount: 0, contradictCount: 0 }, DEFAULT_POLICY);

    expect(confirmed - neutral).toBeGreaterThan(0);
    expect(neutral - contradicted).toBeGreaterThan(confirmed - neutral);
  });

  it('is monotonic in similarity', () => {
    const score = (similarity: number): number =>
      scoreMemory({ similarity, freshness: 0.5, confirmCount: 1, contradictCount: 0 }, DEFAULT_POLICY);
    expect(score(0.9)).toBeGreaterThan(score(0.5));
    expect(score(0.5)).toBeGreaterThan(score(0.1));
  });

  it('stays inside [0, 1] for any input, including hostile ones', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        (similarity, freshnessValue, confirmCount, contradictCount) => {
          const score = scoreMemory(
            { similarity, freshness: freshnessValue, confirmCount, contradictCount },
            DEFAULT_POLICY,
          );
          return score >= 0 && score <= 1 && Number.isFinite(score);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('cosineSimilarity', () => {
  it('maps identical vectors to one and opposite vectors to zero', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(0, 10);
  });

  it('maps orthogonal vectors to the midpoint', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.5, 10);
  });

  it('throws on a dimension mismatch rather than comparing a truncated pair', () => {
    // A silently wrong similarity is worse than a loud failure: it produces confident ranking from
    // vectors that were never comparable, which is what an unmigrated embedding change looks like.
    expect(() => cosineSimilarity([1, 0, 0], [1, 0])).toThrow(/different dimensions/);
  });

  it('throws on empty vectors', () => {
    expect(() => cosineSimilarity([], [])).toThrow(/empty vectors/);
  });

  it('returns zero for a zero vector instead of dividing by zero', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('clamp', () => {
  it('sends NaN to the low bound rather than propagating it', () => {
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
  });
});

describe('the similarity floor is scaled to the space cosineSimilarity returns', () => {
  it('sits above the orthogonal midpoint, so it can actually exclude something', () => {
    // cosineSimilarity remaps a raw cosine to (cosine + 1) / 2, so orthogonal vectors land on 0.5
    // and text embedders, which rarely produce negative cosines, occupy roughly 0.5 to 1. A floor
    // at or below 0.5 therefore excludes NOTHING while looking exactly like a working filter, and
    // the exclusion count it feeds would sit at zero forever.
    const orthogonal = cosineSimilarity([1, 0], [0, 1]);
    expect(orthogonal).toBeCloseTo(0.5, 10);
    expect(DEFAULT_POLICY.similarityFloor).toBeGreaterThan(orthogonal);
  });

  it('still admits a close but not identical match', () => {
    // Deliberately NOT two identical vectors. Identical vectors score exactly 1, which clears any
    // floor below 1, so that version of this test would pass for a floor of 0.35 or 0.99 alike and
    // guard nothing. This pair has a raw cosine of about 0.71, remapping to about 0.85.
    const similarity = cosineSimilarity([1, 1, 0], [1, 0, 0]);
    expect(similarity).toBeLessThan(1);
    expect(similarity).toBeGreaterThan(DEFAULT_POLICY.similarityFloor);
  });

  it('rejects a genuinely unrelated pair', () => {
    // The other half of the boundary: a floor that admits everything is the failure being fixed,
    // and a floor that admits nothing would be just as useless.
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeLessThan(DEFAULT_POLICY.similarityFloor);
  });
});
