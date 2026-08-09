/**
 * The memory layer's public surface.
 *
 * Note what is NOT exported: no function here returns a SET of memories without the receipt that says
 * whether the read ran. That absence is the design. `recall` returns a `RecallResult` and `list`
 * returns a `MemoryPage`, and neither has an overload handing back the rows alone.
 *
 * `list` is why this says "read" rather than "search". Browsing the archive is where that rule is
 * easiest to abandon, since a page of rows feels like plain data in a way a ranked search does not.
 * It is not: an empty archive and an archive whose query timed out are the same empty array.
 *
 * THE ONE EXCEPTION IS `getById`, and it is named here because a review caught this docblock claiming
 * otherwise. It returns `MemoryRecord | null` with no receipt, so its `null` really is the ambiguous
 * "not there, or could not look" value the rest of the package designs away. It is defensible for a
 * single known id, where the caller supplied the id and a missing row is a different question from a
 * failed search, but it IS an exception rather than an instance of the rule. Saying "a set of
 * memories" is the honest scope; the earlier wording said "memories" and was false.
 */

export type {
  Capabilities,
  Coverage,
  CoverageCause,
  Exclusion,
  ExclusionRule,
  ListFailureCause,
  MemoryKind,
  MemoryListReceipt,
  MemoryPage,
  MemoryRecord,
  MemoryState,
  Observation,
  Provenance,
  RecallReceipt,
  RecallResult,
  RetrievalPath,
  ScoredMemory,
} from './types.ts';
export { MEMORY_KINDS, observed, unknown } from './types.ts';

export { memoryState } from './lifecycle.ts';

export type { DatabaseConfig, EmbeddingConfig } from './config.ts';
export {
  ConfigError,
  describeTarget,
  loadDatabaseConfig,
  loadEmbeddingConfig,
  redact,
  SCHEMA_IDENTIFIER,
  secretsOf,
} from './config.ts';

export type { Database } from './db.ts';
export { createDatabase, DatabaseError, quoteIdentifier } from './db.ts';

export type { CleanupOutcome, CleanupRequest } from './cleanup.ts';
export { deleteWorkspaceRows, WORKSPACE_TABLES } from './cleanup.ts';

export type { Migration, MigrationOutcome, MigrationReport, MigrationStatus } from './migrate.ts';
export { checksumOf, loadMigrations, MigrationDriftError, runMigrations } from './migrate.ts';

export { splitStatements } from './sql-statements.ts';

export type { ProbeOptions } from './capability.ts';
export { probeCapabilities, retrievalPathFor } from './capability.ts';

export type { MemoryRow } from './rows.ts';
export { formatVector, parseVector, rowToMemory } from './rows.ts';

export type {
  EvictionOutcome,
  ListQuery,
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

export type { Embedder, EmbeddingPurpose } from './embeddings.ts';
export { createLocalEmbedder, embedSync } from './embeddings.ts';
