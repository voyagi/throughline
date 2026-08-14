import { describe, expect, it } from 'vitest';
import type { EmbeddingConfig } from '@throughline/memory';
import { createEmbedder } from '../src/embedder.ts';

const LOCAL: EmbeddingConfig = { provider: 'local', dimensions: 1024, modelId: null };
const BEDROCK: EmbeddingConfig = {
  provider: 'bedrock',
  dimensions: 1024,
  modelId: 'amazon.titan-embed-text-v2:0',
};

describe('createEmbedder', () => {
  it('builds the offline embedder for local, and ignores the region entirely', () => {
    expect(createEmbedder(LOCAL, {}).id).toBe('local-token-hash-v1:1024');
  });

  it('builds the hosted embedder for bedrock, named so a stored vector can be traced', () => {
    const embedder = createEmbedder(BEDROCK, { AWS_REGION: 'eu-central-1' });
    expect(embedder.id).toBe('bedrock:amazon.titan-embed-text-v2:0:1024');
    expect(embedder.dimensions).toBe(1024);
  });

  // NEVER A SILENT DOWNGRADE. A fallback to the local embedder here would give an operator who
  // asked for Bedrock hash embeddings under a name that says otherwise, and every guard downstream
  // would stay green while recall quietly stopped meaning anything. The whole point of these two
  // tests is that the failure is loud.
  it('refuses bedrock without a model id rather than falling back to the local embedder', () => {
    expect(() => createEmbedder({ ...BEDROCK, modelId: null }, { AWS_REGION: 'eu-central-1' })).toThrow(
      /no model id was supplied/,
    );
  });

  it('refuses bedrock without a region rather than letting the SDK chain resolve one silently', () => {
    expect(() => createEmbedder(BEDROCK, {})).toThrow(/AWS_REGION is empty/);
    expect(() => createEmbedder(BEDROCK, { AWS_REGION: '   ' })).toThrow(/AWS_REGION is empty/);
  });

  // The width check belongs to the adapter and this proves the selection does not swallow it. A
  // model that cannot produce the column's width fails every call, so it is refused at construction
  // rather than at recall time, where it reads as an outage.
  it('lets the adapter refuse a width the chosen model cannot produce', () => {
    expect(() =>
      createEmbedder({ ...BEDROCK, dimensions: 768 }, { AWS_REGION: 'eu-central-1' }),
    ).toThrow(/256, 512, 1024/);
  });

  it('refuses a model id no family recognises rather than guessing a request body', () => {
    expect(() =>
      createEmbedder({ ...BEDROCK, modelId: 'eu.cohere.embed-v4:0' }, { AWS_REGION: 'eu-central-1' }),
    ).toThrow(/Cannot tell how to shape a request/);
  });
});
