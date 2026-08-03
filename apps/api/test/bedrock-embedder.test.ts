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

  it('refuses an unrecognised vendor', () => {
    expect(() => inferRequestShape('acme.some-new-embedder')).toThrow(/pass requestShape/);
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
});

describe('assertUsableVector', () => {
  it('accepts a finite vector', () => {
    expect(() => assertUsableVector([0.1, -0.2, 0], 'm')).not.toThrow();
  });

  it('refuses a vector carrying a non finite value, and says where', () => {
    expect(() => assertUsableVector([0.1, Number.NaN], 'm')).toThrow(/position 1/);
    expect(() => assertUsableVector([Number.POSITIVE_INFINITY], 'm')).toThrow(/position 0/);
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
