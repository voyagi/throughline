/**
 * The embedding port, and the one implementation that needs no network.
 *
 * A port rather than a direct SDK call because the memory layer must stay runnable with no cloud
 * account: tests, offline development and the canned demo all use the local implementation, and
 * the Bedrock implementation lives in the app that has AWS credentials. `packages/memory` never
 * imports an AWS SDK, and a dependency-cruiser rule enforces that rather than trusting it.
 */

/**
 * Why a vector is being made.
 *
 * Some hosted models embed a stored document and a search query into deliberately different
 * spaces, and asking for the wrong one is invisible: the width is right, the values are finite,
 * every guard passes, and retrieval quality quietly degrades. So the caller states its purpose
 * and the adapter decides whether that matters. An embedder that does not care ignores it.
 */
export type EmbeddingPurpose = 'document' | 'query';

export interface Embedder {
  /** Stable identifier written into the audit log, so a vector can be traced to what produced it. */
  readonly id: string;
  readonly dimensions: number;
  embed(text: string, purpose?: EmbeddingPurpose): Promise<number[]>;
}

/**
 * A deterministic bag-of-tokens embedder. Same text in, same vector out, forever, with no network.
 *
 * It is honestly weak: it captures lexical overlap and nothing else, so "the database is down" and
 * "the datastore is unavailable" look unrelated to it. That is acceptable and it is the point. It
 * exists so the memory layer's LOGIC can be tested at an exact numeric value, with no model, no
 * credentials and no flakiness. Semantic quality is the hosted model's job, and swapping it in is
 * a configuration change rather than a code change.
 *
 * It is never a silent fallback for a failed hosted embedder. A recall that could not embed
 * returns coverage UNKNOWN. Quietly substituting a weaker embedder would produce exactly the
 * confident wrong answer this whole design exists to prevent.
 */
export function createLocalEmbedder(dimensions = 1024): Embedder {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Embedding dimensions must be a positive integer, received ${dimensions}.`);
  }

  return {
    id: `local-token-hash-v1:${dimensions}`,
    dimensions,
    // Purpose is accepted and ignored: lexical overlap is symmetric, so a document and a query
    // embed identically here. Ignoring it explicitly is the point, rather than not offering it.
    embed(text: string): Promise<number[]> {
      return Promise.resolve(embedSync(text, dimensions));
    },
  };
}

export function embedSync(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    const hashed = fnv1a(token);
    const bucket = hashed % dimensions;
    // The sign trick keeps unrelated tokens from all pushing the vector in one direction, which
    // would make every document look similar to every other document.
    const sign = (hashed >>> 31) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] as number) + sign;
  }
  return normalize(vector);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1);
}

/** FNV-1a, 32 bit. Chosen for being tiny, dependency free, and identical on every platform. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function normalize(vector: number[]): number[] {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  if (sumOfSquares === 0) return vector;
  const magnitude = Math.sqrt(sumOfSquares);
  return vector.map((value) => value / magnitude);
}
