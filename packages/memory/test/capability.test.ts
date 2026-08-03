import { describe, expect, it } from 'vitest';
import { retrievalPathFor } from '../src/capability.ts';
import { observed, unknown, type Capabilities, type Observation } from '../src/types.ts';

const capabilities = (overrides: Partial<Capabilities> = {}): Capabilities => ({
  observedAt: new Date('2026-08-03T12:00:00Z'),
  target: 'cluster.example.cloud:26257/defaultdb schema=throughline',
  serverVersion: observed('CockroachDB CCL v26.2.1'),
  vectorColumnDimensions: observed(1024),
  embedderDimensions: observed(1024),
  vectorIndex: observed(true),
  annPlanUsesIndex: observed(true),
  vectorIndexingEnabled: observed(true),
  ...overrides,
});

describe('retrievalPathFor', () => {
  it('uses the index when the PLANNER says it does, not merely when one exists', () => {
    const result = retrievalPathFor(capabilities());
    expect(result.path).toBe('ann_index');
    expect(result.reason).toMatch(/planner uses the vector index/i);
  });

  it('falls back to an exact scan when an index exists but the planner ignores it', () => {
    // Measured on a live cluster: an index on the vector column alone is ignored for the filtered
    // query recall runs, because CockroachDB only accelerates on prefix columns. Existence is not
    // use, and reporting existence as use would claim a speed the system does not have.
    const result = retrievalPathFor(
      capabilities({ vectorIndex: observed(true), annPlanUsesIndex: observed(false) }),
    );
    expect(result.path).toBe('exact_scan');
    expect(result.reason).toMatch(/exists but the planner is not using it/i);
  });

  it('falls back to an exact scan when no index exists at all, and says so differently', () => {
    const result = retrievalPathFor(
      capabilities({ vectorIndex: observed(false), annPlanUsesIndex: observed(false) }),
    );
    expect(result.path).toBe('exact_scan');
    expect(result.reason).toMatch(/no vector index exists/i);
  });

  it('distinguishes an unreadable plan from a plan that declines the index', () => {
    const unreadable = retrievalPathFor(
      capabilities({ annPlanUsesIndex: unknown('EXPLAIN was refused') }),
    );
    const declined = retrievalPathFor(
      capabilities({ vectorIndex: observed(false), annPlanUsesIndex: observed(false) }),
    );
    expect(unreadable.path).toBe('exact_scan');
    expect(unreadable.reason).toMatch(/could not be read/i);
    expect(unreadable.reason).not.toBe(declined.reason);
  });

  it('refuses any retrieval when the column and the embedder disagree on width', () => {
    // Not a degraded answer, a meaningless one: vectors of different widths are not comparable.
    // `none` is what makes recall report coverage UNKNOWN rather than returning nonsense.
    const result = retrievalPathFor(
      capabilities({ vectorColumnDimensions: observed(1024), embedderDimensions: observed(1536) }),
    );
    expect(result.path).toBe('none');
    expect(result.reason).toMatch(/1024/);
    expect(result.reason).toMatch(/1536/);
    expect(result.reason).toMatch(/meaningless/i);
  });

  it.each([
    ['the column could not be inspected', { vectorColumnDimensions: unknown<number>('no such table') }],
    ['the embedder could not be measured', { embedderDimensions: unknown<number>('provider timed out') }],
  ])('refuses any retrieval when %s', (_label, override) => {
    const result = retrievalPathFor(capabilities(override as Partial<Capabilities>));
    expect(result.path).toBe('none');
  });

  it('never returns an empty reason, whatever the combination', () => {
    // The reason is what a receipt shows a human. An empty one is the same as no explanation.
    const values: Observation<boolean>[] = [observed(true), observed(false), unknown('nope')];
    for (const vectorIndex of values) {
      for (const annPlanUsesIndex of values) {
        const result = retrievalPathFor(capabilities({ vectorIndex, annPlanUsesIndex }));
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
