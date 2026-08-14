import { ConfigError, type EmbeddingConfig } from '../config.ts';
import { createLocalEmbedder, type Embedder } from '../embeddings.ts';

/**
 * The embedder these offline CLIs can build, refusing anything they cannot.
 *
 * ONE COPY, CALLED FROM THREE PLACES, because three CLIs making the same decision separately is the
 * drift this repository refuses elsewhere: the interesting failure is not all three being wrong, it
 * is two of them being fixed and the third quietly not.
 *
 * WHY A HOSTED PROVIDER IS REFUSED HERE RATHER THAN BUILT. The Bedrock adapter exists and this
 * package cannot reach it: it lives in `apps/api`, and `memory-core-is-independent` forbids this
 * package importing from there. That is a real limitation and the honest response is to say so,
 * not to substitute.
 *
 * WHAT THE SUBSTITUTION WOULD COST, since "just use the local one" reads harmless. Two of these
 * callers previously read `EMBEDDING_PROVIDER` and then built the local embedder regardless. A
 * deployment set to bedrock would have been seeded and verified with hash embeddings while the
 * server ran real ones, so the stored vectors and the query vectors would come from different
 * spaces. Nothing throws. Recall simply returns the wrong rows, every guard stays green, and the
 * receipt says COVERED. That is the exact failure this product exists to make visible.
 */
export function createOfflineEmbedder(config: EmbeddingConfig): Embedder {
  if (config.provider === 'local') return createLocalEmbedder(config.dimensions);
  throw new ConfigError(
    `EMBEDDING_PROVIDER is "${config.provider}". An adapter for it exists, but it lives in ` +
      'apps/api and this package may not import from there, so this CLI cannot build it. Re-run ' +
      'with EMBEDDING_PROVIDER=local, or use the server, which wires the hosted embedder itself. ' +
      'It is not substituted silently on purpose: seeding or verifying with a different embedder ' +
      'from the one recall uses puts two vector spaces in one column and nothing throws.',
  );
}
