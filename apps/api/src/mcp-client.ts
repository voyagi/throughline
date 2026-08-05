/**
 * The CockroachDB Cloud managed MCP server, as a read only client.
 *
 * This is the VERIFICATION CHANNEL. Its whole reason to exist is that it reaches the same rows over
 * a different transport, a different auth path and a different code path from the one the
 * application used, so `/status` and the demo can answer "do not take the console's word for it"
 * with something other than another sentence from the console.
 *
 * Everything below was MEASURED against the live endpoint on 2026-08-04 rather than read off the
 * documentation, and five of these facts would each have been guessed wrong:
 *
 * 1. EVERY FAILURE IS HTTP 200. Auth problems, refused statements, oversized results and internal
 *    errors all arrive as `{"jsonrpc":"2.0","id":n,"error":{"code":0,"message":"..."}}` with a 200
 *    status. `response.ok` carries no information at all here. A client that trusted it and then
 *    read `parsed.rows ?? []` would turn every error into an empty result set, which is the exact
 *    failure this product exists to argue against, committed by the component whose job is to
 *    catch it. Nothing in this file ever defaults a missing row set to empty.
 * 2. `cluster_id` IS EXCLUSIVE-OR WITH THE `mcp-cluster-id` HEADER. Sending both is refused with
 *    "cluster_id is set in your MCP config; omit the cluster_id argument"; sending neither is
 *    refused too. One function builds the arguments and the headers together so the two cannot
 *    drift apart.
 * 3. `select_query` SILENTLY APPLIES `LIMIT 25` TO A QUERY THAT DOES NOT STATE ONE, and a LIMIT
 *    inside a subquery does not count: measured at 25 rows returned from a 60 row source. For a
 *    channel whose entire job is independent verification that is the worst possible failure mode,
 *    a confident disagreement manufactured by the transport. So callers never write the bound.
 *    They pass a number, this file writes the clause, and a result whose size equals the bound is
 *    reported as possibly truncated rather than as an answer.
 * 4. THE REAL CEILING IS BYTES, NOT ROWS. The tool schema documents a maximum of 10000 rows, but
 *    the payload dies with "max result size exceeded" somewhere just past 10 KB of result text:
 *    1000 narrow rows (9903 characters) came back, 1500 did not, and 20 rows of 500 characters did
 *    not either. Verification queries are therefore built to be small, and this error gets a name
 *    of its own so it can never be mistaken for a disagreement about data.
 * 5. TIMESTAMPS CARRY MICROSECONDS. `now()` came back as "2026-08-04T11:55:43.795479Z" while the
 *    application side holds a JavaScript Date, which cannot represent that. Comparison happens in
 *    the verifier, at millisecond granularity, and says so.
 *
 * Two rules about failure, both carried over from the Bedrock embedder for the same reasons:
 *
 * THE TIMEOUT IS ENFORCED HERE, covering the whole exchange rather than one request. A handshake
 * plus a call plus a body read is three chances to hang, and `fetch` resolving its headers is not
 * the same as the body having arrived.
 *
 * ERRORS ARE CLASSIFIED, NOT ECHOED. A cloud error body routinely carries account identifiers, and
 * this text ends up in a coverage reason, which ends up on a page. Known failures are recognised by
 * pattern and answered with our own sentence; an unrecognised one gets a generic sentence and keeps
 * the original on `cause`, where a log may see it and a browser may not.
 *
 * NOTE ON SYNTAX: loaded by `node --experimental-strip-types`, which erases types but cannot emit
 * code. No constructor parameter properties, no enums. See tsconfig.base.json.
 */

import { z } from 'zod';

/**
 * The nine read tools this server advertises, confirmed by `tools/list` against the live endpoint.
 *
 * This list is a GUARD, not documentation. The service account behind it holds Cluster Admin,
 * which is what the managed MCP server requires, so the credential can create databases, create
 * tables and insert rows. The three write tools are named below and this client refuses them by
 * name. A verification channel that could write is not a verification channel.
 *
 * The allowlist is not the whole control, and saying so matters: `select_query` carries arbitrary
 * SQL, and CockroachDB documents a data-modifying CTE (`WITH w AS (INSERT ... RETURNING id)
 * SELECT ...`) as a SELECT, which is the obvious way past a guard that only reads tool names.
 * MEASURED 2026-08-05 against the live endpoint: the server inspects the CTE and refuses INSERT,
 * UPDATE and DELETE inside one, with "CTE contains a non-SELECT statement". So the read-only claim
 * rests on two independent controls, one of them the vendor's, and the vendor's is the one that
 * would have to fail silently for this channel to write.
 *
 * What would actually notice a vendor change, stated precisely because the tempting sentence here
 * is false: `npm run verify:mcp` sends a real CTE write and asserts the refusal. Nothing in the
 * offline suite can notice, because it feeds our own recorded string to our own classifier. And
 * `verify:mcp` is deliberately outside `npm run gate`, so this is caught when someone runs the
 * live proof, not on every build.
 */
export const READ_TOOLS = [
  'list_clusters',
  'get_cluster',
  'list_databases',
  'list_tables',
  'get_table_schema',
  'select_query',
  'explain_query',
  'show_statement',
  'show_running_queries',
] as const;

export type McpReadTool = (typeof READ_TOOLS)[number];

