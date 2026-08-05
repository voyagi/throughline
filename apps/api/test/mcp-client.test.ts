import { describe, expect, it } from 'vitest';
import {
  applyClusterScope,
  assertReadOnly,
  buildBoundedQuery,
  classifyServerMessage,
  stripStringLiterals,
  createMcpClient,
  extractRpcPayload,
  loadMcpConfig,
  maskIdentifiers,
  MAX_STATED_LIMIT,
  McpError,
  READ_TOOLS,
  readRows,
  WRITE_TOOLS,
  type FetchLike,
  type McpConfig,
} from '../src/mcp-client.ts';

/**
 * Every literal server message in this file was produced by an actual call to the live CockroachDB
 * Cloud MCP endpoint on 2026-08-04. They are fixtures in the strict sense: if the vendor changes
 * the wording, these tests fail and the classifier gets updated, which is the point. A test written
 * against invented wording would pass forever and prove nothing about the real server.
 */
const LIVE_MESSAGES = {
  bothClusterIds: 'cluster_id is set in your MCP config; omit the cluster_id argument',
  noClusterId: 'cluster_id not provided: pass it as a tool argument or configure it in your MCP config',
  notSelect: 'only SELECT statements are allowed, got UPDATE',
  // Measured 2026-08-05. The read-only guard in this client is a tool-name allowlist, and
  // `select_query` takes arbitrary SQL, so the obvious way past it is a data-modifying CTE
  // (`WITH w AS (INSERT ... RETURNING id) SELECT ...`), which CockroachDB documents as a SELECT.
  // The server inspects the CTE and refuses INSERT, UPDATE and DELETE inside one, each with this
  // wording. That is what makes "this channel cannot write" a measured claim rather than a hope,
  // and if the vendor ever stops checking, this fixture is what notices.
  notSelectInCte: 'CTE contains a non-SELECT statement: only SELECT statements are allowed, got INSERT',
  notSingle: 'must contain exactly one statement',
  restricted:
    'query references a restricted schema: access to "information_schema" is blocked for security reasons',
  tooLarge: 'executing select query: executing stmt 1: max result size exceeded',
  noRelation:
    'executing select query: executing stmt 1: run-query-via-api: relation "nope" does not exist',
};

const CONFIG: McpConfig = {
  url: 'https://cockroachlabs.cloud/mcp',
  apiKey: 'EXAMPLE-NOT-A-REAL-KEY-not-a-real-key-000000000000000000',
  clusterId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  timeoutMs: 2_000,
};

