/**
 * The memory layer's public surface.
 *
 * Note what is NOT exported: there is no function anywhere in this package that returns memories
 * without the receipt that says whether the search ran. That absence is the design.
 */

export type {
  Capabilities,
  Coverage,
  Exclusion,
  ExclusionRule,
  MemoryKind,
  MemoryRecord,
  Provenance,
  RecallReceipt,
  RecallResult,
  RetrievalPath,
  ScoredMemory,
} from './types.ts';
export { MEMORY_KINDS } from './types.ts';

export type { MemoryPolicy } from './policy.ts';
export { DEFAULT_POLICY, MS_PER_DAY } from './policy.ts';

export type { ScoreInputs } from './scoring.ts';
export { clamp, cosineSimilarity, freshness, isStale, saturate, scoreMemory } from './scoring.ts';

export type { CoverageInputs, CoverageVerdict } from './coverage.ts';
export {
  assertAnswerable,
  CoverageUnknownError,
  decideCoverage,
  describeCoverage,
} from './coverage.ts';

export type {
  EvictionCandidate,
  EvictionDecision,
  EvictionPlan,
  EvictionRequest,
  Refusal,
  RefusalReason,
} from './eviction.ts';
export { graceDeadline, planEviction } from './eviction.ts';

export type { Embedder } from './embeddings.ts';
export { createLocalEmbedder, embedSync } from './embeddings.ts';