/** The complete write surface of this server. Named so the refusal can name it back. */
export const WRITE_TOOLS = ['create_database', 'create_table', 'insert_rows'] as const;

const READ_TOOL_SET: ReadonlySet<string> = new Set(READ_TOOLS);
const WRITE_TOOL_SET: ReadonlySet<string> = new Set(WRITE_TOOLS);

/** The documented ceiling on `select_query`. The byte ceiling bites long before this one. */
export const MAX_STATED_LIMIT = 10_000;

/**
 * Every way this channel can fail, as a value rather than as prose.
 *
 * `/status` and the tests branch on these. Matching on message text instead would make the wording
 * of a sentence load bearing, and the wording is the part most likely to change.
 */
export type McpFailureKind =
  | 'timeout'
  | 'transport_unreachable'
  | 'auth_rejected'
  | 'session_lost'
  | 'cluster_scope_conflict'
  | 'cluster_scope_missing'
  | 'statement_not_select'
  | 'statement_not_single'
  | 'restricted_schema'
  | 'result_too_large'
  | 'unknown_relation'
  | 'unrecognised_envelope'
  | 'read_only_violation'
  | 'query_not_bounded'
  | 'server_error';

/**
 * A failure of the verification channel, carrying a machine-readable kind and a sentence written
 * here rather than by the server.
 */
export class McpError extends Error {
  readonly kind: McpFailureKind;
  /**
   * The server's own words, with identifiers masked. For a log, never for a page: masking is a
   * best effort blocklist, while `message` above is written from scratch and cannot leak.
   *
   * READ IN PRODUCTION as of the HTTP surface: `apps/api/src/server.ts` logs it from `app.onError`,
   * masked, on any `McpError` that reaches a request handler. This docblock previously said nothing
   * read it and that the field should be deleted if the HTTP surface shipped without logging it.
   * That surface shipped and logs it, so the field stays and the condition is discharged rather
   * than quietly dropped.
   *
   * The log and never the response. The masking is a best effort blocklist, while `message` above
   * is written from scratch and cannot leak, which is why only the second one is served.
   */
  readonly serverMessage: string | undefined;

  constructor(
    kind: McpFailureKind,
    message: string,
    options?: { serverMessage?: string | undefined; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'McpError';
    this.kind = kind;
    this.serverMessage = options?.serverMessage;
  }
}

const mcpConfigSchema = z.object({
  CRDB_MCP_URL: z
    .string()
    .min(1, 'is empty')
    .refine((value) => value.startsWith('https://'), 'must be an https URL'),
  // No length or prefix rule here. The key format is the vendor's to change, and a client that
  // refuses to start because a credential stopped matching a shape someone assumed in August is a
  // worse failure than the one it was trying to prevent.
  CRDB_MCP_API_KEY: z.string().min(1, 'is empty'),
  CRDB_MCP_CLUSTER_ID: z.string().uuid('must be the cluster UUID from the Cloud console'),
  CRDB_MCP_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(5_000),
});

export interface McpConfig {
  readonly url: string;
  readonly apiKey: string;
  readonly clusterId: string;
  readonly timeoutMs: number;
}

/**
 * Read the channel's configuration, or say precisely what is missing without quoting any of it.
 *
 * Field names and the rule that failed only. The second field here is a credential that can read
 * every cluster in the organisation, and a validation error that echoes its input is the classic
 * way one reaches a CI log.
 */
export function loadMcpConfig(env: Record<string, string | undefined>): McpConfig {
  const parsed = mcpConfigSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new McpError(
      'transport_unreachable',
      `The CockroachDB Cloud MCP configuration is not usable: ${problems}. Fill CRDB_MCP_URL, ` +
        `CRDB_MCP_API_KEY and CRDB_MCP_CLUSTER_ID in .env. No value is shown here on purpose.`,
    );
  }
  return {
    url: parsed.data.CRDB_MCP_URL,
    apiKey: parsed.data.CRDB_MCP_API_KEY,
    clusterId: parsed.data.CRDB_MCP_CLUSTER_ID,
    timeoutMs: parsed.data.CRDB_MCP_TIMEOUT_MS,
  };
}

/**
 * Which side of the exclusive-or this client is standing on.
 *
 * `argument` puts the cluster id in the tool arguments, `header` puts it in `mcp-cluster-id`. The
 * server refuses both together and refuses neither, and it phrases the header as "your MCP config".
 * Both modes are supported because the live diagnostics prove the exclusion in both directions,
 * which is the only way to show that this client is on the right side of it by design rather than
 * by luck.
 */
export type ClusterScopeMode = 'argument' | 'header';

export interface ClusterScope {
  readonly args: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

/**
 * Build the arguments and the headers together, so the exclusive-or is structurally impossible to
 * break. Two call sites deciding this separately is exactly how "sending both" ships.
 */
export function applyClusterScope(
  mode: ClusterScopeMode,
  clusterId: string,
  args: Record<string, unknown>,
): ClusterScope {
  if (mode === 'header') {
    return { args: { ...args }, headers: { 'mcp-cluster-id': clusterId } };
  }
  return { args: { ...args, cluster_id: clusterId }, headers: {} };
}

/**
 * Anything that looks like an identifier, masked, for a line that goes to a log.
 *
 * Best effort and openly so. It is defence in depth behind `classifyServerMessage`, which is the
 * actual guarantee, because that one writes new text rather than filtering existing text.
 */
export function maskIdentifiers(text: string, apiKey?: string): string {
  let output = text;
  if (apiKey && apiKey.length >= 8) output = output.split(apiKey).join('[key]');
  return output
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[uuid]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]');
}

