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
  Observation,
  Provenance,
  RecallReceipt,
  RecallResult,
  RetrievalPath,
  ScoredMemory,
} from './types.ts';
export { MEMORY_KINDS, observed, unknown } from './types.ts';

export type { DatabaseConfig, EmbeddingConfig } from './config.ts';
export {
  ConfigError,
  describeTarget,
  loadDatabaseConfig,
  loadEmbeddingConfig,
  redact,
  secretsOf,
} from './config.ts';

export type { Database } from './db.ts';
export { createDatabase, DatabaseError, quoteIdentifier } from './db.ts';

export type { Migration, MigrationOutcome, MigrationReport, MigrationStatus } from './migrate.ts';
export { checksumOf, loadMigrations, MigrationDriftError, runMigrations } from './migrate.ts';

export { splitStatements } from './sql-statements.ts';

export type { ProbeOptions } from './capability.ts';
export { probeCapabilities, retrievalPathFor } from './capability.ts';

export type { MemoryRow } from './rows.ts';
export { formatVector, parseVector, rowToMemory } from './rows.ts';

export type {
  EvictionOutcome,
  MemoryRepository,
  RecallQuery,
  RememberInput,
  RepositoryOptions,
} from './repository.ts';
export { createRepository } from './repository.ts';

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
