import { describe, expect, it } from 'vitest';
import {
  assertAnswerable,
  CoverageUnknownError,
  decideCoverage,
  describeCoverage,
  type CoverageInputs,
} from '../src/coverage.ts';
import type { RecallResult } from '../src/types.ts';

const inputs = (overrides: Partial<CoverageInputs> = {}): CoverageInputs => ({
  retrievalFailed: false,
  failureReason: null,
  retrievalPath: 'ann_index',
  candidateCapReached: false,
  deadlineExceeded: false,
  candidatesConsidered: 12,
  ...overrides,
});

const resultWith = (coverage: RecallResult['receipt']['coverage'], reason: string): RecallResult => ({
  memories: [],
  receipt: {
    query: 'checkout latency spike',
    workspaceId: 'demo',
    requestedAt: new Date('2026-08-02T10:00:00Z'),
    elapsedMs: 8,
    retrievalPath: coverage === 'UNKNOWN' ? 'none' : 'ann_index',
    candidatesConsidered: 0,
    returned: 0,
    exclusions: [],
    coverage,
    coverageReason: reason,
    degradations: [],
  },
});

describe('decideCoverage', () => {
  // The full decision table. Every row is a state the producers can actually emit: `retrievalPath`
  // is set to 'none' by the probe when no retrieval strategy is available, `retrievalFailed` by the
  // embedder and query paths, and both caps are counted by the recall loop.
  it.each([
    ['a clean complete search', inputs(), 'COVERED'],
    ['an empty but complete search', inputs({ candidatesConsidered: 0 }), 'COVERED'],
    ['an exact scan fallback that completed', inputs({ retrievalPath: 'exact_scan' }), 'COVERED'],
    ['the candidate cap being hit', inputs({ candidateCapReached: true }), 'PARTIAL'],
    ['a deadline running out', inputs({ deadlineExceeded: true }), 'PARTIAL'],
    [
      'an outright failure',
      inputs({ retrievalFailed: true, failureReason: 'the embedding call timed out' }),
      'UNKNOWN',
    ],
    ['no retrieval path at all', inputs({ retrievalPath: 'none' }), 'UNKNOWN'],
  ])('returns %s as %s', (_label, given, expected) => {
    expect(decideCoverage(given).coverage).toBe(expected);
  });

  it('lets failure outrank an incomplete search rather than the other way round', () => {
    // A search that broke halfway through a truncated candidate set is UNKNOWN, not PARTIAL.
    // If this ordering is ever reversed, a broken search starts presenting itself as merely
    // incomplete, which is the softer and more dangerous claim.
    const verdict = decideCoverage(
      inputs({
        retrievalFailed: true,
        failureReason: 'the query was cancelled',
        candidateCapReached: true,
        deadlineExceeded: true,
      }),
    );
    expect(verdict.coverage).toBe('UNKNOWN');
  });

  it('always gives a reason, including when the caller forgot to record one', () => {
    const verdict = decideCoverage(inputs({ retrievalFailed: true, failureReason: null }));
    expect(verdict.coverage).toBe('UNKNOWN');
    expect(verdict.reason).not.toBe('');
    expect(verdict.reason).toMatch(/no reason was recorded/);
  });

  it('distinguishes an empty store from a search that did not run', () => {
    const empty = decideCoverage(inputs({ candidatesConsidered: 0 }));
    const broken = decideCoverage(
      inputs({ candidatesConsidered: 0, retrievalFailed: true, failureReason: 'connection refused' }),
    );
    expect(empty.coverage).not.toBe(broken.coverage);
    expect(empty.reason).not.toBe(broken.reason);
  });
});

describe('assertAnswerable', () => {
  it('throws on UNKNOWN so no caller can conclude absence from a failed search', () => {
    // This is the guard the whole product is built around. Delete the throw and this goes red.
    const result = resultWith('UNKNOWN', 'the embedding provider returned a 500');
    expect(() => assertAnswerable(result)).toThrow(CoverageUnknownError);
    expect(() => assertAnswerable(result)).toThrow(/the embedding provider returned a 500/);
  });

  it('carries the reason on the error, not only in the message', () => {
    try {
      assertAnswerable(resultWith('UNKNOWN', 'the index was missing'));
      expect.unreachable('assertAnswerable must throw under UNKNOWN coverage');
    } catch (error) {
      expect(error).toBeInstanceOf(CoverageUnknownError);
      expect((error as CoverageUnknownError).reason).toBe('the index was missing');
    }
  });

  it('allows a complete or incomplete search through', () => {
    expect(() => assertAnswerable(resultWith('COVERED', 'searched everything'))).not.toThrow();
    expect(() => assertAnswerable(resultWith('PARTIAL', 'hit the cap'))).not.toThrow();
  });

  // The guard is an allowlist rather than a check for the literal 'UNKNOWN', because coverage will
  // arrive from a database column or a JSON body where the union is not enforced. A denylist fails
  // OPEN on every one of these, which is the exact shape of the failure it exists to prevent.
  it.each([
    ['a lowercase variant', 'unknown'],
    ['a value from a future migration', 'DEGRADED'],
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['a number', 0],
  ])('throws on %s rather than letting it pass as answerable', (_label, rogue) => {
    const result = resultWith('COVERED', 'searched everything');
    const tampered = {
      ...result,
      receipt: { ...result.receipt, coverage: rogue as never },
    };
    expect(() => assertAnswerable(tampered)).toThrow(CoverageUnknownError);
  });
});

describe('describeCoverage', () => {
  it('never lets an UNKNOWN search sound like an empty result', () => {
    // The exact failure being prevented: an agent saying "no prior incidents" when it simply could
    // not look. The sentence is generated from the receipt so a model cannot soften it.
    const sentence = describeCoverage(resultWith('UNKNOWN', 'the query timed out'));
    expect(sentence).toMatch(/could not search memory/i);
    expect(sentence).toMatch(/not as an absence of prior incidents/i);
    expect(sentence).not.toMatch(/found nothing/i);
    expect(sentence).not.toMatch(/no relevant/i);
  });

  it('says plainly when a complete search found nothing', () => {
    const sentence = describeCoverage(resultWith('COVERED', 'the workspace holds no memories yet'));
    expect(sentence).toMatch(/searched the whole workspace and found nothing/i);
  });

  it('admits incompleteness on a partial search', () => {
    const sentence = describeCoverage(resultWith('PARTIAL', 'the candidate cap was reached'));
    expect(sentence).toMatch(/incomplete/i);
    expect(sentence).toMatch(/candidate cap/i);
  });

  it('returns a real sentence for an unrecognised coverage value, never undefined', () => {
    // Without a default arm this returns undefined while its signature promises a string, and an
    // unrecognised value then reads as no statement at all: the softest possible way to report
    // that something went wrong.
    const result = resultWith('COVERED', 'searched everything');
    const tampered = {
      ...result,
      receipt: { ...result.receipt, coverage: 'DEGRADED' as never },
    };
    const sentence = describeCoverage(tampered);
    expect(typeof sentence).toBe('string');
    expect(sentence).toMatch(/cannot state what memory coverage was/i);
    expect(sentence).toMatch(/unanswered question/i);
  });
});