interface Classification {
  readonly kind: McpFailureKind;
  readonly sentence: string;
}

/**
 * Recognise a server failure by pattern and answer it in our own words.
 *
 * An allowlist, deliberately, rather than a filter over the server's text. A filter is a blocklist
 * and blocklists leak; every sentence returned here was written in this file. Each pattern below
 * was produced by an actual call to the live endpoint on 2026-08-04, and the exact strings are in
 * the tests.
 */
export function classifyServerMessage(message: string): Classification {
  const text = message.toLowerCase();

  if (text.includes('omit the cluster_id argument')) {
    return {
      kind: 'cluster_scope_conflict',
      sentence:
        'The verification channel sent the cluster id twice, as an argument and as a header. The ' +
        'server accepts exactly one of the two. This is a defect in this client, not a problem ' +
        'with the database.',
    };
  }
  if (text.includes('cluster_id not provided')) {
    return {
      kind: 'cluster_scope_missing',
      sentence:
        'The verification channel sent no cluster id at all, so the server did not know which ' +
        'cluster to read. This is a configuration problem on our side.',
    };
  }
  if (text.includes('only select statements are allowed')) {
    return {
      kind: 'statement_not_select',
      sentence:
        'The server refused the statement because it was not a SELECT. The verification channel ' +
        'is read only by design and this refusal is the server agreeing with that.',
    };
  }
  if (text.includes('exactly one statement')) {
    return {
      kind: 'statement_not_single',
      sentence: 'The server accepts one statement per call and this call carried more than one.',
    };
  }
  if (text.includes('restricted schema')) {
    return {
      kind: 'restricted_schema',
      sentence:
        'The server blocks reads of its internal schemas, so this question cannot be answered ' +
        'over the verification channel. Table structure comes from the get_table_schema tool ' +
        'instead of from information_schema.',
    };
  }
  if (text.includes('max result size exceeded')) {
    return {
      kind: 'result_too_large',
      sentence:
        'The answer was too large for this channel to carry, so nothing came back. That is a ' +
        'limit of the transport and says nothing about the data: it is never a disagreement. ' +
        'Ask for fewer rows or narrower columns.',
    };
  }
  if (text.includes('does not exist')) {
    return {
      kind: 'unknown_relation',
      sentence:
        'The server could not find the table this query names. The application and the ' +
        'verification channel may be pointed at different databases or schemas.',
    };
  }
  return {
    kind: 'server_error',
    sentence:
      'The verification channel could not complete the read. The server reported a failure whose ' +
      'text is deliberately not repeated here, because this sentence reaches an operator and a ' +
      'cloud error body can carry account identifiers. The original is on the cause.',
  };
}

/** Turn a classified failure into the error the rest of the system handles. */
function classifiedError(message: string, apiKey?: string, cause?: unknown): McpError {
  const classification = classifyServerMessage(message);
  return new McpError(classification.kind, classification.sentence, {
    serverMessage: maskIdentifiers(message, apiKey),
    cause,
  });
}

const emptyBody = (): McpError =>
  new McpError(
    'unrecognised_envelope',
    'The verification channel received an empty response body. An empty body is not an empty ' +
      'result: nothing was read, so nothing is known.',
  );

const unparseable = (cause?: unknown): McpError =>
  new McpError(
    'unrecognised_envelope',
    'The verification channel could not parse the response as JSON, so this read produced no ' +
      'knowledge at all rather than an empty result.',
    cause === undefined ? undefined : { cause },
  );

/**
 * No answer arrived. `detail` says WHICH of the ways that happened, because one sentence covering
 * four situations names the wrong one three times out of four, and this text is what an operator
 * reads when a verification could not be performed.
 *
 * The hazard sentence is attached only where a message that was not ours actually arrived. On a
 * stream that carried no other response at all there was nothing to be tempted by, and explaining
 * the temptation anyway sends the reader hunting for a foreign message that does not exist.
 */
const noAnswer = (
  detail: string,
  options: { cause?: unknown; anotherMessageArrived?: boolean } = {},
): McpError =>
  new McpError(
    'unrecognised_envelope',
    `The verification channel did not receive an answer to the request it sent: ${detail} ` +
      'Nothing was read, so nothing is known.' +
      (options.anotherMessageArrived
        ? ' Treating another message as the answer would put a different query\'s rows in front ' +
          'of this memory and report the mismatch as a divergence.'
        : ''),
    options.cause === undefined ? undefined : { cause: options.cause },
  );

/**
 * Does this message carry a server FAILURE? Decided on the error's VALUE, never on the key.
 *
 * `assertNoServerError` decides this same question by value (`!== undefined && !== null`), and the
 * two definitions must not drift apart, because a payload carrying `error: null` beside a `result`
 * is a SUCCESS to that function. When this one decided it by key presence, such a message
 * qualified for the id-null latitude meant for genuine failures, was handed back as our answer,
 * and the `result` inside it was then read as ROWS with nothing left to re-check the id. The
 * forbidden output was reachable purely through two functions disagreeing about one word, so there
 * is one definition of it and this is the one.
 */
