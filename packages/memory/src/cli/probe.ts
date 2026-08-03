import { ConfigError, loadDatabaseConfig, loadEmbeddingConfig } from '../config.ts';
import { createDatabase } from '../db.ts';
import { probeCapabilities, retrievalPathFor } from '../capability.ts';
import { createLocalEmbedder, type Embedder } from '../embeddings.ts';
import type { Observation } from '../types.ts';

/**
 * Ask the live database what it can actually do, and print the answer without softening it.
 *
 * Every line is either an observation or an explicit unknown. Nothing here infers a capability
 * from a configuration value, which is the whole point: the configuration is what we intended, and
 * this is what is true.
 */

function render<Value>(observation: Observation<Value>): string {
  return observation.status === 'observed'
    ? String(observation.value)
    : `UNKNOWN (${observation.reason})`;
}

/**
 * Build the configured embedder.
 *
 * A hosted provider that is not implemented yet THROWS rather than quietly falling back to the
 * local one. A silent substitution would make the probe report a healthy path while measuring a
 * different embedder from the one recall would use, which is the exact class of lie this tool
 * exists to catch.
 */
function buildEmbedder(config: ReturnType<typeof loadEmbeddingConfig>): Embedder {
  if (config.provider === 'local') return createLocalEmbedder(config.dimensions);
  throw new ConfigError(
    `EMBEDDING_PROVIDER is "${config.provider}", which has no adapter yet. Set it to "local" ` +
      'until the hosted adapter lands. It is not substituted silently on purpose.',
  );
}

async function main(): Promise<void> {
  const config = loadDatabaseConfig(process.env);
  const embeddingConfig = loadEmbeddingConfig(process.env);
  const db = createDatabase(config);
  const embedder = buildEmbedder(embeddingConfig);

  try {
    const capabilities = await probeCapabilities(db, { schema: config.schema, embedder });

    console.log('');
    console.log('  Throughline capability probe');
    console.log(`  target                    ${capabilities.target}`);
    console.log(`  observed at               ${capabilities.observedAt.toISOString()}`);
    console.log(`  server version            ${render(capabilities.serverVersion)}`);
    console.log(`  vector indexing enabled   ${render(capabilities.vectorIndexingEnabled)}`);
    console.log(`  embedding column dims     ${render(capabilities.vectorColumnDimensions)}`);
    console.log(`  embedder (${embedder.id})`);
    console.log(`  embedder dims             ${render(capabilities.embedderDimensions)}`);
    console.log(`  vector index on column    ${render(capabilities.vectorIndex)}`);
    console.log(`  planner uses that index   ${render(capabilities.annPlanUsesIndex)}`);

    const retrieval = retrievalPathFor(capabilities);
    console.log('');
    console.log(`  retrieval path            ${retrieval.path.toUpperCase()}`);
    console.log(`  because                   ${retrieval.reason}`);
    console.log('');

    if (retrieval.path === 'none') {
      // Exit non-zero: with no usable retrieval path every recall returns coverage UNKNOWN, and a
      // probe that reported that state as success would be the exact failure this system argues
      // against, committed by the tool built to detect it.
      console.error('  No usable retrieval path. Recall would return UNKNOWN coverage for everything.');
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[probe] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
