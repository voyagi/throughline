/**
 * The hosted embedder, on Amazon Bedrock.
 *
 * This file is the only place in the repository that talks to a real embedding model, and it lives
 * in `apps/api` rather than in `packages/memory` because the memory layer must stay runnable with
 * no cloud account at all. A dependency-cruiser rule enforces that direction rather than trusting
 * it.
 *
 * Four rules shape everything below, and each one exists because the opposite behaviour produces a
 * confident wrong answer, which is the single failure this product is built to prevent.
 *
 * 1. NOTHING IS HARDCODED. The model id, the vector width and the region are configuration read
 *    from the live account. A constant here would be a claim about someone else's account.
 * 2. NOTHING IS ASSUMED. The width that comes back is checked against the width the database
 *    column was built for, on every call. A model swap that silently changes width would write
 *    vectors that compare as garbage against every existing row, while cosine distance kept
 *    returning plausible numbers the whole time.
 * 3. FAILURE IS NEVER PAPERED OVER, AND NEVER OVERSHARED. There is no fallback: if this cannot
 *    answer, it throws, recall reports coverage UNKNOWN, and the agent may not call that "nothing
 *    found". But the thrown message is sanitised, because it is not private. It reaches the
 *    coverage reason, which reaches the sentence the agent leads with, which reaches a browser.
 * 4. THE TIMEOUT IS ENFORCED HERE. The SDK retries internally with sleeps that do not observe an
 *    abort signal, so delegating the deadline to it would make the stated budget a guess. The
 *    budget is a local wall-clock race, so "2 seconds then UNKNOWN" is true rather than typical.
 *
 * NOTE ON SYNTAX: this file is loaded by `node --experimental-strip-types`, which erases types but
 * cannot rewrite code. TypeScript constructs that EMIT code, notably constructor parameter
 * properties and enums, throw at import there while passing every test, because vitest transpiles
 * fully. `erasableSyntaxOnly` in tsconfig.base.json makes the type gate catch that repo-wide.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { Embedder, EmbeddingPurpose } from '@throughline/memory';
import { joinWithinBudget, printableName, TOP_LEVEL_KEY_BUDGET } from './printable-name.ts';
import { ProviderRejectionError, type ProviderErrorMetadata } from './provider-rejection.ts';

/**
 * How a provider wants its request shaped. This is the one thing that cannot be read off the
 * response, because it has to be right before there is a response.
 */
export type EmbeddingRequestShape = 'titan-v2' | 'cohere-v3' | 'cohere-v4';

/**
 * The widths each family actually produces. Anything else is rejected before a call is made.
 *
 * These are not interchangeable and the difference is not cosmetic: Cohere v3 is fixed at 1024 and
 * has no width parameter at all, while v4 takes `output_dimension`. Sending v4's parameter to v3
 * is a request it does not understand, and asking v3 for 512 is a permanent failure that reads as
 * an outage.
 */
export const SUPPORTED_DIMENSIONS: Readonly<Record<EmbeddingRequestShape, readonly number[]>> = {
  'titan-v2': [256, 512, 1024],
  'cohere-v3': [1024],
  'cohere-v4': [256, 512, 1024, 1536],
};

/** Thrown when the returned vector is not the width the database column was built for. */
export class EmbeddingDimensionMismatchError extends Error {
  readonly modelId: string;
  readonly expected: number;
  readonly actual: number;