function carriesError(parsed: object): boolean {
  const error = (parsed as { error?: unknown }).error;
  return error !== undefined && error !== null;
}

function isResponseShaped(parsed: unknown): parsed is object {
  return !!parsed && typeof parsed === 'object' && ('result' in parsed || carriesError(parsed));
}

/**
 * A failure the server could not attribute to a request: `id: null` on a real error, which is what
 * JSON-RPC requires when it cannot tell which request failed.
 *
 * It is still OUR failure, because this exchange is one request on one connection. Discarding it
 * would replace a named cause ("the answer was too large for this channel to carry") with "no
 * answer arrived", losing the classification, the server's own words and the cause together, on
 * the one code path whose entire job is to say WHY a read did not happen. Note what this does NOT
 * extend to: a RESULT is never accepted on these terms, because rows that cannot be attributed to
 * this request are the whole hazard.
 */
function isUnattributableFailure(parsed: unknown): boolean {
  return (
    !!parsed &&
    typeof parsed === 'object' &&
    (parsed as { id?: unknown }).id === null &&
    carriesError(parsed)
  );
}

/**
 * Does this message answer the request we sent, as opposed to merely being an answer?
 *
 * Shape alone is not enough and the difference is not academic. Returning the first response on the
 * stream regardless of which request it answers hands the caller ANOTHER request's rows, and those
 * rows are then compared against this memory and reported as a divergence: a claim about the
 * database assembled from someone else's answer, with `failure: null` on it. When no id is stated
 * the shape check stands alone, which is the protocol's own position for a plain body.
 */
function answersRequest(parsed: unknown, expectedId?: number | string): boolean {
  if (!isResponseShaped(parsed)) return false;
  if (expectedId === undefined) return true;
  return (parsed as { id?: unknown }).id === expectedId;
}

/**
 * The `data:` payload of each SSE event, in order, with empty events dropped.
 *
 * Per EVENT, not per body. This transport is explicitly allowed to deliver other messages before
 * the answer to our request, and joining `data:` lines across event boundaries splices two JSON
 * documents into one unparseable string: the channel would break against a server doing nothing
 * wrong, and break as "unrecognised envelope", which reads like a defect in the database rather
 * than in this client. Within a single event the lines ARE joined with newlines, which is what the
 * SSE specification says and is not the same as taking the last line.
 *
 * The boundary below is one character wider than the specification, which dispatches on an EMPTY
 * line: a line holding only spaces or tabs is a field, not a boundary. That latitude is kept, and
 * the reason it was first written down here was WRONG, so the correct version is worth stating.
 *
 * The claim was that both readings fail closed. They do not. A review measured the shape that
 * separates them: one event carrying a complete JSON-RPC document on its first `data:` line, then
 * a whitespace-only line, then a `data:` line of garbage. This reader splits there and returns the
 * complete document; a specification-conformant reader joins the two halves, fails to parse, and
 * reports the read as unread. So against a server that puts whitespace on its blank lines, this is
 * the more permissive of the two, not the safer one.
 *
 * It stays because the permissiveness is bounded by something other than this function. Whatever
 * comes back still has to carry the id we sent, so the worst case is answering with a complete,
 * correctly addressed response that arrived in a malformed frame. It cannot deliver another
 * query's rows, which is the failure this module exists to prevent. Narrowing to the specification
 * would trade that for a channel that reports UNKNOWN against a server doing something no server
 * has been measured doing, and changing this transport is how two fail-open defects were
 * introduced here before. The behaviour is pinned by tests in both shapes.
 */
function sseEventPayloads(rawBody: string): string[] {
  return rawBody
    .split(/\r?\n[ \t]*\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n'),
    )
    .filter((data) => data.trim() !== '');
}

function extractFromPlainBody(rawBody: string, expectedId?: number | string): unknown {
  if (!rawBody.trim()) throw emptyBody();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch (cause) {
    throw unparseable(cause);
  }
  if (expectedId === undefined || answersRequest(parsed, expectedId)) return parsed;
  if (isUnattributableFailure(parsed)) return parsed;
  throw noAnswer('the body carried a message that does not answer it.', {
    cause: parsed,
    anotherMessageArrived: true,
  });
}

function extractFromEventStream(rawBody: string, expectedId?: number | string): unknown {
  const payloads = sseEventPayloads(rawBody);
  if (payloads.length === 0) throw emptyBody();

  let parseFailure: unknown;
  // Kept so the throw below can say whether the stream held OTHER requests' answers or no answer
  // at all, and can carry one along as a cause for the log. Those are different operational
  // situations and the distinction is free to preserve.
  let foreignResponse: unknown;
  let unattributableFailure: unknown;

  for (const data of payloads) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (cause) {
      parseFailure = cause;
      continue;
    }
    if (answersRequest(parsed, expectedId)) return parsed;
    // Held back rather than returned on sight. Our own answer may still be further down the
    // stream, and an unattributable failure arriving first must not pre-empt it: the same two
    // messages in the other order would otherwise give two different results.
    if (isUnattributableFailure(parsed)) unattributableFailure ??= parsed;
    else if (isResponseShaped(parsed)) foreignResponse ??= parsed;
  }

  // Before the unattributable failure: an event we could not parse might have BEEN our answer, so
  // "the stream did not read" is the honest reason, rather than pinning our outcome on somebody
  // else's error.
  if (parseFailure !== undefined) throw unparseable(parseFailure);
  if (unattributableFailure !== undefined) return unattributableFailure;
  if (foreignResponse !== undefined) {
    throw noAnswer('the stream ended after messages answering other requests.', {
      cause: foreignResponse,
      anotherMessageArrived: true,
    });
  }
  throw noAnswer('the stream carried messages, but none of them was a result or an error.');
}