interface Recorded {
  readonly headers: Record<string, string>;
  readonly body: {
    id?: number;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
}

/**
 * Echo the request's id onto a canned answer, the way a JSON-RPC server does.
 *
 * These doubles used to answer every request with a hardcoded `id: 1` while the client numbers its
 * requests from one upward, so every answer to a `tools/call` carried the id of the handshake. The
 * client accepted them because it never checked, and a stream carrying a response to somebody
 * else's request was therefore indistinguishable from an answer to ours. Same rule as the 202
 * notification above, which is the second time this file has earned it: a double that is kinder
 * than the server hides exactly the defect it is standing in for.
 */
function echoId(payload: unknown, id: number | undefined): unknown {
  return payload && typeof payload === 'object' ? { ...(payload as object), id } : payload;
}

/** A response that looks like the live one: SSE framed, HTTP 200, one `message` event. */
function sse(payload: unknown, sessionId = 'session-1', status = 200) {
  return {
    status,
    headers: {
      get(name: string): string | null {
        if (name === 'content-type') return 'text/event-stream';
        if (name === 'mcp-session-id') return sessionId;
        return null;
      },
    },
    text: (): Promise<string> => Promise.resolve(`event: message\ndata: ${JSON.stringify(payload)}\n\n`),
  };
}

/**
 * What the live endpoint actually returns for a notification: 202 Accepted, no content type, zero
 * bytes.
 *
 * This double used to answer notifications with a full SSE envelope, which is easier to satisfy
 * than production and hid a real defect: the client parsed every response as JSON-RPC, so against
 * the real server it threw on an empty body and could never complete a handshake. Sixteen green
 * tests said otherwise. The rule this earns a second time in this repository: a double that is
 * kinder than the system it stands in for is a test that proves less than it appears to.
 */
function accepted() {
  return {
    status: 202,
    headers: { get: (): string | null => null },
    text: (): Promise<string> => Promise.resolve(''),
  };
}

const rowsPayload = (rows: unknown[]): unknown => ({
  jsonrpc: '2.0',
  id: 1,
  result: { content: [{ type: 'text', text: JSON.stringify({ rows }) }] },
});

const errorPayload = (message: string): unknown => ({
  jsonrpc: '2.0',
  id: 1,
  error: { code: 0, message },
});

/**
 * A fetch double that records every exchange and answers `tools/call` from a script.
 *
 * The handshake is answered generically because every test needs it and no test is about it,
 * except the ones that assert on `recorded` directly.
 */
function fakeFetch(
  answers: unknown[],
  recorded: Recorded[],
  options: { onCall?: () => void } = {},
): FetchLike {
  let callIndex = 0;
  return (_url, init) => {
    const body = JSON.parse(init.body) as Recorded['body'];
    recorded.push({ headers: init.headers, body });
    if (body.method === 'initialize') {
      return Promise.resolve(
        sse(echoId({ jsonrpc: '2.0', result: { protocolVersion: '2025-06-18', serverInfo: {} } }, body.id)),
      );
    }
    if (body.method === 'notifications/initialized') {
      return Promise.resolve(accepted());
    }
    options.onCall?.();
    const answer = answers[Math.min(callIndex, answers.length - 1)];
    callIndex += 1;
    return Promise.resolve(sse(echoId(answer, body.id)));
  };
}

function toolCalls(recorded: Recorded[]): Recorded[] {
  return recorded.filter((entry) => entry.body.method === 'tools/call');
}

describe('loadMcpConfig', () => {
  it('reads the three variables the channel needs', () => {
    const config = loadMcpConfig({
      CRDB_MCP_URL: 'https://cockroachlabs.cloud/mcp',
      CRDB_MCP_API_KEY: 'EXAMPLE-NOT-A-REAL-KEY-something',
      CRDB_MCP_CLUSTER_ID: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    });
    expect(config.url).toBe('https://cockroachlabs.cloud/mcp');
    expect(config.timeoutMs).toBe(5_000);
  });

  it('never echoes the credential it rejects', () => {
    // The exact failure this guards: a validation error that quotes its input puts a key that can
    // read every cluster in the organisation into a CI log.
    const secret = 'EXAMPLE-NOT-A-REAL-KEY-that-must-not-be-echoed-back';
    let message = '';
    try {
      loadMcpConfig({
        CRDB_MCP_URL: 'http://insecure.example',
        CRDB_MCP_API_KEY: secret,
        CRDB_MCP_CLUSTER_ID: 'not-a-uuid',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('CRDB_MCP_URL');
    expect(message).toContain('CRDB_MCP_CLUSTER_ID');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('insecure.example');
  });

  it('refuses a plain http endpoint', () => {
    expect(() =>
      loadMcpConfig({
        CRDB_MCP_URL: 'http://cockroachlabs.cloud/mcp',
        CRDB_MCP_API_KEY: 'k',
        CRDB_MCP_CLUSTER_ID: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      }),
    ).toThrow(/https/);
  });

  it('refuses a cluster id that is not a UUID, because the service account id is not one either', () => {
    expect(() =>
      loadMcpConfig({
        CRDB_MCP_URL: 'https://cockroachlabs.cloud/mcp',
        CRDB_MCP_API_KEY: 'k',
        CRDB_MCP_CLUSTER_ID: 'third-mammoth-30736',
      }),
    ).toThrow(/cluster UUID/);
  });
});

describe('applyClusterScope', () => {
  it('puts the cluster id in the arguments and nothing in the headers', () => {
    const scoped = applyClusterScope('argument', 'cluster-9', { database: 'defaultdb' });
    expect(scoped.args).toEqual({ database: 'defaultdb', cluster_id: 'cluster-9' });
    expect(scoped.headers).toEqual({});
  });

  it('puts the cluster id in the header and NOT in the arguments', () => {
    const scoped = applyClusterScope('header', 'cluster-9', { database: 'defaultdb' });
    expect(scoped.args).toEqual({ database: 'defaultdb' });
    expect(scoped.headers).toEqual({ 'mcp-cluster-id': 'cluster-9' });
  });

  it('carries the cluster id exactly once, whichever mode is chosen', () => {
    // The live server refuses both together and refuses neither. Measured 2026-08-04.
    for (const mode of ['argument', 'header'] as const) {
      const scoped = applyClusterScope(mode, 'cluster-9', { database: 'defaultdb' });
      const inArgs = 'cluster_id' in scoped.args ? 1 : 0;
      const inHeaders = 'mcp-cluster-id' in scoped.headers ? 1 : 0;
      expect(inArgs + inHeaders).toBe(1);
    }
  });

  it('does not mutate the callerArguments it was handed', () => {
    const original = { database: 'defaultdb' };
    applyClusterScope('argument', 'cluster-9', original);
    expect(original).toEqual({ database: 'defaultdb' });
  });
});

describe('assertReadOnly', () => {
  it('permits every tool the server advertises as a read', () => {
    for (const tool of READ_TOOLS) expect(() => assertReadOnly(tool)).not.toThrow();
  });

  it('refuses every write tool by name', () => {
    for (const tool of WRITE_TOOLS) {
      expect(() => assertReadOnly(tool)).toThrow(new RegExp(`"${tool}" writes to the cluster`));
      try {
        assertReadOnly(tool);
      } catch (error) {
        expect((error as McpError).kind).toBe('read_only_violation');
      }
    }
  });

  it('refuses a tool it has never heard of rather than trying it', () => {
    expect(() => assertReadOnly('drop_everything')).toThrow(/not one of the read tools/);
  });

  it('has no overlap between the read list and the write list', () => {
    const reads = new Set<string>(READ_TOOLS);
    expect(WRITE_TOOLS.filter((tool) => reads.has(tool))).toEqual([]);
  });
});

describe('buildBoundedQuery', () => {
  it('attaches the bound the caller asked for', () => {
    expect(buildBoundedQuery('SELECT 1 AS one', 5)).toBe('SELECT 1 AS one LIMIT 5');
  });

  it('trims the END of the query, so the clause does not land after a newline', () => {
    // Leading whitespace is harmless and trailing whitespace is what would separate the statement
    // from its own bound. Trimming the wrong end reads identically until a template gains a newline.
    expect(buildBoundedQuery('SELECT 1 AS one\n  ', 5)).toBe('SELECT 1 AS one LIMIT 5');
    expect(buildBoundedQuery('  SELECT 1 AS one', 5)).toBe('  SELECT 1 AS one LIMIT 5');
  });

  it('recognises a bound written with unusual spacing', () => {
    expect(() => buildBoundedQuery('SELECT n FROM t FETCH  FIRST 10 ROWS ONLY', 5)).toThrow(
      /must not write its own row bound/,
    );
    expect(() => buildBoundedQuery('SELECT n FROM t\nFETCH\n\tFIRST 10 ROWS ONLY', 5)).toThrow(
      /must not write its own row bound/,
    );
  });

  it('refuses a query that writes its own bound, in any of the forms the server honours', () => {
    // Measured: a top level LIMIT is honoured in lower case and across newlines, FETCH FIRST is
    // honoured too, and a LIMIT inside a subquery is NOT, so the outer query gets 25 rows silently.
    for (const sql of [
      'SELECT n FROM t LIMIT 10',
      'select n from t limit 10',
      'SELECT n FROM t\n  LIMIT\n  10',
      'SELECT n FROM t FETCH FIRST 10 ROWS ONLY',
      'SELECT n FROM (SELECT n FROM t LIMIT 10) AS sub',
    ]) {
      expect(() => buildBoundedQuery(sql, 5)).toThrow(/must not write its own row bound/);
    }
  });

  it('does not mistake a value for a clause', () => {
    // A workspace called "rate-limit" is an entirely reasonable thing for an incident tool to have,
    // and the id is interpolated into the query text. Matching the keyword inside a string literal
    // would make that workspace's memories permanently unverifiable.
    const sql = "SELECT id FROM t WHERE workspace_id = 'rate-limit'";
    expect(buildBoundedQuery(sql, 2)).toBe(`${sql} LIMIT 2`);
    expect(buildBoundedQuery("SELECT id FROM t WHERE k = 'fetch first place'", 2)).toContain('LIMIT 2');
    // And the refusal still fires when the keyword is really a clause.
    expect(() => buildBoundedQuery("SELECT id FROM t WHERE k = 'rate-limit' LIMIT 3", 2)).toThrow(
      /must not write its own row bound/,
    );
  });

  it('refuses a semicolon, because this server takes exactly one statement', () => {
    expect(() => buildBoundedQuery('SELECT 1;', 5)).toThrow(/semicolon/);
    expect(() => buildBoundedQuery('SELECT 1; SELECT 2', 5)).toThrow(/semicolon/);
  });

  it('refuses a bound that is not a usable whole number', () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_STATED_LIMIT + 1]) {
      expect(() => buildBoundedQuery('SELECT 1', limit)).toThrow(/row bound/);
    }
    expect(() => buildBoundedQuery('SELECT 1', MAX_STATED_LIMIT)).not.toThrow();
  });
});

describe('stripStringLiterals', () => {
  it('blanks quoted values and leaves the statement structure alone', () => {
    expect(stripStringLiterals("SELECT a FROM t WHERE b = 'x' LIMIT 1")).toBe(
      "SELECT a FROM t WHERE b = '' LIMIT 1",
    );
  });

  it('handles the doubled quote escape without running past the literal', () => {
    // If the escape were mishandled, everything after it would be swallowed as "inside a string",
    // and a real LIMIT clause after it would become invisible to the guard.
    expect(stripStringLiterals("SELECT 'it''s' AS a, b LIMIT 5")).toBe("SELECT '' AS a, b LIMIT 5");
  });
});

describe('extractRpcPayload', () => {
  it('reads the SSE framing this endpoint actually uses', () => {
    const raw = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    expect(extractRpcPayload(raw, 'text/event-stream')).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('joins consecutive data lines rather than taking the last one', () => {
    // One SSE event may split its payload across data lines, and the specification says they are
    // joined with newlines. Taking the last line parses a fragment or throws, and both readings
    // look identical on this server's single line responses.
    const raw = 'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"ok":true}}\n\n';
    expect(extractRpcPayload(raw, 'text/event-stream')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    });
  });

  it('reads a plain JSON body when the transport sends one', () => {
    expect(extractRpcPayload('{"jsonrpc":"2.0","id":1}', 'application/json')).toEqual({
      jsonrpc: '2.0',
      id: 1,
    });
  });

  it('calls an empty body unknown rather than empty', () => {
    expect(() => extractRpcPayload('', 'text/event-stream')).toThrow(/not an empty result/);
    expect(() => extractRpcPayload('   \n', 'application/json')).toThrow(McpError);
  });

  it('calls an unparseable body unknown rather than empty', () => {
    expect(() => extractRpcPayload('<html>gateway timeout</html>', 'text/html')).toThrow(
      /no knowledge at all/,
    );
  });

  it('finds the response even when a notification arrives on the stream first', () => {
    // This protocol revision permits the server to send other messages before the answer. Gathering
    // `data:` lines across the WHOLE body splices two JSON documents into one unparseable string,
    // so a server doing nothing wrong would break the channel, and break it as an unrecognised
    // envelope, which reads as a fault in the database rather than in this client.
    const raw =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(extractRpcPayload(raw, 'text/event-stream')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    });
  });

  it('still joins data lines WITHIN one event after learning to split between them', () => {
    // The pair that pins the split: the same two payloads, once across events (joined = broken) and
    // once inside one event (joined = correct). A fix that split on every newline would pass the
    // test above and fail this one.
    const raw = 'event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"ok":true}}\n\n';
    expect(extractRpcPayload(raw, 'text/event-stream')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    });
  });

  it('refuses a stream that carried messages but no answer', () => {
    const raw = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n';
    expect(() => extractRpcPayload(raw, 'text/event-stream')).toThrow(/did not receive an answer/);
    expect(() => extractRpcPayload(raw, 'text/event-stream')).toThrow(McpError);
  });

  it('names an unparseable SSE payload rather than letting a SyntaxError escape', () => {
    // The per-event rewrite gave the SSE path its own try/catch, and nothing reached it: the old
    // shared one was covered only by the `text/html` case, so both `parseFailure = cause` and a
    // `throw cause` that leaks a raw SyntaxError survived as mutants. A raw SyntaxError out of here
    // is classified `transport_unreachable`, which blames the network for a malformed body.
    const raw = 'event: message\ndata: {"jsonrpc":"2.0", this is not json\n\n';
    expect(() => extractRpcPayload(raw, 'text/event-stream')).toThrow(/no knowledge at all/);
    expect(() => extractRpcPayload(raw, 'text/event-stream')).toThrow(McpError);
  });

  it('refuses a response that answers a DIFFERENT request', () => {
    // Splitting the stream per event bought the ability to skip a notification, and paid for it by
    // returning the FIRST message shaped like a response, whoever it belonged to. That is worse
    // than the bug it replaced: the old whole-body join spliced two documents and failed CLOSED,
    // while this hands another query's rows to the verifier, which compares them against this
    // memory and reports DIVERGES with failure null. Shape is not identity.
    const foreign =
      'event: message\ndata: {"jsonrpc":"2.0","id":999,"result":{"content":[]}}\n\n';
    expect(() => extractRpcPayload(foreign, 'text/event-stream', 2)).toThrow(/did not receive an answer/);
    expect(() => extractRpcPayload(foreign, 'text/event-stream', 2)).toThrow(McpError);
    // Ours is still found when it is on the stream, whatever else is sharing it.
    const mixed =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":999,"result":{"content":[]}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    expect(extractRpcPayload(mixed, 'text/event-stream', 2)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { ok: true },
    });
    // A plain JSON body is held to the same rule.
    expect(() => extractRpcPayload('{"jsonrpc":"2.0","id":999,"result":{}}', 'application/json', 2)).toThrow(
      /did not receive an answer/,
    );
  });

  it('keeps an error the server could not attribute, because id null still answers us', () => {
    // JSON-RPC requires `id: null` on an error the server cannot tie back to a request. Holding
    // that to the same rule as a result LOOKS consistent and throws away the only thing the
    // failure path exists to produce: measured before this allowance, an oversized-result error
    // arrived as `unrecognised_envelope` with no serverMessage and no cause, instead of
    // `result_too_large` with the server's own words kept for the log. Still UNKNOWN either way,
    // so no data claim, but the operator loses the reason.
    const raw = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 0, message: LIVE_MESSAGES.tooLarge } })}\n\n`;
    const payload = extractRpcPayload(raw, 'text/event-stream', 2);
    let thrown: unknown;
    try {
      readRows(payload);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).kind).toBe('result_too_large');
    expect((thrown as McpError).serverMessage).toContain('max result size exceeded');

    // A RESULT gets no such latitude: unattributable ROWS are the whole hazard.
    const rowsWithNullId = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: null, result: { content: [] } })}\n\n`;
    expect(() => extractRpcPayload(rowsWithNullId, 'text/event-stream', 2)).toThrow(
      /did not receive an answer/,
    );
  });

  it('numbers its requests, so the id check is checking something', async () => {
    // The invariant the whole id check rests on, and nothing pinned it: replacing
    // `id: (requestId += 1)` with `id: requestId` left every test green, which would make the
    // check compare a constant against a constant and pass forever.
    const recorded: Recorded[] = [];
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: fakeFetch([rowsPayload([]), rowsPayload([])], recorded),
    });
    await client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 });
    await client.select({ database: 'defaultdb', sql: 'SELECT 2', limit: 2 });

    const ids = recorded.filter((entry) => entry.body.id !== undefined).map((entry) => entry.body.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the id check all the way through the client, not just the parser', async () => {
    // The wiring, not the function. `extractRpcPayload` gaining an `expectedId` parameter proves
    // nothing if `exchange` never passes one, and that call site is exactly the kind of gap this
    // repository has shipped before.
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: (_url, init) => {
        const body = JSON.parse(init.body) as Recorded['body'];
        if (body.method === 'initialize') {
          return Promise.resolve(sse(echoId({ jsonrpc: '2.0', result: { protocolVersion: '2025-06-18' } }, body.id)));
        }
        if (body.method === 'notifications/initialized') return Promise.resolve(accepted());
        // Answers a request nobody made.
        return Promise.resolve(sse({ ...(rowsPayload([{ id: 'SOMEONE-ELSES-ROW' }]) as object), id: 999 }));
      },
    });

    await expect(client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 })).rejects.toThrow(
      /did not receive an answer/,
    );
  });
});