  constructor(modelId: string, expected: number, actual: number) {
    super(
      `Model "${modelId}" returned a ${actual} dimension vector but this deployment is configured ` +
        `for ${expected}. The memory table's VECTOR column is fixed at ${expected}, so storing ` +
        `this would corrupt every future comparison. Set EMBEDDING_DIMENSIONS to ${actual} and ` +
        `migrate the column, or point EMBEDDING_MODEL_ID at a model of the right width.`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
    this.modelId = modelId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Thrown when the provider did not answer inside the budget. Recall maps this to UNKNOWN. */
export class EmbeddingTimeoutError extends Error {
  readonly modelId: string;
  readonly timeoutMs: number;

  constructor(modelId: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(
      `Model "${modelId}" did not respond within ${timeoutMs} ms. No retrieval path can run ` +
        `without a query vector, so this recall has coverage UNKNOWN rather than an empty result.`,
      options,
    );
    this.name = 'EmbeddingTimeoutError';
    this.modelId = modelId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A provider failure, with the provider's own words deliberately left off the message.
 *
 * This matters more than it looks. `runRecall` puts the message of whatever `embed` throws into
 * the recall's coverage reason, and the coverage reason is rendered to whoever is on call. A raw
 * Bedrock AccessDeniedException carries the caller ARN, and therefore the account id and the role
 * name. The base class is the only place that knows the error came from AWS, so it is the only
 * place that can stop that. The full error stays reachable on `cause` for a log that is allowed to
 * see it.
 *
 * THE BODY MOVED TO `provider-rejection.ts`, AND THAT IS THE FINDING. This class and the chat
 * adapter's twin were the same twenty lines in two files, including two copies of the comment
 * explaining why the metadata is present-and-undefined. They had already diverged twice: the
 * escaping was kept next door and dropped here, and then the guard around it read as truthiness
 * here and `=== undefined` there, so an empty request id printed as `\empty` on one path and
 * vanished on the other. `describeProviderError`, which feeds BOTH, lives in this file. Only the
 * word "embedding" differs now.
 */
export class EmbeddingProviderError extends ProviderRejectionError {
  constructor(
    modelId: string,
    providerErrorName: string,
    metadata: ProviderErrorMetadata,
    cause: unknown,
  ) {
    super('embedding', modelId, providerErrorName, metadata, cause);
    this.name = 'EmbeddingProviderError';
  }
}

/** Thrown when the response body is not a shape this adapter knows how to read. */
export class EmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingResponseError';
  }
}

/**
 * The slice of the Bedrock client this adapter uses, so a test can supply a double without
 * standing up the SDK or reaching the network.
 */
export interface InvokeModelCapableClient {
  send(command: InvokeModelCommand, options?: { abortSignal?: AbortSignal }): Promise<{ body?: unknown }>;
}

export interface BedrockEmbedderOptions {
  /** Read from the account, never guessed. `loadEmbeddingConfig` refuses to default this. */
  readonly modelId: string;
  /** The width the `VECTOR(n)` column was built for. Every response is checked against it. */
  readonly dimensions: number;
  readonly region: string;
  /** The wall-clock budget after which recall gives up and reports UNKNOWN. */
  readonly timeoutMs?: number;
  /** Required when a model id does not name a family this adapter recognises. */
  readonly requestShape?: EmbeddingRequestShape;
  readonly client?: InvokeModelCapableClient;
  /** Injection seam for the real client, so a test can prove the region is actually passed. */
  readonly createClient?: (region: string) => InvokeModelCapableClient;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * Which request body a model wants, inferred from its FAMILY rather than its vendor.
 *
 * The vendor prefix is not enough and the difference is not cosmetic. Titan Text Embeddings V1
 * accepts only `inputText`; V2 adds `dimensions` and `normalize`; Titan Image is a third shape
 * again. All three begin `amazon.`. Sending the V2 body to V1 fails on the far side of the network
 * with nothing pointing back here, so an unrecognised family is refused rather than guessed at.
 *
 * WHY A GEOGRAPHY PREFIX IS STILL REFUSED, since this is the obvious thing to "fix" and a review
 * asked for it. An id like `eu.cohere.embed-v4:0` names a cross-region inference profile, and this
 * repository's own AGENT model is exactly that shape, so an operator has every reason to try the
 * form here too. Stripping the `eu.` would let the same family table answer. It would not make the
 * id INVOCABLE.
 *
 * THE SOURCE, AND WHAT IT DOES AND DOES NOT SAY, because an earlier version of this paragraph
 * overstated it. AWS, "Supported Regions and models for inference profiles"
 * (docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html), read 2026-08-12,
 * says: "Some models, such as embedding models, do not support inference profiles." That sentence
 * sits under the heading SUPPORTED REGIONS AND MODELS FOR APPLICATION INFERENCE PROFILES, and an
 * `eu.` prefix names the OTHER kind, a cross-region (system-defined) profile, which the same page
 * covers in its own section. So the sentence is strong evidence and not a proof about this exact
 * form, and the page sends you to each model's own detail page to settle it per model. Quoting it
 * as though it settled the cross-region case would be laundering a citation, which is the thing a
 * citation is supposed to stop.
 *
 * WHICH IS ENOUGH, BECAUSE THE ARGUMENT DOES NOT REST ON IT. Refusing locally is the smaller
 * failure either way: a wrong guess here produces a body shaped correctly for a model that may
 * never answer, and the failure moves from this line, which can say what is wrong, to the far side
 * of the network, which cannot. If a prefixed embedding id turns out to be invocable on some
 * account, the fix is to add it to the family table deliberately, having invoked it. The message
 * below says the prefix was read and rejected on purpose, because the operator who typed it needs
 * to know it was not simply unrecognised.
 */
export function inferRequestShape(modelId: string): EmbeddingRequestShape {
  const id = modelId.toLowerCase();
  if (id.startsWith('amazon.titan-embed-text-v2')) return 'titan-v2';
  if (id.startsWith('cohere.embed-v4')) return 'cohere-v4';
  // The v3 line is named by language rather than by version: cohere.embed-english-v3 and
  // cohere.embed-multilingual-v3. Matching the suffix keeps both without swallowing v4.
  if (id.startsWith('cohere.embed-') && id.includes('-v3')) return 'cohere-v3';
  throw new EmbeddingResponseError(
    `Cannot tell how to shape a request for model "${modelId}". This adapter recognises ` +
      `"amazon.titan-embed-text-v2", "cohere.embed-v4" and the "cohere.embed-*-v3" line by name. ` +
      `Other models from the same vendors take different bodies, and a wrong guess fails on the far ` +
      `side of the network with no clue that the cause is local. Set EMBEDDING_MODEL_ID to one of ` +
      `the three above, and without a geography prefix. An "eu." or "us." id names an inference ` +
      `profile, and this adapter reads that form and refuses it here rather than sending it to fail ` +
      `remotely, for the same reason as everything else in this message: the failure would land ` +
      `where nothing can say what caused it. AWS documents embedding models among the models that ` +
      `do not support inference profiles, which points the same way without being what the refusal ` +
      `rests on. There is no environment variable for the shape, so the only ` +
      `other way through is passing requestShape at the call site, which is a code change and not ` +
      `a setting.`,
  );
}

/**
 * Reject a width the chosen model cannot produce, before any call is made.
 *
 * Without this the failure is a permanent one: the request is rejected every time, or the model
 * returns its fixed width and the mismatch guard throws forever, and both look like an outage
 * rather than a configuration error.
 */
export function assertWidthSupported(shape: EmbeddingRequestShape, dimensions: number): void {
  const supported = SUPPORTED_DIMENSIONS[shape];
  if (!supported.includes(dimensions)) {
    throw new EmbeddingResponseError(
      `The "${shape}" family produces ${supported.join(', ')} dimension vectors, and this ` +
        `deployment asks for ${dimensions}. Every call would fail, so it is refused now rather ` +
        `than at recall time where it would read as an outage.`,
    );
  }
}

export function buildRequestBody(
  shape: EmbeddingRequestShape,
  text: string,
  dimensions: number,
  purpose: EmbeddingPurpose,
): string {
  if (shape === 'titan-v2') {
    // Asking for the width is what makes the mismatch check a real check rather than a formality:
    // we state a width and then verify we were given it. Titan has no notion of purpose.
    return JSON.stringify({ inputText: text, dimensions, normalize: true });
  }
  // Cohere embeds documents and queries into deliberately different spaces. Using the document
  // type for a query is the invisible failure: right width, finite values, every guard green,
  // and retrieval quality quietly worse.
  const body: Record<string, unknown> = {
    texts: [text],
    input_type: purpose === 'query' ? 'search_query' : 'search_document',
  };
  // `output_dimension` exists on v4 only. v3 is fixed at 1024 and does not accept the parameter,
  // so sending it there is a request the model cannot read.
  if (shape === 'cohere-v4') body['output_dimension'] = dimensions;
  return JSON.stringify(body);
}

/**
 * Pull the vector out of whatever came back.
 *
 * Deliberately keyed off the RESPONSE shape rather than the model id: the id told us how to ask,
 * and the body tells us what we actually got. If a model id is ever pointed at a different family,
 * this notices instead of misreading the body.
 */
export function parseEmbedding(body: unknown): number[] {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;

    if (Array.isArray(record['embedding'])) {
      return record['embedding'] as number[];
    }
    const batch = record['embeddings'];
    if (Array.isArray(batch) && batch.length > 0 && Array.isArray(batch[0])) {
      return batch[0] as number[];
    }
    // Wire-chosen names, escaped and bounded on the same terms as the chat adapter's identical
    // sentence. This body is JSON the provider sent, so the key list is as long and as strange as the
    // body says, and neither of those was this adapter's decision to leave open.
    const observed =
      joinWithinBudget(
        Object.keys(record).map((key) => printableName(key)),
        ', ',
        TOP_LEVEL_KEY_BUDGET,
      ) || 'none';
    throw new EmbeddingResponseError(
      `The embedding response carried no vector this adapter recognises. Top level keys were: ` +
        `${observed}. Expected either "embedding" or a non empty "embeddings" batch.`,
    );
  }
  throw new EmbeddingResponseError(
    `The embedding response was ${body === null ? 'null' : typeof body}, not an object.`,
  );
}

/**
 * Reject a vector that would poison the column.
 *
 * A single NaN or Infinity makes every cosine comparison against that row meaningless, and it does
 * it silently: the database stores it, the query returns a number, and the number is nonsense.
 * Cheaper to refuse the write than to explain the recall six weeks later.
 */
export function assertUsableVector(vector: number[], modelId: string): void {
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new EmbeddingResponseError(
        // THE VALUE IS OFF THE WIRE TOO, AND THIS LINE PRINTED IT RAW. `parseEmbedding` casts
        // `record['embedding'] as number[]` without checking a single element, which is what this
        // loop is here to catch, so `value` can be any JSON the provider sent. `String` of a string
        // is that string, unbounded and unescaped, twenty-six lines below the call that escapes the
        // KEYS of the same body. A newline in it forges a continuation of the operator's own line.
        `Model "${modelId}" returned ${printableName(String(value))} at position ${index}. A non finite value ` +
          `makes every comparison against this row meaningless while still returning a number, ` +
          `so the vector is refused rather than stored.`,
      );
    }
  }
}

/** Read the provider's error identity without letting its prose escape. */
export function describeProviderError(error: unknown): {
  name: string;
  httpStatusCode: number | undefined;
  requestId: string | undefined;
} {
  const shaped = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
  };
  const metadata = shaped?.$metadata;
  return {
    // PRESENCE, NOT TRUTHINESS, THE RULE THE TWO LINES BELOW EARNED ONE ROUND EARLIER WHILE THIS
    // LINE KEPT `&& shaped.name`. That collapsed a name PRESENT AND EMPTY into the absent-name word,
    // in the very producer whose contract says it keeps any string it is given. Kept, an empty name
    // renders as `\empty` where the sentence is written, absent still earns the fallback word, and
    // the operator can tell "the provider named nothing" from "the provider sent an empty name".
    name: typeof shaped?.name === 'string' ? shaped.name : 'UnknownProviderError',
    httpStatusCode:
      typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined,
    requestId: typeof metadata?.requestId === 'string' ? metadata.requestId : undefined,
  };
}