/**
 * Pull the JSON-RPC payload out of the HTTP body, or say why there is none.
 *
 * This endpoint answers `tools/call` as `text/event-stream` even for a single response, so the
 * plain JSON path exists for the protocol rather than for this server. Both paths obey the same
 * two rules, and they are the reason this is not a one-line `JSON.parse`: only a message answering
 * `expectedId` is our answer, and the sole exception is a failure the server could not attribute.
 *
 * Passing no `expectedId` turns the first rule off, and the two paths differ in what survives it,
 * so this says which rather than rounding it to "the id check". On the SSE path the shape check
 * still stands and a payload must be a result or an error to be returned. On the plain path both
 * checks are short circuited and a body of `42` comes back as `42`. Nothing in this client reaches
 * that: `exchange` sends an id with every request that expects an answer, and one without an id is
 * a notification, which is never parsed at all.
 */
export function extractRpcPayload(
  rawBody: string,
  contentType: string | null,
  expectedId?: number | string,
): unknown {
  return (contentType ?? '').includes('text/event-stream')
    ? extractFromEventStream(rawBody, expectedId)
    : extractFromPlainBody(rawBody, expectedId);
}

/**
 * Throw if the payload carries a server failure, and hand back the tool result if it does not.
 *
 * Every path into this server goes through here, which is the point. An earlier version left this
 * to `readRows`, so `callReadTool` returned the raw envelope and a caller who did not think to
 * parse it got an error object that looked exactly like a successful response. A live check caught
 * it: "sending both cluster ids is refused by the server" reported no error at all, because the
 * refusal was sitting unread inside the value it returned. An API whose error path can be skipped
 * by forgetting something is the shape this whole module argues against.
 */
export function assertNoServerError(
  payload: unknown,
  apiKey?: string,
): { isError?: unknown; content?: unknown } {
  if (!payload || typeof payload !== 'object') {
    throw new McpError(
      'unrecognised_envelope',
      `The verification channel expected a JSON-RPC object and received ${payload === null ? 'null' : typeof payload}.`,
    );
  }
  const body = payload as { error?: unknown; result?: unknown };

  if (body.error !== undefined && body.error !== null) {
    const error = body.error as { message?: unknown };
    const message = typeof error.message === 'string' ? error.message : '';
    throw classifiedError(message, apiKey, body.error);
  }

  const result = body.result as { isError?: unknown; content?: unknown } | undefined;
  if (!result || typeof result !== 'object') {
    throw new McpError(
      'unrecognised_envelope',
      'The verification channel received a response carrying neither a result nor an error. ' +
        'Nothing was read, so nothing is known.',
    );
  }

  // The protocol allows a tool to report failure inside a successful response. This server does not
  // use that shape today (measured: `isError` was absent on every failure), but honouring it costs
  // one branch and turns a future change from "unrecognised envelope" into a named cause.
  if (result.isError === true) {
    throw classifiedError(firstTextContent(result.content) ?? '', apiKey, result);
  }
  return result;
}

/**
 * The rows a `select_query` returned, or a named failure. Never an empty array by default.
 *
 * The order of the checks below is the whole point. A success is `{"rows":[...]}` and a failure is
 * a sibling `error` member with no `result` at all, and both arrive as HTTP 200. Reaching for
 * `rows` first and falling back to `[]` would report every outage as "the database has no such
 * row", which in this product is a verified divergence.
 */
export function readRows(payload: unknown, apiKey?: string): Record<string, unknown>[] {
  const result = assertNoServerError(payload, apiKey);
  const text = firstTextContent(result.content);

  if (text === undefined) {
    throw new McpError(
      'unrecognised_envelope',
      'The verification channel received a result with no text content to read.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new McpError(
      'unrecognised_envelope',
      'The verification channel received result text that is not JSON, so no rows could be read. ' +
        'This is not the same as reading zero rows.',
      { cause },
    );
  }

  // `JSON.parse` returns null, a number or a string just as happily as an object, and reading
  // `.rows` off one of those throws a bare TypeError that would leave this module unnamed and
  // unclassified. Everything below needs an object.
  if (!parsed || typeof parsed !== 'object') {
    throw new McpError(
      'unrecognised_envelope',
      'The verification channel received result text that is not a JSON object, so no rows could ' +
        'be read. This is not the same as reading zero rows.',
    );
  }

  const envelope = parsed as { rows?: unknown; message?: unknown };
  if (Array.isArray(envelope.rows)) {
    // Every ELEMENT is checked, not just the array. A row that is null, a number or a string is not
    // a row this channel can read, and handing it on would let the SHAPE of a response become a
    // claim about the database: downstream a falsy row reads as "no row came back", which renders
    // as the application holding a memory the cluster does not have. That is the single output this
    // whole module exists to prevent, so an unreadable row is named here instead.
    return envelope.rows.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new McpError(
          'unrecognised_envelope',
          `The verification channel returned a row set whose entry at position ${index} is not a ` +
            'row object, so it cannot be compared. An unreadable row is not an absent row.',
        );
      }
      return row as Record<string, unknown>;
    });
  }
  // The tool-level error shape, kept for the same reason as `isError` above: it is what a JSON
  // object with a `message` and no `rows` means, and treating it as zero rows would be the one
  // mistake this file exists to prevent.
  if (typeof envelope.message === 'string') {
    throw classifiedError(envelope.message, apiKey, parsed);
  }
  throw new McpError(
    'unrecognised_envelope',
    'The verification channel read a response with no row set in it. Reporting that as zero rows ' +
      'would turn a transport failure into a claim about the data.',
  );
}

function firstTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : undefined;
}

/**
 * Attach the row bound that the server would otherwise attach silently and differently.
 *
 * Callers pass a number and never write the clause, because the server's own rule is subtle in a
 * way that reads as fine: a LIMIT inside a subquery does NOT satisfy it, and the outer query is
 * capped at 25 with no flag anywhere in the response. Any query text that already mentions a bound
 * is refused rather than accommodated, so the failure is loud and local instead of quiet and
 * remote. A semicolon is refused for the same reason plus one more: this server takes exactly one
 * statement, and a template that grew a second one should fail here rather than there.
 */
export function stripStringLiterals(sql: string): string {
  // Single quoted literals only, with '' as the escape, which is all this codebase ever builds.
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

export function buildBoundedQuery(sql: string, limit: number): string {
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_STATED_LIMIT) {
    throw new McpError(
      'query_not_bounded',
      `A verification read needs a whole number row bound between 1 and ${MAX_STATED_LIMIT}, and ` +
        `this one asked for ${limit}. The server applies its own bound of 25 when a query states ` +
        `none, so an unbounded read here would come back quietly truncated.`,
    );
  }
  if (/;/.test(sql)) {
    throw new McpError(
      'query_not_bounded',
      'A verification query may not contain a semicolon. This server takes exactly one statement ' +
        'per call, and the bound is appended to the end of this text.',
    );
  }
  // Tested with string literals removed first. Without that step a workspace legitimately called
  // "rate-limit" makes its own memories unverifiable, because the id is interpolated into the text
  // and `\blimit\b` matches across the hyphen. It fails loudly rather than silently, which is the
  // right direction for a bug, but refusing to verify a real workspace is still refusing to verify.
  if (/\b(limit|fetch\s+first)\b/i.test(stripStringLiterals(sql))) {
    throw new McpError(
      'query_not_bounded',
      'A verification query must not write its own row bound. This client appends one, because a ' +
        'bound inside a subquery does not bound the statement and the server then silently ' +
        'applies 25 with nothing in the response to say so.',
    );
  }
  return `${sql.trimEnd()} LIMIT ${limit}`;
}

export interface McpSelectResult {
  readonly rows: readonly Record<string, unknown>[];
  /** The bound this client attached, so a caller can reason about the number below. */
  readonly limit: number;
  /**
   * True when exactly as many rows came back as were asked for.
   *
   * Not a claim that rows were dropped, a refusal to claim they were not. The server sends no
   * indication either way, so a full result and a truncated one are indistinguishable from here.
   */
  readonly possiblyTruncated: boolean;
  readonly elapsedMs: number;
}

export interface McpClient {
  /** Run one bounded SELECT. The caller supplies the text and the bound, never the clause. */
  select(request: { database: string; sql: string; limit: number }): Promise<McpSelectResult>;
  /** Call any READ tool. Refuses every write tool by name. */
  callReadTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /**
   * Forget the cached session, so the next call re-handshakes.
   *
   * No production caller yet, and saying so is the point: the lost-session path re-handshakes on
   * its own, so this exists for a caller with an outside reason to distrust the cached session and
   * is exercised only by the suite. If the HTTP surface never finds that reason, this should go
   * rather than sit here looking like part of the protocol.
   */
  reset(): void;
  /** Which side of the cluster id exclusive-or this instance is using. */
  readonly clusterScope: ClusterScopeMode;
}

/** The slice of `fetch` this client needs, so a test can supply a double with no network. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface McpClientOptions {
  readonly config: McpConfig;
  readonly clusterScope?: ClusterScopeMode;
  readonly fetchImpl?: FetchLike;
  /** Injected in tests so the elapsed number in a receipt can be asserted rather than tolerated. */
  readonly now?: () => number;
}

const PROTOCOL_VERSION = '2025-06-18';

/**
 * A request carries an id and is owed an answer. A notification carries none and is owed nothing.
 *
 * These are two types rather than one optional field because `exchange` decides whether to parse a
 * response by asking which of them it was handed, and that decision used to be a separate boolean
 * flag. A flag can disagree with the body it describes: a request sent with `expectPayload: true`
 * and no id would have had its id check silently turned off, in the one module whose header argues
 * that the shape of a message is not the identity of a message. Here the state cannot be built.
 */