describe('classifyServerMessage', () => {
  it('names each failure the live server actually produces', () => {
    expect(classifyServerMessage(LIVE_MESSAGES.bothClusterIds).kind).toBe('cluster_scope_conflict');
    expect(classifyServerMessage(LIVE_MESSAGES.noClusterId).kind).toBe('cluster_scope_missing');
    expect(classifyServerMessage(LIVE_MESSAGES.notSelect).kind).toBe('statement_not_select');
    expect(classifyServerMessage(LIVE_MESSAGES.notSingle).kind).toBe('statement_not_single');
    expect(classifyServerMessage(LIVE_MESSAGES.restricted).kind).toBe('restricted_schema');
    expect(classifyServerMessage(LIVE_MESSAGES.tooLarge).kind).toBe('result_too_large');
    expect(classifyServerMessage(LIVE_MESSAGES.noRelation).kind).toBe('unknown_relation');
  });

  it('names a write smuggled into a CTE as a refused non-SELECT', () => {
    // The read-only guard in this client is a tool-name allowlist, but `select_query` carries
    // arbitrary SQL, so the allowlist alone does not establish that the channel cannot write. The
    // server's own CTE check is the control that does, and this pins the classification of it.
    const classified = classifyServerMessage(LIVE_MESSAGES.notSelectInCte);
    expect(classified.kind).toBe('statement_not_select');
    expect(classified.sentence).toMatch(/read only by design/);
  });

  it('never repeats the server text back, for any message', () => {
    // An allowlist rather than a filter: the sentence is written here, so there is no path by which
    // an account identifier in the server's prose reaches the sentence an operator reads.
    const leaky =
      'AccessDenied for arn:aws:sts::123456789012:assumed-role/ops/alice@example.com on cluster ' +
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const classified = classifyServerMessage(leaky);
    expect(classified.kind).toBe('server_error');
    expect(classified.sentence).not.toContain('123456789012');
    expect(classified.sentence).not.toContain('alice@example.com');
    expect(classified.sentence).not.toContain('3f2504e0');
  });

  it('says a size failure is not a disagreement, because that is the dangerous reading', () => {
    expect(classifyServerMessage(LIVE_MESSAGES.tooLarge).sentence).toMatch(/never a disagreement/);
  });
});