export function createBedrockEmbedder(options: BedrockEmbedderOptions): Embedder {
  const { modelId, dimensions, region } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const shape = options.requestShape ?? inferRequestShape(modelId);

  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Embedding dimensions must be a positive integer, received ${dimensions}.`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    // An unvalidated budget is worse than a wrong one: zero or NaN makes every call report a
    // timeout, and the message reads "did not respond within NaN ms" while nothing is wrong.
    throw new Error(`Embedding timeout must be a positive number of milliseconds, received ${timeoutMs}.`);
  }
  assertWidthSupported(shape, dimensions);

  const createClient =
    options.createClient ?? ((forRegion: string) => new BedrockRuntimeClient({ region: forRegion }));
  const client = options.client ?? createClient(region);

  return {
    // The audit row records this, so any stored vector can be traced to the exact model and width
    // that produced it. A mixed-width table is then visible in the data rather than inferred.
    id: `bedrock:${modelId}:${dimensions}`,
    dimensions,

    async embed(text: string, purpose: EmbeddingPurpose = 'document'): Promise<number[]> {
      const controller = new AbortController();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      // The deadline is enforced here rather than delegated. The SDK retries with sleeps that do
      // not observe the abort signal, so a throttled call can outlive the budget by seconds. The
      // abort still fires, to stop work we no longer want; the race is what makes the promise
      // settle on time.
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new EmbeddingTimeoutError(modelId, timeoutMs));
        }, timeoutMs);
      });

      let response: { body?: unknown };
      try {
        response = await Promise.race([
          client.send(
            new InvokeModelCommand({
              modelId,
              contentType: 'application/json',
              accept: 'application/json',
              body: buildRequestBody(shape, text, dimensions, purpose),
            }),
            { abortSignal: controller.signal },
          ),
          deadline,
        ]);
      } catch (error) {
        if (error instanceof EmbeddingTimeoutError) throw error;
        if (timedOut) {
          // The call failed because we aborted it. Keep the original on `cause` rather than
          // discarding it: if it was a real error that merely landed late, that is worth reading.
          throw new EmbeddingTimeoutError(modelId, timeoutMs, { cause: error });
        }
        const described = describeProviderError(error);
        throw new EmbeddingProviderError(
          modelId,
          described.name,
          { httpStatusCode: described.httpStatusCode, requestId: described.requestId },
          error,
        );
      } finally {
        clearTimeout(timer);
      }

      const vector = parseEmbedding(decodeBody(response.body));
      assertUsableVector(vector, modelId);

      if (vector.length !== dimensions) {
        throw new EmbeddingDimensionMismatchError(modelId, dimensions, vector.length);
      }
      return vector;
    },
  };
}

/**
 * Turn the response body into JSON.
 *
 * InvokeModel returns a `Uint8ArrayBlobAdapter`, so the byte-array branch is the one that runs in
 * production. The string and `transformToString` branches cover the other carriers the SDK types
 * allow, and an unrecognised carrier says so plainly rather than letting a `JSON.parse(undefined)`
 * surface three frames away.
 */
export function decodeBody(body: unknown): unknown {
  if (body === undefined || body === null) {
    throw new EmbeddingResponseError('The embedding response had no body.');
  }
  if (typeof body === 'string') return JSON.parse(body);
  if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body));

  const maybe = body as { transformToString?: () => string };
  if (typeof maybe.transformToString === 'function') {
    return JSON.parse(maybe.transformToString());
  }
  throw new EmbeddingResponseError(
    `The embedding response body was a ${typeof body} this adapter cannot decode.`,
  );
}
