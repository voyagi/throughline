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
    // v2 since the tokeniser learned every script. A vector stored under v1 from non-ASCII text is
    // not what this embedder would produce for the same text now, so the label moved with it.
    expect(createLocalEmbedder(256).id).toBe('local-token-hash-v2:256');
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

  // EVERY SCRIPT, NOT ONLY ASCII. The tokeniser split on anything outside `[a-z0-9]`, so each of
  // these embedded to zeros, and two identical sentences in any of them scored as exactly opposite.
  // Hindi is here for its vowel signs, which are combining marks inside a word: a tokeniser that
  // splits on marks breaks "डेटाबेस" into single letters and drops every one.
  it.each([
    ['Chinese', '数据库连接池已耗尽'],
    ['Greek', 'η βάση δεδομένων είναι εκτός λειτουργίας'],
    ['Russian', 'база данных недоступна'],
    ['Hindi', 'डेटाबेस'],
  ])('embeds %s text to a vector it can compare, and finds it identical to itself', (_label, text) => {
    const vector = embedSync(text, 64);
    expect(vector.some((value) => value !== 0)).toBe(true);
    expect(cosineSimilarity(vector, embedSync(text, 64))).toBeCloseTo(1, 10);
  });

  it('scores overlapping text above unrelated text in another script too', () => {
    const query = embedSync('η βάση δεδομένων δεν απαντά', 512);
    const overlapping = embedSync('η βάση δεδομένων είναι εκτός λειτουργίας', 512);
    const unrelated = embedSync('το αντίγραφο ασφαλείας ολοκληρώθηκε νωρίς', 512);

    expect(cosineSimilarity(query, overlapping)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it('keeps an accented letter inside its word, however the accent was typed', () => {
    // "café" lost its last letter and embedded exactly like "caf". Typed as one character or as a
    // letter plus a combining accent, it is the same word and gets the same vector. Escapes rather
    // than literals, so the two spellings cannot collapse into one inside this file.
    const composed = embedSync('café', 64);
    expect(composed.some((value) => value !== 0)).toBe(true);
    expect(composed).not.toEqual(embedSync('caf', 64));
    expect(embedSync('café', 64)).toEqual(composed);
  });

  it('reads full-width letters as the ordinary ones', () => {
    // Some input methods type Latin letters in their full-width forms. 512 dimensions, because at 64
    // "db" and "pool" land in one slot with opposite signs and cancel: the ordinary form was all zeros
    // there, and this comparison passed against the unfixed tokeniser with nothing compared.
    const ordinary = embedSync('db pool', 512);
    expect(ordinary.some((value) => value !== 0)).toBe(true);
    expect(embedSync('ＤＢ ｐｏｏｌ', 512)).toEqual(ordinary);
  });

  it('embeds plain ASCII text exactly as v1 did, so vectors already stored stay comparable', () => {
    // Measured from `local-token-hash-v1` on main 63d4609, before the tokeniser changed. The sentence
    // carries each ASCII shape the tokeniser treats specially: upper case, an apostrophe, a hyphen,
    // an underscore, a slash, a one-letter word, a one-digit number and a longer one.
    expect(embedSync("Don't restart p99-latency ERR_CONN_RESET on HTTP/2 x 502", 8)).toEqual([
      0.6324555320336759, -0.6324555320336759, 0, 0, 0, -0.31622776601683794, 0, -0.31622776601683794,
    ]);
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