describe('maskIdentifiers', () => {
  it('masks the key, UUIDs and addresses in text bound for a log', () => {
    const masked = maskIdentifiers(
      'key EXAMPLE-NOT-A-REAL-KEY-abc cluster 3f2504e0-4f89-11d3-9a0c-0305e82c3301 owner ana@example.com',
      'EXAMPLE-NOT-A-REAL-KEY-abc',
    );
    expect(masked).toContain('[key]');
    expect(masked).toContain('[uuid]');
    expect(masked).toContain('[email]');
    expect(masked).not.toContain('3f2504e0');
  });

  it('leaves a short or absent key alone rather than corrupting the text', () => {
    expect(maskIdentifiers('nothing to see', undefined)).toBe('nothing to see');
    expect(maskIdentifiers('a is a letter', 'a')).toBe('a is a letter');
  });

  it('draws the short-key line at exactly eight characters', () => {
    // A boundary on a masking rule, so it gets a test on the boundary rather than near it. Seven
    // characters is short enough to appear inside unrelated words; eight is the line this draws.
    expect(maskIdentifiers('secret7 appears here', 'secret7')).toBe('secret7 appears here');
    expect(maskIdentifiers('secret88 appears here', 'secret88')).toBe('[key] appears here');
  });

  it('does not mask text that merely resembles an identifier', () => {
    // The half that was missing. Every assertion here was previously positive, so a mask pattern
    // could be weakened to something far broader and still pass: an over-broad mask silently
    // corrupts the operator's own words, which is a different failure from leaking and no better.
    const kept = maskIdentifiers(
      'the deadbeef build at 12345678-90 finished, see docs at example.com/report',
      'EXAMPLE-NOT-A-REAL-KEY-key',
    );
    expect(kept).toContain('deadbeef');
    expect(kept).toContain('12345678-90');
    expect(kept).toContain('example.com/report');
    expect(kept).not.toContain('[uuid]');
    expect(kept).not.toContain('[email]');
    expect(kept).not.toContain('[token]');
  });

  it('masks a token only once it is long enough to be one', () => {
    const thirtyOne = 'a'.repeat(31);
    const thirtyTwo = 'a'.repeat(32);
    expect(maskIdentifiers(`id ${thirtyOne} end`)).toContain(thirtyOne);
    expect(maskIdentifiers(`id ${thirtyTwo} end`)).toBe('id [token] end');
  });
});

