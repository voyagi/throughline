/**
 * Pick the embedder from configuration, which is what makes `EMBEDDING_PROVIDER` mean something.
 *
 * SEPARATE FROM `main.ts` SO A TEST CAN REACH IT. Importing `main.ts` starts a listener by design
 * (it has no self-execution guard, and its header explains why), so a selection rule written inline
 * there would be a rule nothing could test. This is the same seam `createChatModel` gives the agent
 * side, and the two now read the same way.
 *
 * The rule both sides share: a hosted provider that cannot be built is REFUSED, never downgraded to
 * the offline one. Falling back would hand an operator hash embeddings under a name that says
 * Bedrock, and every guard downstream would stay green while recall quietly stopped meaning
 * anything.
 */

import { createLocalEmbedder, type Embedder, type EmbeddingConfig } from '@throughline/memory';
import { createBedrockEmbedder } from './bedrock-embedder.ts';

export function createEmbedder(
  config: EmbeddingConfig,
  env: Record<string, string | undefined> = process.env,
): Embedder {
  if (config.provider === 'local') return createLocalEmbedder(config.dimensions);

  // `loadEmbeddingConfig` already refuses a bedrock config with an empty model id, so this is not
  // the primary guard. It is here because `EmbeddingConfig` is a plain interface: anything can hand
  // one over, including a caller that never went through the loader, and the type says the field is
  // nullable. Refusing here keeps that promise honest rather than trusting a check made elsewhere.
  if (config.modelId === null) {
    throw new Error(
      'EMBEDDING_PROVIDER is "bedrock" but no model id was supplied. Read the real value off the ' +
        'account rather than guessing it: an id that merely APPEARS in list-foundation-models may ' +
        'still refuse on-demand invocation and demand an inference profile id instead.',
    );
  }

  const region = env['AWS_REGION']?.trim();
  if (!region) {
    throw new Error(
      'EMBEDDING_PROVIDER is "bedrock" but AWS_REGION is empty. It is read here rather than left ' +
        "to the SDK's default chain because the chain resolves silently: an unset region becomes " +
        'whatever the machine happens to be configured for, and vectors written from the wrong ' +
        'continent are a data residency problem that reports itself as a working demo.',
    );
  }

  return createBedrockEmbedder({
    modelId: config.modelId,
    dimensions: config.dimensions,
    region,
  });
}
