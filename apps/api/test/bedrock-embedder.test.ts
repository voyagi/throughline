import { describe, expect, it, vi } from 'vitest';
import {
  assertUsableVector,
  assertWidthSupported,
  buildRequestBody,
  createBedrockEmbedder,
  decodeBody,
  describeProviderError,
  EmbeddingDimensionMismatchError,
  EmbeddingProviderError,
  EmbeddingResponseError,
  EmbeddingTimeoutError,
  inferRequestShape,
  parseEmbedding,
  type InvokeModelCapableClient,
} from '../src/bedrock-embedder.ts';
import { TOP_LEVEL_KEY_BUDGET } from '../src/printable-name.ts';

/**
 * A client double answering with the byte array the real SDK returns, rather than the string it
 * merely permits. A double that is easier to satisfy than production is a test that proves less
 * than it appears to.
 */
function clientReturning(body: unknown, capture?: { command?: unknown }): InvokeModelCapableClient {
  return {
    send(command) {
      if (capture) capture.command = command;
      return Promise.resolve({ body: new TextEncoder().encode(JSON.stringify(body)) });
    },
  };
}

function inputOf(capture: { command?: unknown }): { modelId: string; body: string; contentType: string; accept: string } {
  return (capture.command as { input: { modelId: string; body: string; contentType: string; accept: string } }).input;
}

// 512 rather than 1024 throughout: 1024 is Titan's own default, so an assertion made against it
// cannot fail for the reason it claims. A mutation that hardcoded the width survived until this
// fixture stopped agreeing with the default.
const OPTIONS = { modelId: 'amazon.titan-embed-text-v2:0', dimensions: 512, region: 'eu-central-1' };
const VECTOR_512 = Array.from({ length: 512 }, (_value, index) => index / 512);

describe('inferRequestShape', () => {
  it('recognises a family by name, not a vendor by prefix', () => {
    expect(inferRequestShape('amazon.titan-embed-text-v2:0')).toBe('titan-v2');
    expect(inferRequestShape('cohere.embed-multilingual-v3')).toBe('cohere-v3');
  });

  it('refuses other models from the SAME vendor, because their bodies differ', () => {
    // Titan V1 takes only inputText and Titan Image is a third shape again. All three are
    // "amazon.", so a vendor prefix check would send a body two of them cannot read.
    expect(() => inferRequestShape('amazon.titan-embed-text-v1')).toThrow(/recognises/);
    expect(() => inferRequestShape('amazon.titan-embed-image-v1')).toThrow(EmbeddingResponseError);
  });

  it('separates the two Cohere generations, which do not take the same body', () => {
    // v4 takes output_dimension; v3 is fixed at 1024 and does not accept the parameter at all.
    expect(inferRequestShape('cohere.embed-v4:0')).toBe('cohere-v4');
    expect(inferRequestShape('cohere.embed-english-v3')).toBe('cohere-v3');
    expect(inferRequestShape('cohere.embed-multilingual-v3')).toBe('cohere-v3');
  });

  // The message used to offer ONE remedy, "pass requestShape explicitly", which is a code change.
  // Whoever reaches this got here by setting EMBEDDING_MODEL_ID, and there is no environment
  // variable for the shape, so the only remedy they were given was one they could not reach.
  it('refuses an unrecognised vendor, naming a remedy the reader can actually reach', () => {
    expect(() => inferRequestShape('acme.some-new-embedder')).toThrow(/EMBEDDING_MODEL_ID/);
    expect(() => inferRequestShape('acme.some-new-embedder')).toThrow(/no environment variable/);
    expect(() => inferRequestShape('nonsense')).toThrow(EmbeddingResponseError);
  });
});