describe('readRows', () => {
  it('reads the row set out of the envelope this server sends', () => {
    expect(readRows(rowsPayload([{ one: 1 }]))).toEqual([{ one: 1 }]);
  });

  it('reads a genuinely empty row set as empty', () => {
    // The distinction the whole file exists for: this IS zero rows, and the cases below are not.
    expect(readRows(rowsPayload([]))).toEqual([]);
  });

  it('throws on every live error message instead of reporting zero rows', () => {
    for (const message of Object.values(LIVE_MESSAGES)) {
      expect(() => readRows(errorPayload(message))).toThrow(McpError);
    }
  });

  it('carries the classified kind through from a JSON-RPC error', () => {
    try {
      readRows(errorPayload(LIVE_MESSAGES.tooLarge));
      expect.unreachable('a server error must not read as rows');
    } catch (error) {
      expect((error as McpError).kind).toBe('result_too_large');
    }
  });

  it('masks identifiers in the copy it keeps for a log, and omits them from the sentence', () => {
    const key = 'EXAMPLE-NOT-A-REAL-KEY-for-the-masking-check';
    try {
      readRows(
        errorPayload(`denied for 3f2504e0-4f89-11d3-9a0c-0305e82c3301 using ${key}`),
        key,
      );
      expect.unreachable('an error must throw');
    } catch (error) {
      const mcp = error as McpError;
      expect(mcp.message).not.toContain(key);
      expect(mcp.message).not.toContain('3f2504e0');
      expect(mcp.serverMessage).toContain('[key]');
      expect(mcp.serverMessage).toContain('[uuid]');
    }
  });

  it('treats a tool level error result as an error', () => {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      result: { isError: true, content: [{ type: 'text', text: LIVE_MESSAGES.notSelect }] },
    };
    try {
      readRows(payload);
      expect.unreachable('isError must not read as rows');
    } catch (error) {
      expect((error as McpError).kind).toBe('statement_not_select');
    }
  });

  it('treats a bare message object as an error rather than as an empty result', () => {
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ code: 0, message: LIVE_MESSAGES.notSingle }) }] },
    };
    expect(() => readRows(payload)).toThrow(/one statement/);
  });

  it('refuses every shape it does not recognise, and says which shape it was', () => {
    // Asserting the SENTENCE, not just the type. Every one of these throws an McpError whichever
    // guard catches it, so a type-only assertion cannot tell the guards apart and several of them
    // can be deleted with the suite still green. Mutation testing is what made that visible.
    const cases: ReadonlyArray<[unknown, RegExp]> = [
      [null, /expected a JSON-RPC object and received null/],
      ['a string', /expected a JSON-RPC object and received string/],
      [{ jsonrpc: '2.0', id: 1 }, /neither a result nor an error/],
      [{ jsonrpc: '2.0', id: 1, result: {} }, /no text content to read/],
      [{ jsonrpc: '2.0', id: 1, result: { content: [] } }, /no text content to read/],
      [
        { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'not json' }] } },
        /result text that is not JSON/,
      ],
      [
        { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"unexpected":true}' }] } },
        /no row set in it/,
      ],
    ];
    for (const [payload, expected] of cases) {
      expect(() => readRows(payload)).toThrow(expected);
      expect(() => readRows(payload)).toThrow(McpError);
    }
  });

  it('treats a null error member as no error, rather than as an unreadable one', () => {
    // JSON-RPC allows `error: null` alongside a real result, and reading that as a failure would
    // turn every successful call from such a server into an outage.
    expect(readRows({ jsonrpc: '2.0', id: 1, error: null, result: { content: [{ type: 'text', text: '{"rows":[]}' }] } })).toEqual([]);
  });

  it('refuses a row that is not a row object, and says which position it was', () => {
    // THE defect this whole module argues against, reached by a route no error message takes.
    // `rows: [null]` is an array of length one, so downstream `rows[0]` is falsy, every "is there a
    // row" branch is skipped, and the verifier reports DIVERGES with failure null: "the application
    // holds this memory and an independent read of the cluster does not find it". A claim about the
    // DATABASE, manufactured from the SHAPE of a response, and indistinguishable from a real one.
    for (const bad of [null, 0, false, '', 'some text', 42, []]) {
      expect(() => readRows(rowsPayload([bad]))).toThrow(/entry at position 0 is not a row object/);
      expect(() => readRows(rowsPayload([bad]))).toThrow(McpError);
    }
    // The position is named, so a long result set does not have to be searched by hand.
    expect(() => readRows(rowsPayload([{ id: 1 }, null]))).toThrow(/position 1/);
    // And a genuine row set is still read.
    expect(readRows(rowsPayload([{ id: 1 }, { id: 2 }]))).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('refuses result text that parses to something other than an object', () => {
    // `JSON.parse` returns null, a number or a string just as happily as an object, and reading
    // `.rows` off one of those threw a bare TypeError with no kind on it, escaping every caller
    // that branches on McpError.
    for (const text of ['null', '42', '"a string"', 'true']) {
      const payload = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } };
      expect(() => readRows(payload)).toThrow(/not a JSON object/);
      expect(() => readRows(payload)).toThrow(McpError);
    }
  });

  it('never returns an array for anything that is not a row set', () => {
    // The mutation this kills: `return envelope.rows ?? []`. Every case above would then pass
    // silently as "the database has no such row", which in this product is a reported divergence.
    for (const payload of [errorPayload(LIVE_MESSAGES.tooLarge), { result: {} }, {}]) {
      let returned: unknown = 'did not throw';
      try {
        returned = readRows(payload);
      } catch {
        returned = 'threw';
      }
      expect(returned).toBe('threw');
    }
  });
});

