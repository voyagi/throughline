/**
 * Builders for the agent tests.
 *
 * One definition of each shape rather than a copy per test file, for the reason the memory package
 * already learned with its insert path: two builders that must produce the same shape drift, and
 * the drift shows up as a test that passes against a record production never emits.
 *
 * The repository stub REFUSES every method it was not given. A stub that quietly returns a default
 * lets a test assert on a call it never made, which is the shape of a test double being kinder than
 * production, and that has cost this repository 107 green tests over a broken client once already.
 */

import { DEFAULT_POLICY } from '@throughline/memory';
import type {
  Coverage,
  CoverageCause,
  Exclusion,
  ListFailureCause,
  MemoryKind,
  MemoryPage,
  MemoryRecord,
  MemoryRepository,
  RecallResult,
  RetrievalPath,
  ScoredMemory,
} from '@throughline/memory';

/** Valid v4 UUIDs, because the tool schemas refuse anything that merely looks like an id. */
export const MEMORY_ID_A = '11111111-1111-4111-8111-111111111111';
export const MEMORY_ID_B = '22222222-2222-4222-8222-222222222222';
export const MEMORY_ID_C = '33333333-3333-4333-8333-333333333333';

const FIXED_NOW = new Date('2026-08-05T12:00:00.000Z');

export function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: MEMORY_ID_A,
    workspaceId: 'demo',
    kind: 'resolution',
    content: 'Restarting the checkout pods cleared the latency spike.',
    provenance: { assertedBy: 'human:oncall-ana', incidentId: 'INC-42', sourceRef: null },
    createdAt: FIXED_NOW,
    lastConfirmedAt: FIXED_NOW,
    confirmCount: 0,
    contradictCount: 0,
    validFrom: FIXED_NOW,
    validUntil: null,
    supersededBy: null,
    protectedUntil: FIXED_NOW,
    evictedAt: null,
    evictionReason: null,
    ...overrides,
  };
}

export function scoredMemory(overrides: Partial<ScoredMemory> = {}): ScoredMemory {
  return {
    memory: memoryRecord(),
    similarity: 0.87,
    freshness: 0.9,
    score: 0.78,
    stale: false,
    ...overrides,
  };
}

export interface RecallResultOptions {
  readonly coverage?: Coverage;
  readonly coverageReason?: string;
  readonly coverageCause?: CoverageCause | null;
  readonly memories?: readonly ScoredMemory[];
  readonly retrievalPath?: RetrievalPath;
  readonly candidatesConsidered?: number;
  readonly exclusions?: readonly Exclusion[];
  readonly degradations?: readonly string[];
}

export function recallResult(options: RecallResultOptions = {}): RecallResult {
  const coverage = options.coverage ?? 'COVERED';
  const memories = options.memories ?? [];
  return {
    memories,
    receipt: {
      query: 'checkout latency',
      workspaceId: 'demo',
      requestedAt: FIXED_NOW,
      elapsedMs: 12,
      retrievalPath: options.retrievalPath ?? (coverage === 'UNKNOWN' ? 'none' : 'ann_index'),
      candidatesConsidered: options.candidatesConsidered ?? memories.length,
      returned: memories.length,
      exclusions: options.exclusions ?? [],
      coverage,
      coverageReason: options.coverageReason ?? 'the search ran over the whole workspace',
      // Mirrors what `runRecall` does: a cause exists only when a stage stopped the search, and
      // UNKNOWN is the only verdict a stopped stage can produce.
      coverageCause: options.coverageCause ?? (coverage === 'UNKNOWN' ? 'embedder_failed' : null),
      degradations: options.degradations ?? [],
    },
  };
}

export interface MemoryPageOptions {
  readonly memories?: readonly MemoryRecord[];
  readonly coverage?: Coverage;
  readonly coverageReason?: string;
  readonly coverageCause?: ListFailureCause | null;
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
}

/**
 * A listing, built the way `runList` builds one.
 *
 * The `coverageCause` default mirrors the real thing rather than being convenient: a cause exists
 * only when a stage stopped the listing, so it is null for COVERED and for PARTIAL. PARTIAL is a
 * bound that was reached, not a failure, and a fixture that attached a cause to it would let a test
 * pass against a console that rendered "stopped by" over a page that ran perfectly.
 */
export function memoryPage(options: MemoryPageOptions = {}): MemoryPage {
  const memories = options.memories ?? [];
  const coverage = options.coverage ?? 'COVERED';
  return {
    memories,
    receipt: {
      workspaceId: 'demo',
      requestedAt: FIXED_NOW,
      elapsedMs: 4,
      kinds: options.kinds ?? [],
      limit: options.limit ?? DEFAULT_POLICY.listCap,
      returned: memories.length,
      coverage,
      coverageReason: options.coverageReason ?? 'every row matching this filter fitted inside the bound',
      coverageCause: options.coverageCause ?? (coverage === 'UNKNOWN' ? 'listing_query_failed' : null),
    },
  };
}

export interface RepositoryStubs {
  readonly recall?: MemoryRepository['recall'];
  readonly list?: MemoryRepository['list'];
  readonly remember?: MemoryRepository['remember'];
  readonly supersede?: MemoryRepository['supersede'];
  readonly evict?: MemoryRepository['evict'];
  readonly getById?: MemoryRepository['getById'];
}

export function fakeRepository(stubs: RepositoryStubs = {}): MemoryRepository {
  const refuse = (name: string) => (): Promise<never> =>
    Promise.reject(new Error(`${name} was called, and this test did not stub it`));

  return {
    recall: stubs.recall ?? refuse('recall'),
    list: stubs.list ?? refuse('list'),
    remember: stubs.remember ?? refuse('remember'),
    supersede: stubs.supersede ?? refuse('supersede'),
    evict: stubs.evict ?? refuse('evict'),
    getById: stubs.getById ?? refuse('getById'),
  };
}

/** A repository whose recall always returns the given result. The most common stub by far. */
export function repositoryReturning(...results: readonly RecallResult[]): MemoryRepository {
  let index = 0;
  return fakeRepository({
    recall: () => {
      const next = results[Math.min(index, results.length - 1)];
      index += 1;
      if (!next) return Promise.reject(new Error('repositoryReturning was given no results'));
      return Promise.resolve(next);
    },
  });
}