describe('assertWidthSupported', () => {
  it('accepts the widths each family actually produces', () => {
    for (const width of [256, 512, 1024]) expect(() => assertWidthSupported('titan-v2', width)).not.toThrow();
    for (const width of [256, 512, 1024, 1536]) expect(() => assertWidthSupported('cohere-v4', width)).not.toThrow();
    expect(() => assertWidthSupported('cohere-v3', 1024)).not.toThrow();
  });

  it('refuses a width a family cannot produce, before any call is made', () => {
    // Otherwise every call fails forever and it reads as an outage rather than a config error.
    expect(() => assertWidthSupported('titan-v2', 768)).toThrow(/256, 512, 1024/);
    expect(() => assertWidthSupported('cohere-v4', 768)).toThrow(/256, 512, 1024, 1536/);
  });

  it('pins Cohere v3 to the single width it produces', () => {
    // v3 has no width parameter: it returns 1024 floats and nothing else is reachable.
    expect(() => assertWidthSupported('cohere-v3', 512)).toThrow(/1024/);
    expect(() => assertWidthSupported('cohere-v3', 1536)).toThrow(/1024/);
  });
});

describe('buildRequestBody', () => {
  it('asks Titan for the width this deployment expects', () => {
    const body = JSON.parse(buildRequestBody('titan-v2', 'pool exhausted', 256, 'document'));
    expect(body).toEqual({ inputText: 'pool exhausted', dimensions: 256, normalize: true });
  });

  it('tells Cohere whether it is embedding a document or a query', () => {
    // Using the document type for a query is the invisible failure: right width, finite values,
    // every guard green, and retrieval quality quietly worse.
    const asDocument = JSON.parse(buildRequestBody('cohere-v4', 'pool exhausted', 512, 'document'));
    const asQuery = JSON.parse(buildRequestBody('cohere-v4', 'pool exhausted', 512, 'query'));
    expect(asDocument.input_type).toBe('search_document');
    expect(asQuery.input_type).toBe('search_query');
  });

  it('sends output_dimension to Cohere v4 and never to v3', () => {
    // v3 does not accept the parameter. Sending it is a request the model cannot read, and the
    // failure lands on the far side of the network with nothing pointing back here.
    const v4 = JSON.parse(buildRequestBody('cohere-v4', 'pool exhausted', 512, 'query'));
    const v3 = JSON.parse(buildRequestBody('cohere-v3', 'pool exhausted', 1024, 'query'));
    expect(v4.output_dimension).toBe(512);
    expect(v3).not.toHaveProperty('output_dimension');
  });
});