describe('createMcpClient, on the wire', () => {
  it('handshakes, announces itself, then calls the tool, echoing the session', async () => {
    const recorded: Recorded[] = [];
    const client = createMcpClient({ config: CONFIG, fetchImpl: fakeFetch([rowsPayload([{ one: 1 }])], recorded) });
    await client.select({ database: 'defaultdb', sql: 'SELECT 1 AS one', limit: 2 });

    expect(recorded.map((entry) => entry.body.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(recorded[0]?.headers['authorization']).toBe(`Bearer ${CONFIG.apiKey}`);
    // The handshake cannot carry a session id because it is the thing that issues one.
    expect(recorded[0]?.headers['mcp-session-id']).toBeUndefined();
    expect(recorded[2]?.headers['mcp-session-id']).toBe('session-1');
    expect(recorded[2]?.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('sends the cluster id exactly once, on whichever side the mode chose', async () => {
    for (const mode of ['argument', 'header'] as const) {
      const recorded: Recorded[] = [];
      const client = createMcpClient({
        config: CONFIG,
        clusterScope: mode,
        fetchImpl: fakeFetch([rowsPayload([])], recorded),
      });
      await client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 });
      const call = toolCalls(recorded)[0];
      const inArgs = call?.body.params?.arguments?.['cluster_id'] === undefined ? 0 : 1;
      const inHeader = call?.headers['mcp-cluster-id'] === undefined ? 0 : 1;
      expect(inArgs + inHeader).toBe(1);
    }
  });

  it('puts the bound on the query that actually leaves the process', async () => {
    // The guard is worthless if the bound is added somewhere the request does not read. Measured
    // consequence of getting this wrong: the server silently returns 25 rows.
    const recorded: Recorded[] = [];
    const client = createMcpClient({ config: CONFIG, fetchImpl: fakeFetch([rowsPayload([])], recorded) });
    await client.select({ database: 'defaultdb', sql: 'SELECT id FROM t WHERE x = 1', limit: 7 });
    expect(toolCalls(recorded)[0]?.body.params?.arguments?.['query']).toBe(
      'SELECT id FROM t WHERE x = 1 LIMIT 7',
    );
    expect(toolCalls(recorded)[0]?.body.params?.name).toBe('select_query');
  });

  it('reports a full result as possibly truncated, and a short one as not', async () => {
    const recorded: Recorded[] = [];
    const full = createMcpClient({
      config: CONFIG,
      fetchImpl: fakeFetch([rowsPayload([{ n: 1 }, { n: 2 }])], recorded),
    });
    const atLimit = await full.select({ database: 'defaultdb', sql: 'SELECT n FROM t', limit: 2 });
    expect(atLimit.possiblyTruncated).toBe(true);

    const short = createMcpClient({
      config: CONFIG,
      fetchImpl: fakeFetch([rowsPayload([{ n: 1 }])], []),
    });
    const underLimit = await short.select({ database: 'defaultdb', sql: 'SELECT n FROM t', limit: 2 });
    expect(underLimit.possiblyTruncated).toBe(false);
  });

  it('surfaces a server error from callReadTool rather than returning it as a value', async () => {
    // Found live, not here. This returned the raw envelope, so a caller who did not think to parse
    // it received an error object shaped exactly like a successful response. The live check that
    // asks the server to refuse two cluster ids reported no error at all, because the refusal was
    // sitting unread inside the returned value.
    const recorded: Recorded[] = [];
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: fakeFetch([errorPayload(LIVE_MESSAGES.bothClusterIds)], recorded),
    });
    await expect(client.callReadTool('get_table_schema', { table: 'memory' })).rejects.toThrow(
      McpError,
    );
    try {
      await client.callReadTool('get_table_schema', { table: 'memory' });
      expect.unreachable('a refusal must not come back as a value');
    } catch (error) {
      expect((error as McpError).kind).toBe('cluster_scope_conflict');
    }
  });

  it('refuses a write tool without reaching the network', async () => {
    // The wiring, not the helper. A guard that the client does not consult is decoration, and this
    // credential holds Cluster Admin.
    const recorded: Recorded[] = [];
    const client = createMcpClient({ config: CONFIG, fetchImpl: fakeFetch([rowsPayload([])], recorded) });
    await expect(client.callReadTool('insert_rows', { rows: [] })).rejects.toThrow(
      /writes to the cluster/,
    );
    expect(recorded).toEqual([]);
  });

  it('measures its own elapsed time from the clock it was given', async () => {
    let clock = 1_000;
    const recorded: Recorded[] = [];
    const client = createMcpClient({
      config: CONFIG,
      now: () => clock,
      fetchImpl: fakeFetch([rowsPayload([{ one: 1 }])], recorded, {
        onCall: () => {
          clock += 20;
        },
      }),
    });
    const result = await client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 });
    expect(result.elapsedMs).toBe(20);
  });

  it('gives up on time when the request never settles', async () => {
    const client = createMcpClient({
      config: { ...CONFIG, timeoutMs: 25 },
      fetchImpl: () => new Promise(() => undefined),
    });
    const started = Date.now();
    await expect(client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 })).rejects.toThrow(
      /did not answer within 25 ms/,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives up on time when the HEADERS arrive but the body never does', async () => {
    // The subtle half. `fetch` settling means the status line arrived; on a streaming transport
    // that is a long way from having the answer, so the body read is raced too. Without that, the
    // stated budget is a budget on the wrong thing.
    const client = createMcpClient({
      config: { ...CONFIG, timeoutMs: 25 },
      fetchImpl: () =>
        Promise.resolve({
          status: 200,
          headers: { get: (name: string) => (name === 'content-type' ? 'text/event-stream' : null) },
          text: () => new Promise<string>(() => undefined),
        }),
    });
    await expect(client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 })).rejects.toThrow(
      /did not answer within 25 ms/,
    );
  });

  it('handshakes once even against a server that issues no session at all', async () => {
    // `tools/list` was measured working with no session header, so a server need not issue one.
    // Keying "have we handshaken" off the session id would make every call re-handshake, which is
    // invisible in a passing test and doubles every round trip in production.
    const recorded: Recorded[] = [];
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: (_url, init) => {
        const body = JSON.parse(init.body) as Recorded['body'];
        recorded.push({ headers: init.headers, body });
        if (body.method === 'initialize') {
          return Promise.resolve(
            // Same envelope, but no session id header at all.
            {
              status: 200,
              headers: {
                get: (name: string) => (name === 'content-type' ? 'text/event-stream' : null),
              },
              text: () =>
                Promise.resolve(
                  `event: message\ndata: ${JSON.stringify(echoId({ jsonrpc: '2.0', result: { protocolVersion: '2025-06-18' } }, body.id))}\n\n`,
                ),
            },
          );
        }
        return Promise.resolve(sse(echoId(rowsPayload([{ one: 1 }]), body.id), 'unused'));
      },
    });
    await client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 });
    await client.select({ database: 'defaultdb', sql: 'SELECT 2', limit: 2 });
    expect(recorded.filter((entry) => entry.body.method === 'initialize')).toHaveLength(1);
    // No session was issued, so nothing announces itself and nothing echoes a session header.
    expect(recorded.filter((entry) => entry.body.method === 'notifications/initialized')).toHaveLength(0);
    expect(toolCalls(recorded)[0]?.headers['mcp-session-id']).toBeUndefined();
  });

  it('completes a handshake against a notification answered 202 with no body', async () => {
    // The live endpoint answers `notifications/initialized` with 202 Accepted and zero bytes. The
    // first version of this client parsed every response as JSON-RPC and therefore threw here, so
    // it could not have talked to the real server at all.
    const recorded: Recorded[] = [];
    const client = createMcpClient({ config: CONFIG, fetchImpl: fakeFetch([rowsPayload([{ one: 1 }])], recorded) });
    const result = await client.select({ database: 'defaultdb', sql: 'SELECT 1 AS one', limit: 2 });
    expect(result.rows).toEqual([{ one: 1 }]);
    expect(recorded.map((entry) => entry.body.method)).toContain('notifications/initialized');
  });

  it('still refuses an empty body for a request that asked for an answer', async () => {
    // The complement of the fix above, and the part that must not be relaxed with it. A tolerance
    // for empty bodies that leaked into ordinary calls would turn a truncated response into a
    // silent success, which is the failure this whole module is built to prevent.
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: (_url, init) => {
        const body = JSON.parse(init.body) as Recorded['body'];
        if (body.method === 'initialize') {
          return Promise.resolve(sse(echoId({ jsonrpc: '2.0', result: { protocolVersion: '2025-06-18' } }, body.id)));
        }
        if (body.method === 'notifications/initialized') return Promise.resolve(accepted());
        return Promise.resolve({
          status: 200,
          headers: { get: (name: string) => (name === 'content-type' ? 'text/event-stream' : null) },
          text: () => Promise.resolve(''),
        });
      },
    });
    await expect(client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 })).rejects.toThrow(
      /not an empty result/,
    );
  });

  it('names an auth rejection as an auth rejection and reads no body', async () => {
    let bodyRead = false;
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: () =>
        Promise.resolve({
          status: 403,
          headers: { get: () => null },
          text: () => {
            bodyRead = true;
            return Promise.resolve('{"error":"account 123456789 is not permitted"}');
          },
        }),
    });
    await expect(client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 })).rejects.toThrow(
      /rejected the credential/,
    );
    expect(bodyRead).toBe(false);
  });

  it('names a 401 as an auth rejection too, not only a 403', async () => {
    // Both codes, because the guard names both and a test for one of them leaves the other free to
    // be deleted. Mutation testing surfaced exactly that: removing the 401 arm changed nothing.
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: () =>
        Promise.resolve({
          status: 401,
          headers: { get: () => null },
          text: () => Promise.resolve(''),
        }),
    });
    await expect(client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 })).rejects.toThrow(
      /rejected the credential/,
    );
  });

  it('calls a network level failure unreachable, not a timeout', async () => {
    // The distinction matters to whoever reads /status: "we could not connect" and "it did not
    // answer in time" send an operator to different places. Nothing tested this path at all, which
    // is why flipping the timedOut flag's initial value changed no test result.
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed: ENOTFOUND')),
    });
    try {
      await client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 });
      expect.unreachable('a dead network must not read as success');
    } catch (error) {
      expect((error as McpError).kind).toBe('transport_unreachable');
      expect((error as McpError).message).toMatch(/not evidence about the data/);
    }
  });

  it('does not repeat an error body from an unexpected status', async () => {
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: () =>
        Promise.resolve({
          status: 500,
          headers: { get: () => null },
          text: () => Promise.resolve('org 123456789012 exploded'),
        }),
    });
    await expect(
      client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 }),
    ).rejects.toThrow(/HTTP 500/);
    await expect(
      client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 }),
    ).rejects.not.toThrow(/123456789012/);
  });

  it('re-handshakes once when the server has forgotten the session, and only once', async () => {
    const recorded: Recorded[] = [];
    let toolCallCount = 0;
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: (_url, init) => {
        const body = JSON.parse(init.body) as Recorded['body'];
        recorded.push({ headers: init.headers, body });
        if (body.method === 'initialize') {
          return Promise.resolve(sse(echoId({ jsonrpc: '2.0', result: { protocolVersion: '2025-06-18' } }, body.id)));
        }
        if (body.method === 'notifications/initialized') return Promise.resolve(accepted());
        toolCallCount += 1;
        // Always 404: the retry must not become a loop.
        return Promise.resolve({
          status: 404,
          headers: { get: () => null },
          text: () => Promise.resolve(''),
        });
      },
    });
    await expect(client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 })).rejects.toThrow(
      /session expired/,
    );
    expect(toolCallCount).toBe(2);
    expect(recorded.filter((entry) => entry.body.method === 'initialize')).toHaveLength(2);
  });

  it('does not retry a failure that is not a lost session', async () => {
    const recorded: Recorded[] = [];
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: fakeFetch([errorPayload(LIVE_MESSAGES.tooLarge)], recorded),
    });
    await expect(
      client.select({ database: 'defaultdb', sql: 'SELECT n FROM t', limit: 2 }),
    ).rejects.toThrow(/too large/);
    expect(toolCalls(recorded)).toHaveLength(1);
  });

  it('re-handshakes a lost session and returns the answer the SECOND call gives', async () => {
    // The successful half of the retry. Only the always-404 case was covered, so every statement
    // after the re-handshake was unreachable in test: the feature was claimed, never demonstrated.
    const recorded: Recorded[] = [];
    let toolCallCount = 0;
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: (_url, init) => {
        const body = JSON.parse(init.body) as Recorded['body'];
        recorded.push({ headers: init.headers, body });
        if (body.method === 'initialize') {
          return Promise.resolve(sse(echoId({ jsonrpc: '2.0', result: { protocolVersion: '2025-06-18' } }, body.id)));
        }
        if (body.method === 'notifications/initialized') return Promise.resolve(accepted());
        toolCallCount += 1;
        if (toolCallCount === 1) {
          return Promise.resolve({
            status: 404,
            headers: { get: (): string | null => null },
            text: (): Promise<string> => Promise.resolve(''),
          });
        }
        return Promise.resolve(sse(echoId(rowsPayload([{ one: 1 }]), body.id)));
      },
    });

    const result = await client.select({ database: 'defaultdb', sql: 'SELECT 1 AS one', limit: 2 });
    expect(result.rows).toEqual([{ one: 1 }]);
    expect(toolCallCount).toBe(2);
    expect(recorded.filter((entry) => entry.body.method === 'initialize')).toHaveLength(2);
  });

  it('surfaces a server error that arrives on the RETRY, not just on the first call', async () => {
    // Pins the second `assertNoServerError`. Without it `callReadTool` hands the caller a refusal
    // shaped exactly like a success, which is the defect this file records as having shipped once
    // and been caught only by a live call. `callReadTool` rather than `select` on purpose: `select`
    // runs `readRows`, which would throw anyway and let the deletion pass unnoticed.
    let toolCallCount = 0;
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: (_url, init) => {
        const body = JSON.parse(init.body) as Recorded['body'];
        if (body.method === 'initialize') {
          return Promise.resolve(sse(echoId({ jsonrpc: '2.0', result: { protocolVersion: '2025-06-18' } }, body.id)));
        }
        if (body.method === 'notifications/initialized') return Promise.resolve(accepted());
        toolCallCount += 1;
        if (toolCallCount === 1) {
          return Promise.resolve({
            status: 404,
            headers: { get: (): string | null => null },
            text: (): Promise<string> => Promise.resolve(''),
          });
        }
        return Promise.resolve(sse(echoId(errorPayload(LIVE_MESSAGES.tooLarge), body.id)));
      },
    });

    await expect(client.callReadTool('select_query', { database: 'defaultdb', query: 'SELECT 1' })).rejects.toThrow(
      /too large for this channel to carry/,
    );
    expect(toolCallCount).toBe(2);
  });

  it('calls an abort caused by its own deadline a timeout, with the transport error kept as cause', async () => {
    // The real production abort path, which is NOT the same branch as the deadline promise winning
    // the race: `controller.abort()` runs before the deadline rejects, so the fetch rejects first
    // with a plain Error and only the `timedOut` flag distinguishes it from a dead network. The
    // `cause` is what proves which of the two arms ran.
    const client = createMcpClient({
      config: { ...CONFIG, timeoutMs: 30 },
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('The operation was aborted'));
          });
        }),
    });

    const error: unknown = await client.callReadTool('list_databases', {}).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).kind).toBe('timeout');
    expect((error as McpError).message).toMatch(/did not answer within 30 ms/);
    expect((error as McpError).cause).toBeInstanceOf(Error);
  });

  it('gives up before opening a connection when the deadline has already passed', async () => {
    // The `remaining <= 0` guard. Asserting the message alone cannot tell this apart from a normal
    // timeout, so the assertion that carries the test is that the network was never touched.
    let fetchCount = 0;
    let nowValue = 0;
    const client = createMcpClient({
      config: { ...CONFIG, timeoutMs: 2_000 },
      now: () => {
        const current = nowValue;
        nowValue = 10_000;
        return current;
      },
      fetchImpl: () => {
        fetchCount += 1;
        return Promise.reject(new Error('the deadline guard should have run before this'));
      },
    });

    await expect(client.callReadTool('list_databases', {})).rejects.toThrow(/did not answer within 2000 ms/);
    expect(fetchCount).toBe(0);
  });

  it('reuses the session across calls rather than handshaking every time', async () => {
    const recorded: Recorded[] = [];
    const client = createMcpClient({
      config: CONFIG,
      fetchImpl: fakeFetch([rowsPayload([]), rowsPayload([])], recorded),
    });
    await client.select({ database: 'defaultdb', sql: 'SELECT 1', limit: 2 });
    await client.select({ database: 'defaultdb', sql: 'SELECT 2', limit: 2 });
    expect(recorded.filter((entry) => entry.body.method === 'initialize')).toHaveLength(1);
    expect(toolCalls(recorded)).toHaveLength(2);

    client.reset();
    await client.select({ database: 'defaultdb', sql: 'SELECT 3', limit: 2 });
    expect(recorded.filter((entry) => entry.body.method === 'initialize')).toHaveLength(2);
  });
});
