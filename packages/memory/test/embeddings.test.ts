import { describe, expect, it } from 'vitest';
import { createLocalEmbedder, embedSync } from '../src/embeddings.ts';
import { cosineSimilarity } from '../src/scoring.ts';

describe('createLocalEmbedder', () => {
  it('produces the same vector for the same text, every time', async () => {
    const embedder = createLocalEmbedder(64);
    const first = await embedder.embed('checkout latency spiked after the payment deploy');
    const second = await embedder.embed('checkout latency spiked after the payment deploy');
    expect(first).toEqual(second);
  });

  it('produces vectors of the declared dimension', async () => {
    const embedder = createLocalEmbedder(128);
    const vector = await embedder.embed('database connection pool exhausted');
    expect(vector).toHaveLength(128);
    expect(embedder.dimensions).toBe(128);
  });

  it('carries an identifier that names what produced the vector', () => {
    expect(createLocalEmbedder(256).id).toBe('local-token-hash-v1:256');
  });

  it('rejects a nonsensical dimension instead of producing an unusable embedder', () => {
    expect(() => createLocalEmbedder(0)).toThrow(/positive integer/);
    expect(() => createLocalEmbedder(-1)).toThrow(/positive integer/);
    expect(() => createLocalEmbedder(1.5)).toThrow(/positive integer/);
  });

  it('scores overlapping text above unrelated text', () => {
    // The honest limit of this embedder is that it sees lexical overlap only. This asserts exactly
    // that much and no more, so the test does not quietly claim semantic ability it lacks.
    const query = embedSync('payment service returned 502 during checkout', 512);
    const overlapping = embedSync('checkout failed because the payment service returned 502', 512);
    const unrelated = embedSync('nightly backup job finished ahead of schedule', 512);

    expect(cosineSimilarity(query, overlapping)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it('returns a zero vector for text with no usable tokens rather than throwing', () => {
    const vector = embedSync('!!! ?? .', 32);
    expect(vector).toHaveLength(32);
    expect(vector.every((value) => value === 0)).toBe(true);
  });

  it('normalises to unit length so similarity is not skewed by document length', () => {
    const vector = embedSync('the database primary failed over to the standby node', 256);
    const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });
});