describe('parseEmbedding', () => {
  it('reads a single vector response', () => {
    expect(parseEmbedding({ embedding: [0.1, 0.2] })).toEqual([0.1, 0.2]);
  });

  it('reads the first vector of a batch response', () => {
    expect(parseEmbedding({ embeddings: [[0.3, 0.4], [9, 9]] })).toEqual([0.3, 0.4]);
  });

  it('names the keys it actually saw when there is no vector', () => {
    expect(() => parseEmbedding({ results: [], inputTextTokenCount: 4 })).toThrow(
      /results, inputTextTokenCount/,
    );
  });

  it('rejects an empty batch rather than returning undefined', () => {
    expect(() => parseEmbedding({ embeddings: [] })).toThrow(EmbeddingResponseError);
  });

  it('rejects a response that is not an object', () => {
    expect(() => parseEmbedding(null)).toThrow(/null/);
    expect(() => parseEmbedding('a string')).toThrow(/string/);
  });

  // THE KEYS IT NAMES CAME OFF THE WIRE, AND THIS FILE PRINTED THEM RAW WHILE THE CHAT ADAPTER
  // ESCAPED ITS IDENTICAL SENTENCE. Both read a body the provider sent, both list its top level keys
  // for an operator, and the escaping went in on the side somebody had recently been looking at. The
  // rule now lives in one module both import, which is the actual fix: two copies of one decision is
  // how this diverged in the first place, and a comment saying "keep in sync" would not have caught
  // it. A newline here splits one finding across two lines, so half of it reads as a separate record.
  it('escapes and bounds those keys, which are strings the provider chose', () => {
    const messageFor = (body: unknown): string => {
      try {
        parseEmbedding(body);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return '';
    };
    const newline = String.fromCodePoint(0x0a);
    const forged = messageFor({ [`results${newline}Embedding read: ok`]: [] });
    expect(forged).toContain('results\\x{0a}Embedding read: ok');
    expect(forged).not.toContain(newline);
    // AND THE LENGTH, on both axes, because a JSON body decides how long its own key list is. One
    // name is bounded at 60 and the list stops on a whole name, never inside an escape.
    const long = messageFor({ ['k'.repeat(200)]: [] });
    expect(long).toContain(`${'k'.repeat(60)}\\...`);
    expect(long).not.toContain('k'.repeat(61));
    const many = Object.fromEntries(
      Array.from({ length: 400 }, (_unused, at) => [`key${at}`, at]),
    );
    const capped = messageFor(many);
    // AND THE COUNT, MEASURED. This row read `(\d+ of 400 shown)` with a `< 1200` length beside it,
    // and between them they pinned nothing about the budget: measured against the real module, every
    // value from 1 to 3087 satisfies the regex and the sentence stays under 1200 for a wide band
    // around it too. So the 800 in the source was decoration for the third time in this file, which
    // is the complaint that produced the whole shared module. 114 keys is what fits, the prefix
    // before the marker is 800 exactly, and the constant is named rather than left implied by a
    // count that would also be satisfied by a different budget with different key widths.
    expect(capped).toContain('\\... (114 of 400 shown)');
    // Sliced between the sentence's own two landmarks, so this measures the KEY LIST rather than the
    // message: an earlier draft of this row measured from index 0 and silently added the 84
    // characters of preamble to the budget it claimed to be checking. A list cannot be made to end
    // exactly on a budget in general, so the assertion is the band one item wide, and here it lands
    // on 800 exactly.
    const lead = 'Top level keys were: ';
    const keyList = capped.slice(capped.indexOf(lead) + lead.length, capped.indexOf(', \\...'));
    expect(keyList.length).toBeLessThanOrEqual(TOP_LEVEL_KEY_BUDGET);
    expect(keyList.length).toBeGreaterThan(TOP_LEVEL_KEY_BUDGET - 8);
    expect(keyList.endsWith('key113')).toBe(true);
    expect(capped.length).toBeLessThan(1200);
  });
});

describe('assertUsableVector', () => {
  it('accepts a finite vector', () => {
    expect(() => assertUsableVector([0.1, -0.2, 0], 'm')).not.toThrow();
  });

  it('refuses a vector carrying a non finite value, and says where', () => {
    expect(() => assertUsableVector([0.1, Number.NaN], 'm')).toThrow(/position 1/);
    expect(() => assertUsableVector([Number.POSITIVE_INFINITY], 'm')).toThrow(/position 0/);
  });

  // THE ELEMENT IS OFF THE WIRE, WHICH THE SIGNATURE HIDES. `assertUsableVector(vector: number[])`
  // reads as though the elements are already numbers, and `parseEmbedding` reaches it by casting
  // `record['embedding'] as number[]` with no element check at all, so a JSON array of strings walks
  // straight through the type and lands on this loop. That is exactly what the loop is for, and the
  // message printed the element with a bare `String(value)`, unescaped and unbounded, twenty-six
  // lines under the call that escapes the KEYS of the same body. One rule kept and its twin dropped
  // inside one file, for the fourth time in this pair.
  //
  // Driven through the real embedder as well as the helper, because the cast that makes it reachable
  // lives in `parseEmbedding` and a helper-only row would not prove the two are connected.
  it('escapes and bounds an element the provider chose, which the cast lets through', async () => {
    const newline = String.fromCodePoint(0x0a);
    const forged = `0.5${newline}Model "m" returned 0.5 at position 0. Vector read: ok`;
    expect(() => assertUsableVector([forged] as unknown as number[], 'm')).toThrow(
      /0\.5\\x\{0a\}Model/,
    );
    expect(() => assertUsableVector([forged] as unknown as number[], 'm')).not.toThrow(
      new RegExp(newline),
    );
    // Bounded on the same terms as every other wire string in these two files.
    expect(() => assertUsableVector(['L'.repeat(200)] as unknown as number[], 'm')).toThrow(
      new RegExp(`${'L'.repeat(60)}\\\\\\.\\.\\.`),
    );
    expect(() => assertUsableVector(['L'.repeat(200)] as unknown as number[], 'm')).not.toThrow(
      new RegExp('L'.repeat(61)),
    );
    // And the whole path, so the cast in `parseEmbedding` is what carries it here rather than an
    // argument this test made up. A 512 long array of strings is the width the embedder expects, so
    // nothing refuses it earlier and this loop is genuinely the first thing that looks at an element.
    const strings = Array.from({ length: 512 }, () => '0.1');
    strings[7] = forged;
    const message = await createBedrockEmbedder({
      ...OPTIONS,
      client: clientReturning({ embedding: strings }),
    })
      .embed('checkout latency')
      .catch((caught: unknown) => (caught as Error).message);
    expect(message).toContain('at position 0');
    expect(message).not.toContain(newline);
  });
});

describe('describeProviderError', () => {
  it('reads the identity without touching the prose', () => {
    const described = describeProviderError(
      Object.assign(new Error('User arn:aws:sts::123456789012:assumed-role/x is not authorized'), {
        name: 'AccessDeniedException',
        $metadata: { httpStatusCode: 403, requestId: 'abc-123' },
      }),
    );
    expect(described).toEqual({
      name: 'AccessDeniedException',
      httpStatusCode: 403,
      requestId: 'abc-123',
    });
  });

  it('falls back to a name rather than reporting undefined', () => {
    expect(describeProviderError({}).name).toBe('UnknownProviderError');
    expect(describeProviderError(null).name).toBe('UnknownProviderError');
  });

  // PRESENT AND EMPTY IS NOT ABSENT. The two metadata fields earned presence-not-truthiness one
  // round earlier and the name is the third string of the same producer: `''` survives to render
  // as `\empty`, only a missing or non-string name earns the fallback word, and the two states
  // stay tellable apart. The number row keeps the rule honest about its edge: the rule is about
  // STRINGS the provider chose, so a name that is not a string at all still falls back.
  it('keeps a present and empty name instead of substituting the absent-name word', () => {
    expect(describeProviderError({ name: '' }).name).toBe('');
    expect(describeProviderError({ name: 7 }).name).toBe('UnknownProviderError');
  });
});

describe('decodeBody', () => {
  it('decodes the carriers the SDK actually hands back', () => {
    expect(decodeBody('{"embedding":[1]}')).toEqual({ embedding: [1] });
    expect(decodeBody(new TextEncoder().encode('{"embedding":[2]}'))).toEqual({ embedding: [2] });
    expect(decodeBody({ transformToString: () => '{"embedding":[3]}' })).toEqual({ embedding: [3] });
  });

  it('refuses an absent or undecodable body instead of parsing undefined', () => {
    expect(() => decodeBody(undefined)).toThrow(/no body/);
    expect(() => decodeBody(null)).toThrow(/no body/);
    expect(() => decodeBody(42)).toThrow(/cannot decode/);
  });
});

describe('createBedrockEmbedder', () => {
  it('returns the vector the model produced', async () => {
    const embedder = createBedrockEmbedder({ ...OPTIONS, client: clientReturning({ embedding: VECTOR_512 }) });
    await expect(embedder.embed('checkout latency')).resolves.toEqual(VECTOR_512);
  });

  it('sends the configured model id, width and content headers rather than compiled in defaults', async () => {
    const capture: { command?: unknown } = {};
    const embedder = createBedrockEmbedder({ ...OPTIONS, client: clientReturning({ embedding: VECTOR_512 }, capture) });
    await embedder.embed('checkout latency');
    const input = inputOf(capture);
    expect(input.modelId).toBe('amazon.titan-embed-text-v2:0');
    expect(input.contentType).toBe('application/json');
    expect(input.accept).toBe('application/json');
    expect(JSON.parse(input.body).dimensions).toBe(512);
  });

  it('passes the caller purpose through to the provider', async () => {
    const capture: { command?: unknown } = {};
    const embedder = createBedrockEmbedder({
      ...OPTIONS,
      modelId: 'cohere.embed-v4:0',
      client: clientReturning({ embeddings: [VECTOR_512] }, capture),
    });
    await embedder.embed('checkout latency', 'query');
    expect(JSON.parse(inputOf(capture).body).input_type).toBe('search_query');
  });

  it('defaults to embedding a document when no purpose is given', async () => {
    const capture: { command?: unknown } = {};
    const embedder = createBedrockEmbedder({
      ...OPTIONS,
      modelId: 'cohere.embed-v4:0',
      client: clientReturning({ embeddings: [VECTOR_512] }, capture),
    });
    await embedder.embed('checkout latency');
    expect(JSON.parse(inputOf(capture).body).input_type).toBe('search_document');
  });

  it('hands the configured region to the client it builds', async () => {
    // "Nothing is hardcoded" is three claims. Model id and width were covered; this is the third.
    const seen: string[] = [];
    createBedrockEmbedder({
      ...OPTIONS,
      createClient: (region) => {
        seen.push(region);
        return clientReturning({ embedding: VECTOR_512 });
      },
    });
    expect(seen).toEqual(['eu-central-1']);
  });

  it('leaves no timer holding the event loop open after a successful call', async () => {
    // A pending 2 s timer keeps a short lived CLI (probe, verify:live) from exiting.
    vi.useFakeTimers();
    try {
      const embedder = createBedrockEmbedder({ ...OPTIONS, client: clientReturning({ embedding: VECTOR_512 }) });
      await embedder.embed('checkout latency');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries an id that traces a stored vector to the model and width that made it', () => {
    const embedder = createBedrockEmbedder({ ...OPTIONS, client: clientReturning({ embedding: [] }) });
    expect(embedder.id).toBe('bedrock:amazon.titan-embed-text-v2:0:512');
    expect(embedder.dimensions).toBe(512);
  });

  it('refuses a vector of the wrong width, naming both numbers', async () => {
    const embedder = createBedrockEmbedder({ ...OPTIONS, client: clientReturning({ embedding: [0.1, 0.2, 0.3] }) });
    await expect(embedder.embed('checkout latency')).rejects.toThrow(EmbeddingDimensionMismatchError);
    await expect(embedder.embed('checkout latency')).rejects.toThrow(/3 dimension vector but .* 512/);
  });

  it('refuses a non finite value that arrives through embed, not just through the helper', async () => {
    // The width here is deliberately CORRECT, so the dimension guard cannot mask this and the only
    // thing that can catch it is the finiteness check actually being wired into embed(). Deleting
    // that call left the suite green until this test existed.
    const poisoned = [...VECTOR_512];
    const withNull: InvokeModelCapableClient = {
      send() {
        return Promise.resolve({ body: JSON.stringify({ embedding: poisoned }).replace('0.001953125', 'null') });
      },
    };
    const embedder = createBedrockEmbedder({ ...OPTIONS, client: withNull });
    await expect(embedder.embed('checkout latency')).rejects.toThrow(EmbeddingResponseError);
    await expect(embedder.embed('checkout latency')).rejects.toThrow(/position 1/);
  });

  it('reports a timeout as a timeout, so recall can call it UNKNOWN', async () => {
    const never: InvokeModelCapableClient = {
      send() {
        return new Promise(() => {});
      },
    };
    const embedder = createBedrockEmbedder({ ...OPTIONS, timeoutMs: 5, client: never });
    await expect(embedder.embed('checkout latency')).rejects.toThrow(EmbeddingTimeoutError);
    await expect(embedder.embed('checkout latency')).rejects.toThrow(/coverage UNKNOWN/);
  });

  it('holds the deadline even when the client ignores the abort signal', async () => {
    // The SDK retries with sleeps that do not observe an abort, so delegating the budget would
    // make "2 seconds then UNKNOWN" a guess. This proves the bound is enforced locally.
    const slowAndDeaf: InvokeModelCapableClient = {
      send() {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ body: JSON.stringify({ embedding: VECTOR_512 }) }), 400),
        );
      },
    };
    const embedder = createBedrockEmbedder({ ...OPTIONS, timeoutMs: 20, client: slowAndDeaf });
    const startedAt = Date.now();
    await expect(embedder.embed('checkout latency')).rejects.toThrow(EmbeddingTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(300);
  });

  it('keeps a late real error on the cause rather than discarding it', async () => {
    const failsAfterDeadline: InvokeModelCapableClient = {
      send(_command, options) {
        return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () =>
            reject(new Error('ThrottlingException: slow down')),
          );
        });
      },
    };
    const embedder = createBedrockEmbedder({ ...OPTIONS, timeoutMs: 5, client: failsAfterDeadline });
    const error = await embedder.embed('checkout latency').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingTimeoutError);
    // Asserting the type alone was vacuous: it holds whether or not the cause is preserved, and
    // the whole point of this branch is that a real error landing late is not thrown away.
    expect(((error as Error).cause as Error).message).toContain('ThrottlingException');
  });

  it('does not leak the provider prose into the message an operator reads', async () => {
    // A raw AccessDeniedException carries the caller ARN, so the account id and the role name.
    // That message ends up in the coverage reason, which is rendered to whoever is on call.
    const denied = Object.assign(
      new Error('User: arn:aws:sts::123456789012:assumed-role/throughline-admin is not authorized'),
      { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403, requestId: 'req-9' } },
    );
    const failing: InvokeModelCapableClient = { send: () => Promise.reject(denied) };
    const embedder = createBedrockEmbedder({ ...OPTIONS, client: failing });

    const error = await embedder.embed('checkout latency').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    const message = (error as Error).message;
    expect(message).toContain('AccessDeniedException');
    expect(message).toContain('HTTP 403');
    expect(message).not.toContain('123456789012');
    expect(message).not.toContain('arn:aws');
    // The full text stays reachable for a log that is allowed to see it.
    expect(((error as Error).cause as Error).message).toContain('123456789012');
  });

  // THE NAME AND THE REQUEST ID ARE STRINGS THE PROVIDER CHOSE TOO, and withholding its PROSE while
  // pasting its chosen NAME in raw is one rule kept and its twin dropped, in the very file that
  // supplies `describeProviderError` to the chat adapter that DID escape them. The name is the better
  // carrier of the two: it lands mid-sentence in the operator's own line, so a forged continuation
  // reads as this adapter speaking rather than as quoted content, while an ESC opens a live control
  // sequence in whatever terminal reads the log. This is the same test the chat adapter has, on
  // purpose, because the two messages are the same sentence and were never allowed to disagree.
  it('escapes the provider name and request id, which the far side also chooses', async () => {
    const newline = String.fromCodePoint(0x0a);
    const escape = String.fromCodePoint(0x1b);
    const forged = Object.assign(new Error('denied'), {
      name: `AccessDenied${newline}EmbeddingProviderError: all clear`,
      $metadata: { httpStatusCode: 403, requestId: `req-9${escape}[2K` },
    });
    const failing: InvokeModelCapableClient = { send: () => Promise.reject(forged) };
    const embedder = createBedrockEmbedder({ ...OPTIONS, client: failing });

    const error = await embedder.embed('checkout latency').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    const message = (error as Error).message;
    expect(message).toContain('AccessDenied\\x{0a}EmbeddingProviderError');
    expect(message).toContain('req-9\\x{1b}[2K');
    expect(message).not.toContain(newline);
    expect(message).not.toContain(escape);
    // And bounded, for the same reason values are never printed at all: a name is as long as the far
    // side says it is, so a line whose length it decides is a line it can bury.
    const long = Object.assign(new Error('denied'), {
      name: 'N'.repeat(200),
      $metadata: { httpStatusCode: 403, requestId: undefined },
    });
    const bounded = await createBedrockEmbedder({ ...OPTIONS, client: { send: () => Promise.reject(long) } })
      .embed('checkout latency')
      .catch((caught: unknown) => (caught as Error).message);
    expect(bounded).toContain(`${'N'.repeat(60)}\\...`);
    expect(bounded).not.toContain('N'.repeat(61));
  });

  // PRESENT AND FALSY, THE TWIN OF THE ROW THE CHAT ADAPTER NOW HAS. `describeProviderError` lives in
  // THIS file and hands both adapters any number and any string it was given, so a `0` status and an
  // `''` request id survive it and land on the two lines that decide whether to print them. Those two
  // lines were `=== undefined` next door and truthy here, in the file that produces the values, which
  // is this pair's third round of one rule kept in one place and dropped in the other. Under
  // truthiness this message said nothing at all about the request id, so an EMPTY one and an ABSENT
  // one read identically to whoever is on call, and they have different causes.
  it('prints a status of zero and an empty request id rather than hiding them', async () => {
    const stalled = Object.assign(new Error('socket hang up'), {
      name: 'TimeoutError',
      $metadata: { httpStatusCode: 0, requestId: '' },
    });
    const error = await createBedrockEmbedder({
      ...OPTIONS,
      client: { send: () => Promise.reject(stalled) },
    })
      .embed('checkout latency')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    expect((error as Error).message).toContain('(HTTP 0)');
    expect((error as Error).message).toContain(', request \\empty');
    // WHICH ADAPTER SAID IT. The twin of the row in `agent-bedrock-model.test.ts`, for the same
    // reason: the sentence is shared now, so the subject is a one-word argument nothing was reading.
    expect((error as Error).message).toContain('The embedding provider rejected the call for model');
    expect((error as Error).message).not.toContain('chat provider');
    expect((error as EmbeddingProviderError).httpStatusCode).toBe(0);
    expect((error as EmbeddingProviderError).requestId).toBe('');
    // The control, so the rule does not quietly become "always print both". Genuinely absent metadata
    // still prints neither clause, and without this row `=== undefined` could be widened unnoticed.
    const bare = await createBedrockEmbedder({
      ...OPTIONS,
      client: { send: () => Promise.reject(Object.assign(new Error('x'), { name: 'WeirdError' })) },
    })
      .embed('checkout latency')
      .catch((caught: unknown) => caught);
    expect((bare as Error).message).not.toContain('HTTP');
    expect((bare as Error).message).not.toContain('request');
    expect((bare as EmbeddingProviderError).httpStatusCode).toBeUndefined();
    expect((bare as EmbeddingProviderError).requestId).toBeUndefined();
  });

  // THE THIRD STRING OF THE SAME PRODUCER, ONE ROUND LATER. The status and request id above earned
  // presence-not-truthiness while the name kept its `&& shaped.name`, so a name PRESENT AND EMPTY
  // wore the absent-name word and the sentence lied about which of two states arrived. Same rule on
  // the third field now: `''` reaches `printableName`, which already renders it `\empty`, and the
  // fallback word means only "no string name arrived at all".
  it('prints an empty provider name as \\empty rather than the absent-name word', async () => {
    const empty = Object.assign(new Error('denied'), {
      name: '',
      $metadata: { httpStatusCode: 403, requestId: undefined },
    });
    const error = await createBedrockEmbedder({ ...OPTIONS, client: { send: () => Promise.reject(empty) } })
      .embed('checkout latency')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    expect((error as Error).message).toContain(': \\empty (HTTP 403)');
    expect((error as Error).message).not.toContain('UnknownProviderError');
  });

  it('never falls back to a local vector when the provider fails', async () => {
    const failing: InvokeModelCapableClient = { send: vi.fn().mockRejectedValue(new Error('ThrottlingException')) };
    const embedder = createBedrockEmbedder({ ...OPTIONS, client: failing });
    await expect(embedder.embed('checkout latency')).rejects.toThrow();
    expect(failing.send).toHaveBeenCalledTimes(1);
  });

  it('refuses an unsupported width at construction, not just in the helper', async () => {
    // Deleting the assertWidthSupported call from the factory left the suite green: the helper had
    // unit coverage and the wiring had none. Constructing is the only thing under test here.
    expect(() =>
      createBedrockEmbedder({ ...OPTIONS, dimensions: 768, client: clientReturning({ embedding: [] }) }),
    ).toThrow(/256, 512, 1024/);
  });

  it('rejects a nonsensical width or budget before it can be used', () => {
    const client = clientReturning({ embedding: [] });
    expect(() => createBedrockEmbedder({ ...OPTIONS, dimensions: 0, client })).toThrow(/positive integer/);
    expect(() => createBedrockEmbedder({ ...OPTIONS, dimensions: 1.5, client })).toThrow(/positive integer/);
    expect(() => createBedrockEmbedder({ ...OPTIONS, timeoutMs: 0, client })).toThrow(/positive number/);
    expect(() => createBedrockEmbedder({ ...OPTIONS, timeoutMs: Number.NaN, client })).toThrow(/positive number/);
  });

  it('honours an explicit request shape when the model id names no known family', async () => {
    const capture: { command?: unknown } = {};
    const embedder = createBedrockEmbedder({
      ...OPTIONS,
      modelId: 'acme.private-embedder',
      requestShape: 'titan-v2',
      client: clientReturning({ embedding: VECTOR_512 }, capture),
    });
    await embedder.embed('checkout latency');
    expect(JSON.parse(inputOf(capture).body)).toHaveProperty('inputText', 'checkout latency');
  });
});