type RpcRequest = {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

type RpcNotification = {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

export function createMcpClient(options: McpClientOptions): McpClient {
  const { config } = options;
  const clusterScope = options.clusterScope ?? 'argument';
  const now = options.now ?? (() => Date.now());
  const doFetch: FetchLike =
    options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);

  let sessionId: string | null = null;
  // Tracked separately from the session id, because a server is allowed to issue no session at all
  // and `tools/list` was measured working without one. Keying "have we handshaken" off the id would
  // make every single call re-handshake against such a server, quietly doubling every round trip.
  let handshakeComplete = false;
  let negotiatedProtocol = PROTOCOL_VERSION;
  let requestId = 0;

  /**
   * One HTTP exchange, bounded by a deadline that covers the body as well as the headers.
   *
   * The body read is raced separately and deliberately. `fetch` settling means the response line
   * and the headers arrived, which on a streaming transport is a long way from having the answer,
   * so a deadline that only wrapped the first await would be a budget the caller cannot rely on.
   */
  async function exchange(
    body: RpcRequest | RpcNotification,
    extraHeaders: Record<string, string>,
    deadlineAt: number,
  ): Promise<{ status: number; sessionHeader: string | null; payload: unknown }> {
    const remaining = deadlineAt - now();
    if (remaining <= 0) throw timeoutError(config.timeoutMs);

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError(config.timeoutMs));
      }, remaining);
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.apiKey}`,
      ...extraHeaders,
    };
    if (sessionId) {
      headers['mcp-session-id'] = sessionId;
      // Required of a client from this protocol revision onward on every request after the
      // handshake. Sent for correctness rather than because this server currently insists.
      headers['mcp-protocol-version'] = negotiatedProtocol;
    }

    try {
      const response = await Promise.race([
        doFetch(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        deadline,
      ]);

      if (response.status === 401 || response.status === 403) {
        throw new McpError(
          'auth_rejected',
          'The CockroachDB Cloud MCP server rejected the credential. The service account key is ' +
            'wrong, revoked, or lacks Cluster Admin on this cluster. Nothing was read.',
        );
      }
      // A session the server has forgotten. Reported so the caller can re-handshake once, rather
      // than being folded into a generic failure that a retry would be reckless against.
      if (response.status === 404 && sessionId) {
        throw new McpError(
          'session_lost',
          'The verification channel session expired and the server no longer recognises it.',
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new McpError(
          'transport_unreachable',
          `The CockroachDB Cloud MCP server answered with HTTP ${response.status}. The body is ` +
            'deliberately not repeated, because a cloud error body can carry account identifiers.',
        );
      }

      const raw = await Promise.race([response.text(), deadline]);
      const sessionHeader = response.headers.get('mcp-session-id');

      // A JSON-RPC notification carries no id and is answered, measured against the live endpoint,
      // with `202 Accepted` and a zero byte body. Only a request that asked for a result may treat
      // a missing one as a failure. Getting this backwards is not a small bug: the notification is
      // part of the handshake, so a client that insists on parsing it cannot complete a handshake
      // at all, and unit tests will not notice if their double answers more helpfully than the
      // server does.
      //
      // Read off the body rather than from a flag beside it, so "expects an answer" and "has an id
      // to recognise the answer by" are the same fact and cannot come apart.
      if (!('id' in body)) {
        return { status: response.status, sessionHeader, payload: null };
      }
      return {
        status: response.status,
        sessionHeader,
        // The id we sent, so the parser can tell an answer to THIS request from any other message
        // sharing the stream.
        payload: extractRpcPayload(raw, response.headers.get('content-type'), body.id),
      };
    } catch (error) {
      if (error instanceof McpError) throw error;
      if (timedOut) throw timeoutError(config.timeoutMs, error);
      throw new McpError(
        'transport_unreachable',
        'The verification channel could not reach the CockroachDB Cloud MCP server, so the ' +
          'independent read did not happen. This is not evidence about the data.',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function handshake(deadlineAt: number): Promise<void> {
    sessionId = null;
    handshakeComplete = false;
    const { payload, sessionHeader } = await exchange(
      {
        jsonrpc: '2.0',
        // Incremented, not reused, and it matters beyond tidiness. The retry path re-handshakes
        // after a tool call has already failed, so an id that did not move would send an
        // `initialize` carrying the id of the call that just failed, and any late answer to that
        // call would then satisfy the id check on the handshake.
        id: (requestId += 1),
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'throughline-verification-channel', version: '0.1.0' },
        },
      },
      {},
      deadlineAt,
    );

    // The handshake is held to the same rule as every other call, and it was not. This server
    // reports EVERY failure as a JSON-RPC error at HTTP 200, so an `initialize` that was refused
    // arrived here as an ordinary payload: the error was never classified, its kind and the
    // server's own words were dropped, `handshakeComplete` was set anyway, and the first anyone
    // heard of it was whatever the next call happened to say. A `result: null` completed a
    // handshake outright. The one exchange that establishes the session is the worst place in this
    // client to lose a reason.
    const result = assertHandshakeAccepted(payload, config.apiKey);
    if (typeof result.protocolVersion === 'string') negotiatedProtocol = result.protocolVersion;
    sessionId = sessionHeader;

    if (sessionId) {
      // A notification. Skipping it leaves the server holding a half-open session, and expecting a
      // body back from it breaks the handshake: measured, this endpoint answers 202 with no body.
      // It carries no id, which is what tells `exchange` not to wait for one.
      await exchange({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}, deadlineAt);
    }
    handshakeComplete = true;
  }

  async function call(
    name: string,
    args: Record<string, unknown>,
    deadlineAt: number,
  ): Promise<unknown> {
    const scoped = applyClusterScope(clusterScope, config.clusterId, args);
    const { payload } = await exchange(
      {
        jsonrpc: '2.0',
        id: (requestId += 1),
        method: 'tools/call',
        params: { name, arguments: scoped.args },
      },
      scoped.headers,
      deadlineAt,
    );
    return payload;
  }

  async function callReadTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    assertReadOnly(name);
    const deadlineAt = now() + config.timeoutMs;
    if (!handshakeComplete) await handshake(deadlineAt);

    try {
      const payload = await call(name, args, deadlineAt);
      // Checked HERE rather than left to whoever reads the payload. A server failure that only
      // surfaces if the caller remembers to look is not a failure anyone will surface.
      assertNoServerError(payload, config.apiKey);
      return payload;
    } catch (error) {
      // Exactly one retry, and only for a session the server forgot. Anything else is retried by a
      // human who has read the reason, because a channel that silently retries a failing read is
      // how a flaky verification becomes a trusted one.
      if (error instanceof McpError && error.kind === 'session_lost') {
        await handshake(deadlineAt);
        const retried = await call(name, args, deadlineAt);
        assertNoServerError(retried, config.apiKey);
        return retried;
      }
      throw error;
    }
  }

  return {
    clusterScope,

    reset(): void {
      sessionId = null;
      handshakeComplete = false;
    },

    callReadTool,

    async select(request): Promise<McpSelectResult> {
      const query = buildBoundedQuery(request.sql, request.limit);
      const startedAt = now();
      const payload = await callReadTool('select_query', {
        database: request.database,
        query,
      });
      const rows = readRows(payload, config.apiKey);
      return {
        rows,
        limit: request.limit,
        possiblyTruncated: rows.length >= request.limit,
        elapsedMs: now() - startedAt,
      };
    },
  };
}

/**
 * The handshake held to the same failure rules as every other call, in its own words.
 *
 * The rules are `assertNoServerError`'s and are not restated. What is restated is the SENTENCE,
 * and only for a failure the server reported: every sentence `classifyServerMessage` writes was
 * measured on a `tools/call` and describes one, so handed a refused `initialize` it will say "the
 * server could not find the table this query names" about an exchange containing no table and no
 * query. A true sentence about the wrong situation is most of what this module spends its length
 * avoiding, and it reaches an operator.
 *
 * The KIND is kept, because it is the machine-readable half and it is drawn from the server's own
 * words rather than from the situation. So is `serverMessage`, masked, and the original on the
 * cause.
 *
 * The sentence says "nothing was read" and deliberately does not say "no read was attempted",
 * which an earlier version did and which is false by one `tools/call`. There are two routes into a
 * handshake: before anything, and the re-handshake that a lost session triggers AFTER a read has
 * already gone out and come back 404. This text lands verbatim on a verification report, so a
 * sentence true on only one of the two routes is the defect this module spends its length on.
 *
 * The discriminator is exact rather than convenient: `classifyServerMessage` cannot return
 * `unrecognised_envelope`, so that kind is always one of this function's own structural
 * complaints, and those are already written for any exchange. "A response carrying neither a
 * result nor an error" is as true of a handshake as of a read, and stays.
 */
function assertHandshakeAccepted(payload: unknown, apiKey: string): { protocolVersion?: unknown } {
  try {
    return assertNoServerError(payload, apiKey) as { protocolVersion?: unknown };
  } catch (error) {
    if (error instanceof McpError && error.kind !== 'unrecognised_envelope') {
      throw new McpError(
        error.kind,
        'The verification channel could not open a session with the CockroachDB Cloud MCP ' +
          'server, because the handshake itself was refused. Nothing was read, so nothing is ' +
          "known about any data. The server's own words are kept on the cause rather than " +
          'repeated here, and the failure is named above.',
        { serverMessage: error.serverMessage, cause: error },
      );
    }
    throw error;
  }
}

/** Refuse a tool that is not on the read list, and name a write tool as a write tool. */
export function assertReadOnly(name: string): void {
  if (READ_TOOL_SET.has(name)) return;
  if (WRITE_TOOL_SET.has(name)) {
    throw new McpError(
      'read_only_violation',
      `"${name}" writes to the cluster and this channel is read only. Refusing the tool by name ` +
        'is the control that stopped this call, and it is needed because the service account ' +
        'behind the channel holds Cluster Admin: the managed MCP server requires it. The other ' +
        'route to a write is arbitrary SQL through select_query, which this call is not, and that ' +
        'route is closed by the server itself refusing a write smuggled into a CTE, measured ' +
        'rather than assumed.',
    );
  }
  throw new McpError(
    'read_only_violation',
    `"${name}" is not one of the read tools this server advertises (${READ_TOOLS.join(', ')}). ` +
      'An unknown tool is refused rather than attempted, because this credential can do more than ' +
      'this channel is allowed to.',
  );
}

function timeoutError(timeoutMs: number, cause?: unknown): McpError {
  return new McpError(
    'timeout',
    `The verification channel did not answer within ${timeoutMs} ms. The independent read did not ` +
      'happen, so the result is unknown rather than absent.',
    cause === undefined ? undefined : { cause },
  );
}
