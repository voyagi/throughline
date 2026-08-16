import { describe, expect, it } from 'vitest';
import {
  createLocalEmbedder,
  createRepository,
  DatabaseError,
  observed,
  probeCapabilities,
  unknown,
  type Capabilities,
  type Embedder,
  type MemoryKind,
  type MemoryPage,
} from '@throughline/memory';
import type { MemoryListResponse } from '@throughline/contract';
import { createFakeDatabase, mentions } from '../../../packages/memory/test/fake-database.ts';
import { ChatResponseError, type ChatModel, type ChatReply } from '../src/agent/loop.ts';
import { createScriptedChatModel } from '../src/agent/local-model.ts';
import { McpError, type McpClient } from '../src/mcp-client.ts';
import type { DemoBudget } from '../src/http/demo-budget.ts';
import { loadDemoLimits } from '../src/http/limits.ts';
import { createApp, SERVER_NAME, UNKNOWN_CLIENT, type ServerDependencies } from '../src/server.ts';
import {
  fakeRepository,
  MEMORY_ID_A,
  MEMORY_ID_B,
  MEMORY_ID_C,
  memoryPage,
  memoryRecord,
} from './agent-fixtures.ts';

const ORIGIN = 'https://throughline.example';
const POISON = 'arn:aws:sts::123456789012:assumed-role/throughline-admin/session';

/**
 * The marker every capability probe reason carries in the `/status` leak controls below.
 *
 * A reason is written from scratch in `capability.ts`, so this is about internal IDENTIFIERS rather
 * than about a driver's words: schema and table names, a column type, an embedder id. A public
 * status page taking no credentials has no reason to name any of them.
 */
const PROBE_REASON_MARKER = 'INTERNAL-throughline.memory-not-for-a-public-body';

/**
 * One case per site where a probe reason could reach a lamp's `detail`, with the lamp each degrades.
 *
 * Four sites, and a fixture that degrades everything at once reaches only two of them, because
 * `describeIndex` and `describeEmbedding` both return at their FIRST unknown. Reaching the later
 * branches requires the earlier observation to have succeeded, which is why these are separate
 * cases rather than one fixture with every field unknown.
 */
const PROBE_LEAK_CASES: readonly {
  readonly label: string;
  readonly lamp: string;
  readonly degraded: Partial<Capabilities>;
}[] = [
  {
    label: 'the query plan could not be read',
    lamp: 'Vector index',
    degraded: { annPlanUsesIndex: unknown(`could not read the query plan for ${PROBE_REASON_MARKER}`) },
  },
  {
    // The shape Cloud Basic actually produces: EXPLAIN answers, and listing indexes is refused
    // because `crdb_internal` and `information_schema` are not readable there.
    label: 'the planner reports no index and listing them was refused',
    lamp: 'Vector index',
    degraded: {
      annPlanUsesIndex: observed(false),
      vectorIndex: unknown(`could not list indexes on ${PROBE_REASON_MARKER}`),
    },
  },
  {
    label: 'the embedding column could not be inspected',
    lamp: 'Embeddings',
    degraded: { vectorColumnDimensions: unknown(`could not inspect the column on ${PROBE_REASON_MARKER}`) },
  },
  {
    label: 'the embedder could not be measured',
    lamp: 'Embeddings',
    degraded: { embedderDimensions: unknown(`could not measure the embedder for ${PROBE_REASON_MARKER}`) },
  },
];

/** A cluster where everything was observed and everything agrees. The healthy baseline. */
const CAPABILITIES: Capabilities = {
  observedAt: new Date('2026-08-05T12:00:00Z'),
  target: 'fake:0/testdb schema=throughline',
  serverVersion: observed('CockroachDB CCL v26.2.1'),
  vectorColumnDimensions: observed(8),
  embedderDimensions: observed(8),
  vectorIndex: observed(true),
  annPlanUsesIndex: observed(true),
  vectorIndexingEnabled: observed(true),
};

/** A model that counts its calls, so "the ceiling is checked BEFORE the model call" is assertable. */
function countingModel(reply: ChatReply = { kind: 'answer', text: 'The checkout pods were restarted.' }): {
  model: ChatModel;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    model: {
      id: 'test-model',
      reply: () => {
        calls += 1;
        return Promise.resolve(reply);
      },
    },
  };
}

function budgetStub(allowed: boolean): DemoBudget {
  return {
    claim: () =>
      Promise.resolve(
        allowed
          ? { allowed: true, used: 3, limit: 500, day: '2026-08-05' }
          : { allowed: false, used: null, limit: 500, day: '2026-08-05' },
      ),
  };
}

const refusingChannel = (): McpClient => {
  throw new McpError('transport_unreachable', 'The MCP configuration is not usable.');
};

function build(overrides: Partial<ServerDependencies> = {}) {
  const lines: string[] = [];
  const deps: ServerDependencies = {
    limits: loadDemoLimits({
      CORS_ALLOWED_ORIGINS: ORIGIN,
      DEMO_RATE_LIMIT_PER_MINUTE: '3',
      DEMO_MAX_AGENT_CALLS_PER_DAY: '500',
    }),
    repository: fakeRepository(),
    model: countingModel().model,
    budget: budgetStub(true),
    database: createFakeDatabase(() => []),
    schema: 'throughline',
    databaseName: 'defaultdb',
    workspaceId: 'demo',
    openVerificationChannel: refusingChannel,
    probeCapabilities: () => Promise.resolve(CAPABILITIES),
    verificationChannelConfigured: false,
    clientAddressOf: () => '203.0.113.7',
    now: () => new Date('2026-08-05T12:00:00Z'),
    log: (line) => lines.push(line),
    ...overrides,
  };
  return { app: createApp(deps), lines, deps };
}

const ask = (app: ReturnType<typeof build>['app'], body: unknown, headers: Record<string, string> = {}) =>
  app.request('/agent/turn', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('the HTTP surface', () => {
  it('names itself on /health, because "something answered on the port" is not "my server is up"', async () => {
    const { app } = build();
    const response = await app.request('/health');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ server: SERVER_NAME, status: 'ok' });
  });

  it('answers /health even when the caller is over its rate limit', async () => {
    const { app } = build();
    for (let i = 0; i < 4; i += 1) await ask(app, { message: 'hello' });
    expect((await app.request('/health')).status).toBe(200);
  });

  it('answers an unknown route rather than falling through', async () => {
    const { app } = build();
    expect((await app.request('/nope')).status).toBe(404);
  });

  describe('CORS', () => {
    it('allows a listed origin and refuses one that is not listed', async () => {
      const { app } = build();
      const allowed = await app.request('/health', { headers: { Origin: ORIGIN } });
      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);

      const refused = await app.request('/health', { headers: { Origin: 'https://attacker.example' } });
      expect(refused.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(refused.headers.get('Vary')).toBe('Origin');
    });

    it('answers a preflight from a fixed list and never from the request headers', async () => {
      const { app } = build();
      const response = await app.request('/agent/turn', {
        method: 'OPTIONS',
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
          // The advisory's input path. Whatever arrives here must not shape the answer.
          'Access-Control-Request-Headers': 'x-one, x-two, x-three',
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('content-type');
      expect(response.headers.get('Access-Control-Allow-Headers')).not.toContain('x-one');
    });

    it('gives a preflight from an unlisted origin nothing to work with', async () => {
      const { app } = build();
      const response = await app.request('/agent/turn', {
        method: 'OPTIONS',
        headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST' },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
    });
  });

  describe('the rate limit', () => {
    it('refuses the fourth call in a minute and says when to come back', async () => {
      const { app } = build();
      for (let i = 0; i < 3; i += 1) expect((await ask(app, { message: 'hi' })).status).toBe(200);

      const refused = await ask(app, { message: 'hi' });
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
      await expect(refused.json()).resolves.toMatchObject({ error: 'rate_limited' });
    });

    it('counts each client separately', async () => {
      let address = 'a';
      const { app } = build({ clientAddressOf: () => address });
      for (let i = 0; i < 3; i += 1) await ask(app, { message: 'hi' });
      address = 'b';
      expect((await ask(app, { message: 'hi' })).status).toBe(200);
    });

    // A limiter that cannot tell clients apart is DEGRADED, not off, and it says so.
    it('shares one bucket and logs it when the client address is unavailable', async () => {
      const { app, lines } = build({ clientAddressOf: () => null });
      await ask(app, { message: 'hi' });
      expect(lines.some((line) => line.includes(UNKNOWN_CLIENT))).toBe(true);
    });
  });

  describe('the daily ceiling', () => {
    // THE ordering assertion. Checking afterwards spends the money and then reports that it should
    // not have, which is an audit trail rather than a ceiling.
    it('refuses without calling the model at all', async () => {
      const counter = countingModel();
      const { app } = build({ budget: budgetStub(false), model: counter.model });

      const response = await ask(app, { message: 'what broke last time?' });
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({ error: 'daily_limit_reached', limit: 500 });
      expect(counter.calls()).toBe(0);
    });

    it('refuses rather than quietly falling back to a recording', async () => {
      const { app } = build({ budget: budgetStub(false) });
      const body = (await (await ask(app, { message: 'hi' })).json()) as { detail: string };
      expect(body.detail).toContain('refuses');
    });

    it('reports what the turn spent when it allows one', async () => {
      const { app } = build();
      const body = (await (await ask(app, { message: 'hi' })).json()) as { budget: unknown };
      expect(body.budget).toEqual({ used: 3, limit: 500, day: '2026-08-05' });
    });
  });

  describe('request bodies', () => {
    it('answers a body that is not JSON with a 400 rather than a 500', async () => {
      const { app } = build();
      const response = await ask(app, '{not json');
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
    });

    // Refused on SIZE, before parsing. The 4,000 character cap in the schema only applies after the
    // whole body has been read and turned into objects, so without this a public demo parses
    // megabytes in order to discover it is going to reject them.
    it('refuses an oversized body before parsing it', async () => {
      const { app } = build();
      const response = await ask(app, { message: 'x'.repeat(200_000) });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: 'body_too_large' });
    });

    // A missing Content-Length is not a promise about size, so the READ itself is bounded. This
    // test used to assert only the 413, which the pre-fix code also produced, after buffering the
    // entire stream: it pinned the defect it existed to catch, because it said nothing about WHEN
    // the refusal happened. So the stream now counts what the server actually pulls. The source
    // hands over a chunk only when asked, and the total handed over is the measurement: a server
    // that buffers first drains all four megabytes on offer, a server that bounds the read stops
    // within a few chunks of the cap.
    it('refuses an oversized body that declares no length, without draining it first', async () => {
      const { app } = build();
      const chunk = new TextEncoder().encode('x'.repeat(1_024));
      const OFFERED_BYTES = 4 * 1024 * 1024;
      let pulled = 0;
      const response = await app.request('/agent/turn', {
        method: 'POST',
        body: new ReadableStream({
          pull(controller) {
            if (pulled >= OFFERED_BYTES) {
              controller.close();
              return;
            }
            pulled += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
        headers: { 'content-type': 'application/json' },
        // Required by undici whenever the body is a stream.
        duplex: 'half',
      } as RequestInit);

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: 'body_too_large' });
      // Slack for the cap itself, the chunk that crossed it, and pipeline readahead. What this
      // must never be is anywhere near the four megabytes the source was ready to provide.
      expect(pulled).toBeLessThan(64 * 1024);
    });

    // The cap names BYTES, and the old comparison counted UTF-16 code units, so a body written in
    // four-byte characters could run roughly 3x over the stated budget before anything refused it.
    // Chunked on purpose: a fetch with a string body declares a byte-accurate Content-Length and is
    // refused by the cheap header check, so the streaming path is the only one where the unit
    // confusion was reachable.
    it('measures the cap in bytes, not UTF-16 units, so a multibyte body cannot stretch it', async () => {
      const { app } = build();
      const message = '\u{1F600}'.repeat(6_000);
      const json = JSON.stringify({ message });
      // The property that makes this discriminating: under the cap in string units, over it in
      // bytes. If either half fails, the fixture has stopped testing the unit confusion.
      expect(json.length).toBeLessThan(16 * 1024);
      const bytes = new TextEncoder().encode(json);
      expect(bytes.byteLength).toBeGreaterThan(16 * 1024);

      const response = await app.request('/agent/turn', {
        method: 'POST',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        headers: { 'content-type': 'application/json' },
        duplex: 'half',
      } as RequestInit);
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: 'body_too_large' });
    });

    it('names the field that failed without quoting what arrived', async () => {
      const { app } = build();
      const response = await ask(app, { message: '' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ fields: ['message'] });
    });

    // The workspace is server side configuration. A caller naming it would be an access control
    // decision in a request body.
    // The assertion is OUTSIDE the stub, and that is the entire point of this version.
    //
    // The first version put `expect(workspaceId).toBe('demo')` inside the `getById` stub. A thrown
    // assertion there is just an exception: `app.onError` catches it, maps it to a 500, and the
    // request resolves, so the test reported PASS while the property was violated. A review proved
    // it by making the caller choose the workspace and watching all 736 stay green. Recording what
    // the stub SAW and asserting on it afterwards is the difference between a test and a control.
    it('ignores a workspace the caller tries to name', async () => {
      const seen: (string | undefined)[] = [];
      const { app } = build({
        repository: fakeRepository({
          getById: (workspaceId) => {
            seen.push(workspaceId);
            return Promise.resolve(null);
          },
        }),
        openVerificationChannel: refusingChannel,
      });

      const response = await app.request('/verify', {
        method: 'POST',
        body: JSON.stringify({ memoryId: MEMORY_ID_A, workspaceId: 'somebody-elses' }),
        headers: { 'content-type': 'application/json' },
      });

      // 502 because the channel refuses, which is this build's configured behaviour. Asserted so a
      // 500 from a swallowed assertion cannot masquerade as a pass again.
      expect(response.status).toBe(502);
      expect(seen).toEqual(['demo']);
    });
  });

  describe('error sanitising', () => {
    // The headline property: a provider error cannot carry an ARN into an operator facing sentence.
    it('never lets a thrown error write the response', async () => {
      const { app } = build({
        repository: fakeRepository({
          recall: () => Promise.reject(new Error(`AccessDeniedException: ${POISON}`)),
        }),
        model: {
          id: 'test-model',
          reply: () => Promise.reject(new Error(`AccessDeniedException: ${POISON}`)),
        },
      });

      const response = await ask(app, { message: 'what broke last time?' });
      expect(response.status).toBe(500);
      const raw = await response.text();
      expect(raw).not.toContain('arn:aws');
      expect(raw).not.toContain('123456789012');
      expect(raw).not.toContain('AccessDeniedException');
    });

    // THE SECOND EXIT, and the first version of this file did not have it. A 200 carries the whole
    // transcript, and a tool that FAILED puts the thrown message into a tool_result so the model
    // knows what happened. That is a response body written by a provider error, on the success path,
    // where `failures.ts` never gets a say.
    //
    // The control above could not see it: it rejects the model AND the repository, so the model's
    // rejection throws out of `runAgentTurn` first and the 200 path is never reached. This one
    // drives ONLY the repository, which is the whole difference between a test and a control.
    it('does not carry a failed tool\'s error into the transcript it returns', async () => {
      const { app } = build({
        model: createScriptedChatModel([
          { kind: 'tools', calls: [{ id: 'call-1', name: 'recall', args: { query: 'checkout' } }] },
          { kind: 'answer', text: 'I could not check the archive, so I cannot say.' },
        ]),
        repository: fakeRepository({
          recall: () => Promise.reject(new Error(`AccessDeniedException: ${POISON} is not authorized`)),
        }),
      });

      const response = await ask(app, { message: 'what broke last time?' });
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain('arn:aws');
      expect(raw).not.toContain('123456789012');
      expect(raw).not.toContain('AccessDeniedException');
    });

    // THE THIRD EXIT, and the two controls above cannot see it. Both drive a REPOSITORY STUB that
    // rejects, and production's repository does not reject on this path: `runRecall` CATCHES an
    // embedder or database failure and RETURNS a receipt whose `coverageReason` quotes the caught
    // error. That receipt is rendered into a `tool_result`, the transcript carries it, and a 200
    // carries the transcript. So the leak lives on the path a stub that throws can never reach.
    //
    // This one therefore uses the REAL `createRepository` with a rejecting embedder, which is what
    // an expired AWS session actually looks like from inside a recall.
    /**
     * Answers the exclusion-count aggregate so a recall can reach a COVERED verdict on no rows.
     *
     * The count row matters more than it looks. Without it `workspaceCounts` fails, recall returns
     * UNKNOWN, and the COVERED path this fixture exists to reach is never entered - which is how
     * the first version of the second control below scored a 500 and proved nothing at all.
     */
    const emptyWorkspace = () =>
      createFakeDatabase((text) =>
        mentions(text, 'count(*)') ? [{ tombstoned: '0', unembedded: '0' }] : [],
      );

    it('does not carry a real embedder failure into the transcript it returns', async () => {
      const refusingEmbedder: Embedder = {
        id: 'test-embedder',
        dimensions: 8,
        embed: () => Promise.reject(new Error(`AccessDeniedException: ${POISON} is not authorized`)),
      };
      const { app } = build({
        model: createScriptedChatModel([
          { kind: 'tools', calls: [{ id: 'call-1', name: 'recall', args: { query: 'checkout' } }] },
          { kind: 'answer', text: 'The search could not run, so I cannot tell you.' },
        ]),
        repository: createRepository({
          db: emptyWorkspace(),
          embedder: refusingEmbedder,
          capabilities: CAPABILITIES,
          schema: 'throughline',
        }),
      });

      const response = await ask(app, { message: 'what broke last time?' });
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain('arn:aws');
      expect(raw).not.toContain('123456789012');
      expect(raw).not.toContain('AccessDeniedException');
    });

    // THE FOURTH EXIT, and it does not need anything to fail at all. `degradations` carries the
    // reason recall fell back to an exact scan, that reason quotes the capability probe's own
    // `unknown` text, and the probe builds THAT by quoting whatever the driver threw while reading
    // the query plan. Capabilities are probed once at boot, so a cluster that refused the plan read
    // puts the driver's words in EVERY subsequent turn - on a COVERED 200, with nothing wrong.
    it('does not carry a capability probe failure into a COVERED transcript', async () => {
      // The capabilities are PROBED here, not hand-built, and that is the whole difference between this
      // control and the one that replaced it. The first version handed `createRepository` an
      // `unknown(...)` observation with a role ARN already inside it, which injects the poison
      // DOWNSTREAM of the code under test: it would fail forever no matter what `capability.ts`
      // does, so it measured the composition rule and not the producer. This one makes the
      // database reject the index and plan reads the way a cluster refusing them actually does,
      // and asks what the probe writes into its own reason.
      const refusingCluster = createFakeDatabase((text) => {
        if (mentions(text, 'show indexes') || mentions(text, 'explain')) {
          throw new Error(`AccessDeniedException: ${POISON} is not authorized`);
        }
        if (mentions(text, 'information_schema.columns')) return [{ crdb_sql_type: 'VECTOR(8)', data_type: null }];
        if (mentions(text, 'count(*)')) return [{ tombstoned: '0', unembedded: '0' }];
        return [];
      });

      const capabilities = await probeCapabilities(refusingCluster, {
        schema: 'throughline',
        embedder: createLocalEmbedder(8),
      });
      // The precondition this control depends on. If the probe ever starts observing the plan, the
      // exact-scan fallback stops happening and the test below would pass while proving nothing.
      expect(capabilities.annPlanUsesIndex.status).toBe('unknown');

      const { app } = build({
        model: createScriptedChatModel([
          { kind: 'tools', calls: [{ id: 'call-1', name: 'recall', args: { query: 'checkout' } }] },
          { kind: 'answer', text: 'Nothing is on record about that.' },
        ]),
        repository: createRepository({
          db: emptyWorkspace(),
          embedder: createLocalEmbedder(8),
          capabilities,
          schema: 'throughline',
        }),
      });

      const response = await ask(app, { message: 'what broke last time?' });
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain('arn:aws');
      expect(raw).not.toContain('123456789012');
      expect(raw).not.toContain('AccessDeniedException');
    });

    it('keeps the detail in the log where an operator can still read it', async () => {
      const { app, lines } = build({
        model: { id: 'test-model', reply: () => Promise.reject(new Error(`AccessDeniedException: ${POISON}`)) },
      });
      await ask(app, { message: 'hi' });
      expect(lines.some((line) => line.includes('AccessDeniedException'))).toBe(true);
    });

    /**
     * THE WIRING, NOT THE MECHANISM. `agent-loop.test.ts` proves the loop logs an unusable reply
     * when it is handed a logger, and passes its own. What nothing saw is whether the SERVER hands
     * it one: deleting `log` from the `runAgentTurn` call in `server.ts` left all 1484 tests green,
     * because the loop takes the logger as optional and calls it with `log?.()`.
     *
     * With it gone, a truncated reply is a 200 carrying the loop's sentence and NOTHING anywhere
     * records the stop reason, the provider's top level keys, or which refusal fired. That is the
     * one channel this whole path has: the reason may not go in the body, so it reaches the
     * operator here or nowhere. Same shape as the shipped turn budget, which was also tested
     * everywhere except at the value production actually uses.
     */
    it('hands the loop the operator log, which is the only place a refusal says why', async () => {
      const stopReason = 'stopReason was max_tokens on request 1234-abcd';
      const { app, lines } = build({
        model: { id: 'truncating', reply: () => Promise.reject(new ChatResponseError(stopReason)) },
      });

      const response = await ask(app, { message: 'what broke last time?' });

      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).toContain('did not return a reply this server could use');
      expect(lines.some((line) => line.includes(stopReason))).toBe(true);
      // The reason is for the operator. A response body is not where a caller finds out what a
      // provider called something.
      expect(raw).not.toContain(stopReason);
    });

    it('reports a database failure as unavailable rather than as a mystery', async () => {
      const { app } = build({
        model: { id: 'test-model', reply: () => Promise.reject(new DatabaseError('connection refused', '08006')) },
      });
      const response = await ask(app, { message: 'hi' });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'memory_unavailable' });
    });
  });

  describe('the receipts the console racks', () => {
    // The console renders STRUCTURED fields. If this ever came back empty while the transcript
    // still had a rendered recall in it, the board would go blank while the log looked fine, and
    // the only way to get the numbers back would be to parse the sentence written for the model.
    it('returns the receipt as data alongside the transcript, not only as prose', async () => {
      const { app } = build({
        model: createScriptedChatModel([
          { kind: 'tools', calls: [{ id: 'call-1', name: 'recall', args: { query: 'checkout' } }] },
          { kind: 'answer', text: 'Nothing is on record about that.' },
        ]),
        repository: createRepository({
          db: createFakeDatabase((text) =>
            mentions(text, 'count(*)') ? [{ tombstoned: '0', unembedded: '0' }] : [],
          ),
          embedder: createLocalEmbedder(8),
          capabilities: CAPABILITIES,
          schema: 'throughline',
        }),
      });

      const body = (await (await ask(app, { message: 'what broke last time?' })).json()) as {
        recalls: { callId: string; receipt: Record<string, unknown>; memories: unknown[] }[];
        transcript: { role: string; id?: string; given?: string }[];
      };

      expect(body.recalls).toHaveLength(1);
      const [event] = body.recalls;
      // THE LOOP'S OWN ID, NOT THE MODEL'S, and the two are asserted together because the point of
      // the change that split them is that a console can key on one while the record keeps the
      // other. This read `call-1` for both, which is the model's id, and could not have told the
      // difference on a turn where the model sent one id twice.
      expect(event?.callId).toBe('tc-1');
      expect(body.transcript.find((turn) => turn.role === 'tool_call')).toMatchObject({
        id: 'tc-1',
        given: 'call-1',
      });
      expect(event?.receipt).toMatchObject({
        query: 'checkout',
        coverage: 'COVERED',
        retrievalPath: 'ann_index',
        candidatesConsidered: 0,
        returned: 0,
        // Nothing stopped this search, so there is no cause. A console printing "stopped by" over
        // a search that ran to completion would be inventing a failure.
        coverageCause: null,
      });
      expect(event?.memories).toEqual([]);
    });

    // A recall that THREW has no receipt, and the absence is the honest record. An empty receipt
    // would put a blank strip on the board claiming a search happened.
    it('records no recall event for a recall that never completed', async () => {
      const { app } = build({
        model: createScriptedChatModel([
          { kind: 'tools', calls: [{ id: 'call-1', name: 'recall', args: { query: 'checkout' } }] },
          { kind: 'answer', text: 'I could not check.' },
        ]),
        repository: fakeRepository({ recall: () => Promise.reject(new Error('statement timeout')) }),
      });

      const body = (await (await ask(app, { message: 'hi' })).json()) as {
        recalls: unknown[];
        coverage: string;
      };
      expect(body.recalls).toEqual([]);
      expect(body.coverage).toBe('UNKNOWN');
    });
  });

  describe('the status endpoint', () => {
    it('reports a capability nobody could observe as UNKNOWN and never as OK', async () => {
      const { app } = build({
        probeCapabilities: () =>
          Promise.resolve({
            ...CAPABILITIES,
            annPlanUsesIndex: unknown('the query plan could not be read'),
            vectorIndex: unknown('could not list indexes on throughline.memory'),
          }),
      });

      const body = (await (await app.request('/status')).json()) as {
        lamps: { name: string; state: string }[];
      };
      const index = body.lamps.find((lamp) => lamp.name === 'Vector index');
      expect(index?.state).toBe('UNKNOWN');
      // The whole point of the tri-state. DEGRADED is a measurement; nobody measured anything.
      expect(index?.state).not.toBe('DEGRADED');
    });

    // An index that EXISTS and is ignored is a different fact from one that could not be checked,
    // and the lamp has to keep them apart or the page is guessing.
    it('separates an index the planner ignores from one nobody could check', async () => {
      const { app } = build({
        probeCapabilities: () =>
          Promise.resolve({ ...CAPABILITIES, annPlanUsesIndex: observed(false), vectorIndex: observed(true) }),
      });

      const body = (await (await app.request('/status')).json()) as {
        lamps: { name: string; state: string; detail: string }[];
      };
      const index = body.lamps.find((lamp) => lamp.name === 'Vector index');
      expect(index?.state).toBe('DEGRADED');
      expect(index?.detail).toContain('ignoring it');
    });

    // The cluster's host, port and database name are NOT published to an unauthenticated caller.
    // `capabilities.target` carries all three, it was served until a review asked whether it
    // belonged in a public response, and the answer against the real cluster was a CockroachDB
    // Cloud hostname in a 200 that anybody could fetch.
    // BOTH PATHS, because the cached branch is a second place the body gets built and it is
    // exactly the kind that gets forgotten. Two requests, and the second is served from the cache.
    it.each([
      ['the fresh path', 1],
      ['the cached path', 2],
    ])('never publishes the cluster host, port or database name on %s', async (_label, requests) => {
      const { app } = build({
        probeCapabilities: () =>
          Promise.resolve({ ...CAPABILITIES, target: 'secret-cluster-9.aws-eu-central-1.example:26257/defaultdb' }),
      });

      let raw = '';
      for (let i = 0; i < requests; i += 1) raw = await (await app.request('/status')).text();
      expect(raw).not.toContain('secret-cluster-9');
      expect(raw).not.toContain('26257');
      expect(raw).not.toContain('defaultdb');
    });

    // The SECOND round of the same finding. Removing `target` left the schema and table name
    // reaching the same public body through a lamp's `detail`, on the degraded paths only, which
    // is why the first test could not see it: it drove a healthy cluster where no reason is
    // rendered at all.
    //
    // THE THIRD ROUND IS THIS TABLE, and it exists because the single-fixture version of this
    // control was measured to cover ONE of the four sites it was believed to cover. Restoring the
    // `exists.reason` interpolation in `describeIndex` left the whole 37-test suite green: that
    // branch is unreachable when the plan read is unknown, and the one fixture set it unknown.
    // Restoring `plannerUses.reason` was invisible for a different reason, that the reason it
    // leaks does not happen to contain a schema name, and `embedder.reason` is unreachable
    // whenever the column is the thing that could not be read.
    //
    // So the assertion was a fact about which WORDS a fixture chose rather than about the code. A
    // marker in EVERY reason, and one case per interpolation site, is a fact about the code.
    it.each(PROBE_LEAK_CASES)('never publishes a probe reason when $label', async ({ lamp, degraded }) => {
      const { app } = build({
        probeCapabilities: () => Promise.resolve({ ...CAPABILITIES, ...degraded }),
      });

      const raw = await (await app.request('/status')).text();
      expect(raw).not.toContain(PROBE_REASON_MARKER);
      // UNLIT rather than absent, asserted on the lamp this case actually degrades. A substring
      // check for 'UNKNOWN' anywhere in the body cannot fail here: the MCP lamp is UNKNOWN in
      // every one of these fixtures, so it would pass while the degraded lamp had vanished.
      const body = JSON.parse(raw) as { lamps: { name: string; state: string }[] };
      expect(body.lamps.find((one) => one.name === lamp)?.state).toBe('UNKNOWN');
    });

    // One GET runs six statements against the cluster and the rail is on every page. Without a
    // cache, clicking through the site spends a probe per page view.
    it('probes once for a SEQUENCE of requests rather than once per request', async () => {
      let probes = 0;
      const { app } = build({
        probeCapabilities: () => {
          probes += 1;
          return Promise.resolve(CAPABILITIES);
        },
      });

      for (let i = 0; i < 3; i += 1) expect((await app.request('/status')).status).toBe(200);
      expect(probes).toBe(1);
    });

    // And once for a CONCURRENT burst, which the sequential test above cannot see. Caching the
    // result rather than the promise passes that one and probes three times here, which is the
    // shape a status page actually gets hit in.
    it('probes once for a concurrent burst', async () => {
      let probes = 0;
      const { app } = build({
        probeCapabilities: () => {
          probes += 1;
          return Promise.resolve(CAPABILITIES);
        },
      });

      const responses = await Promise.all([0, 1, 2].map(() => app.request('/status')));
      for (const response of responses) expect(response.status).toBe(200);
      expect(probes).toBe(1);
    });

    // The window has to END, or "right now" quietly becomes "at boot" again. The clock is injected,
    // so this is measured rather than slept through.
    it('probes again once the window has passed, and not a moment before', async () => {
      let probes = 0;
      let now = new Date('2026-08-05T12:00:00Z');
      const { app } = build({
        now: () => now,
        probeCapabilities: () => {
          probes += 1;
          return Promise.resolve(CAPABILITIES);
        },
      });

      await app.request('/status');
      now = new Date('2026-08-05T12:00:14.999Z');
      await app.request('/status');
      expect(probes).toBe(1);

      now = new Date('2026-08-05T12:00:15.000Z');
      await app.request('/status');
      expect(probes).toBe(2);
    });

    // Configuration is not reachability, and the lamp must not pretend otherwise: this endpoint
    // deliberately does not open the channel, so it can never report it as OK.
    it('never reports the verification channel as OK, because it does not open it', async () => {
      for (const configured of [true, false]) {
        const { app } = build({ verificationChannelConfigured: configured });
        const body = (await (await app.request('/status')).json()) as {
          lamps: { name: string; state: string }[];
        };
        expect(body.lamps.find((lamp) => lamp.name === 'MCP transport')?.state).not.toBe('OK');
      }
    });
  });

  describe('the memories endpoint', () => {
    const listing = (page: MemoryPage) => build({ repository: fakeRepository({ list: () => Promise.resolve(page) }) });

    const get = (app: ReturnType<typeof build>['app'], query = '') => app.request(`/memories${query}`);

    it('returns rows and the receipt that says whether the listing ran', async () => {
      const { app } = listing(memoryPage({ memories: [memoryRecord({})] }));
      const response = await get(app);
      expect(response.status).toBe(200);

      const body = (await response.json()) as MemoryListResponse;
      expect(body.server).toBe(SERVER_NAME);
      expect(body.memories).toHaveLength(1);
      expect(body.receipt.coverage).toBe('COVERED');
      expect(body.receipt.returned).toBe(1);
    });

    // THE POINT OF THE WHOLE ROUTE. An archive page that renders an empty rack for a failed query is
    // the exact failure this product is an argument against, so the receipt has to reach the browser
    // alongside the rows and never instead of them.
    it('hands back UNKNOWN with a cause rather than an empty archive', async () => {
      const { app } = listing(memoryPage({ coverage: 'UNKNOWN' }));
      const body = (await (await get(app)).json()) as MemoryListResponse;

      expect(body.memories).toEqual([]);
      expect(body.receipt.coverage).toBe('UNKNOWN');
      expect(body.receipt.coverageCause).toBe('listing_query_failed');
    });

    // A LISTED ROW HAS NO SIMILARITY AND NO SCORE, because no query ran and nothing ranked it.
    // Reusing `RecalledMemoryView` and sending zeros would have been the easy move and would have
    // put two invented numbers on the one page that exists to be checked.
    it('publishes no similarity and no score on a row nothing ranked', async () => {
      const { app } = listing(memoryPage({ memories: [memoryRecord({})] }));
      const raw = await (await get(app)).text();

      expect(raw).not.toContain('similarity');
      expect(raw).not.toContain('score');
      // The numbers that ARE honest here travel: both are pure time decay, no query involved.
      const body = JSON.parse(raw) as MemoryListResponse;
      // One row went in, so one row is the claim. The test below already reads its whole array.
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0]).toHaveProperty('freshness');
      expect(body.memories[0]).toHaveProperty('stale');
    });

    it('labels a current row, a superseded one and a tombstone differently', async () => {
      const { app } = listing(
        memoryPage({
          memories: [
            memoryRecord({ id: MEMORY_ID_A }),
            memoryRecord({ id: MEMORY_ID_B, supersededBy: MEMORY_ID_A }),
            memoryRecord({
              id: MEMORY_ID_C,
              evictedAt: new Date('2026-08-04T00:00:00Z'),
              evictionReason: 'evicted by the scheduled sweep',
            }),
          ],
        }),
      );
      const body = (await (await get(app)).json()) as MemoryListResponse;

      expect(body.memories.map((one) => one.state)).toEqual(['current', 'superseded', 'tombstoned']);
      // The chain link keeps its pointer, which is what makes a chain renderable at all.
      expect(body.memories[1]?.supersededBy).toBe(MEMORY_ID_A);
      expect(body.memories[2]?.evictionReason).toBe('evicted by the scheduled sweep');
    });

    // A row can be BOTH, and the archive page gates its whole tombstone row on the label, so getting
    // the precedence wrong does not merely misstamp a strip: the eviction date and reason disappear
    // from the page. Reachable in production, because the sweep does not exclude superseded rows.
    it('keeps every field on a row that was superseded and then evicted', async () => {
      const { app } = listing(
        memoryPage({
          memories: [
            memoryRecord({
              id: MEMORY_ID_B,
              supersededBy: MEMORY_ID_A,
              evictedAt: new Date('2026-08-04T00:00:00Z'),
              evictionReason: 'evicted by the scheduled sweep',
            }),
          ],
        }),
      );
      const body = (await (await get(app)).json()) as MemoryListResponse;
      expect(body.memories).toHaveLength(1);
      const row = body.memories[0];

      expect(row?.state).toBe('tombstoned');
      // The label is a HEADLINE, not the whole history. Both halves still travel, so a reader who
      // needs the other one has it.
      expect(row?.supersededBy).toBe(MEMORY_ID_A);
      expect(row?.evictedAt).toBe('2026-08-04T00:00:00.000Z');
      expect(row?.evictionReason).toBe('evicted by the scheduled sweep');
    });

    it('passes a kind filter through to the repository', async () => {
      const seen: (readonly MemoryKind[] | undefined)[] = [];
      const { app } = build({
        repository: fakeRepository({
          list: (query) => {
            seen.push(query.kinds);
            return Promise.resolve(memoryPage({ kinds: query.kinds ?? [] }));
          },
        }),
      });

      await get(app, '?kind=resolution&kind=runbook_fact');
      expect(seen[0]).toEqual(['resolution', 'runbook_fact']);
    });

    // A REFUSAL AND NOT A SILENT DROP. Ignoring an unknown kind answers a question nobody asked: the
    // caller gets the whole archive and no sign that their filter did nothing at all.
    it('refuses an unknown kind instead of quietly ignoring the filter', async () => {
      const { app } = build({
        repository: fakeRepository({ list: () => Promise.reject(new Error('list must not be reached')) }),
      });
      const response = await get(app, '?kind=wishful_thinking');

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; fields?: readonly string[] };
      expect(body.error).toBe('unknown_kind');
      expect(body.fields).toEqual(['wishful_thinking']);
    });

    // THE FIRST ROUTE IN THIS API TO PUT CALLER TEXT IN A RESPONSE BODY, so the reflection is capped
    // in both directions. Measured before capping: a 2,060-byte query produced a 4,261-byte response,
    // and a thousand repeated parameters came back a thousand times.
    it('caps how much of a caller kind it quotes back, and how many', async () => {
      const { app } = build({
        repository: fakeRepository({ list: () => Promise.reject(new Error('list must not be reached')) }),
      });
      const long = 'z'.repeat(500);
      const many = Array.from({ length: 40 }, (_unused, index) => `kind=nope${index}`).join('&');
      const response = await get(app, `?kind=${long}&${many}`);

      expect(response.status).toBe(400);
      const raw = await response.text();
      const body = JSON.parse(raw) as { fields?: readonly string[] };
      expect(body.fields?.length).toBeLessThanOrEqual(5);
      // Truncated rather than dropped, so the caller can still see which name was wrong.
      expect(raw).not.toContain(long);
      expect(body.fields?.[0]?.length).toBeLessThanOrEqual(41);
      // A second lock on a shut door: the content type is already JSON, which no browser sniffs.
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    // THE CLAIM THAT HAD NO CONTROL. `694957e`'s message said six fixes each landed "with a control
    // watched firing by name". A review restored the pre-fix `value.slice(0, 40)` and all 57 tests in
    // this file stayed green; nothing anywhere mentioned a surrogate. Five of the six were true.
    //
    // `slice` counts UTF-16 units. An astral character whose pair occupies units 39 and 40 is cut in
    // half by a slice at 40, so a LONE HIGH SURROGATE goes into the response body. `JSON.stringify`
    // escapes it to `\uD83D`, so the wire stays valid JSON and nothing visibly breaks - which is
    // exactly why it would have sat there indefinitely.
    it('truncates a caller kind by code point, so no half a character reaches the response', async () => {
      const { app } = build({
        repository: fakeRepository({ list: () => Promise.reject(new Error('list must not be reached')) }),
      });
      // 39 ASCII, then an astral character occupying units 39 and 40, then enough to force a cut:
      // 45 code points against 46 UTF-16 units, so both the old rule and the new one truncate.
      const kind = `${'z'.repeat(39)}\u{1F600}abcde`;
      const response = await get(app, `?kind=${encodeURIComponent(kind)}`);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { fields?: readonly string[] };
      const reflected = body.fields?.[0] ?? '';

      // It really was truncated, so what follows is an assertion about a cut string rather than an
      // untouched one that would pass whatever the rule did.
      expect(reflected.endsWith('…')).toBe(true);
      // A high surrogate with no low after it, or a low with no high before it. Deliberately NOT a
      // `u`-flagged pattern: this has to see UTF-16 units, which is the unit the defect is in.
      expect(reflected).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      // And the character survived WHOLE rather than being dropped to dodge the problem.
      expect(reflected).toBe(`${'z'.repeat(39)}\u{1F600}…`);
    });

    it('reads the clock once for the whole response, not once per row', async () => {
      // It used to be N+1, so a page of rows was built from as many instants and `requestedAt` did
      // not match the ages printed beside it. Harmless in practice and still wrong, and the first fix
      // landed with nothing watching it: re-planting the per-row read left the suite green.
      let reads = 0;
      const { app } = build({
        now: () => {
          reads += 1;
          return new Date('2026-08-05T12:00:00Z');
        },
        repository: fakeRepository({
          list: () =>
            Promise.resolve(
              memoryPage({ memories: [memoryRecord({ id: MEMORY_ID_A }), memoryRecord({ id: MEMORY_ID_B })] }),
            ),
        }),
      });

      await get(app);
      // One for the rate limiter, one for the response. Never one per row.
      expect(reads).toBe(2);
    });

    it('collapses a repeated kind rather than echoing it back and sending it to the database', async () => {
      // Measured before this: `?kind=resolution` a thousand times came back as a thousand entries in
      // `receipt.kinds` on a perfectly successful 200, and travelled into the SQL as a thousand
      // element array. A repeated kind means nothing the kind alone does not.
      const seen: (readonly MemoryKind[] | undefined)[] = [];
      const { app } = build({
        repository: fakeRepository({
          list: (query) => {
            seen.push(query.kinds);
            return Promise.resolve(memoryPage({ kinds: query.kinds ?? [] }));
          },
        }),
      });

      const many = Array.from({ length: 1_000 }, () => 'kind=resolution').join('&');
      const response = await get(app, `?${many}`);

      expect(response.status).toBe(200);
      expect(seen[0]).toEqual(['resolution']);
      const body = (await response.json()) as MemoryListResponse;
      expect(body.receipt.kinds).toEqual(['resolution']);
    });

    it('refuses an unknown kind even when a valid one travels with it', async () => {
      // The filter is a conjunction of the caller's intentions. Honouring the half it understood
      // would answer a narrower question than the one asked, silently.
      const { app } = build({
        repository: fakeRepository({ list: () => Promise.reject(new Error('list must not be reached')) }),
      });
      expect((await get(app, '?kind=resolution&kind=nonsense')).status).toBe(400);
    });

    it('forwards a numeric limit and lets the memory layer clamp it', async () => {
      const seen: (number | undefined)[] = [];
      const { app } = build({
        repository: fakeRepository({
          list: (query) => {
            seen.push(query.limit);
            return Promise.resolve(memoryPage({}));
          },
        }),
      });

      await get(app, '?limit=7');
      expect(seen[0]).toBe(7);
    });

    it('leaves the limit unset when the caller did not ask for one', async () => {
      // `exactOptionalPropertyTypes` is on, so this is a conditional spread rather than
      // `limit: undefined`. The difference is visible here: `boundedLimit` reads an ABSENT bound as
      // "no preference" and would read an explicit `undefined` the same way, but the repository's own
      // signature says the property is optional and the route should not invent it.
      const seen: { hasLimit: boolean }[] = [];
      const { app } = build({
        repository: fakeRepository({
          list: (query) => {
            seen.push({ hasLimit: 'limit' in query });
            return Promise.resolve(memoryPage({}));
          },
        }),
      });

      await get(app);
      expect(seen[0]?.hasLimit).toBe(false);
    });

    // THE WORKSPACE IS SERVER SIDE ON EVERY ROUTE, and this one takes a query string, which is
    // exactly where that rule gets quietly broken. A caller naming the workspace is an access
    // control decision in a URL.
    it('ignores a workspace in the query string and uses the configured one', async () => {
      const seen: string[] = [];
      const { app } = build({
        workspaceId: 'demo',
        repository: fakeRepository({
          list: (query) => {
            seen.push(query.workspaceId);
            return Promise.resolve(memoryPage({}));
          },
        }),
      });

      await get(app, '?workspaceId=someone-elses&workspace=someone-elses');
      expect(seen).toEqual(['demo']);
    });

    it('never publishes the workspace id in the response', async () => {
      // The memory layer's own receipt carries it and the mapper drops it, for the reason
      // `capabilities.target` was dropped from /status: it is an internal identifier and an
      // unauthenticated caller gains nothing from it.
      const { app } = listing(memoryPage({ memories: [memoryRecord({})] }));
      const raw = await (await get(app)).text();

      expect(raw).not.toContain('workspaceId');
      expect(raw).not.toContain('demo');
    });

    it('is rate limited like every other route that costs the database something', async () => {
      const { app } = listing(memoryPage({}));
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) statuses.push((await get(app)).status);

      // The limit is 3 per minute in these fixtures.
      expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it('spends no model budget, because it calls no model', async () => {
      // The daily ceiling exists to bound the model bill. This route runs one SELECT, so claiming
      // against that ceiling would refuse a page view once the demo had answered enough questions.
      const budget = budgetStub(false);
      const { app } = build({
        budget,
        repository: fakeRepository({ list: () => Promise.resolve(memoryPage({})) }),
      });

      expect((await get(app)).status).toBe(200);
    });
  });

  describe('the verify endpoint', () => {
    const verifyRequest = (app: ReturnType<typeof build>['app'], memoryId = MEMORY_ID_A) =>
      app.request('/verify', {
        method: 'POST',
        body: JSON.stringify({ memoryId }),
        headers: { 'content-type': 'application/json' },
      });

    it('reports an unreachable channel as unknown rather than as agreement', async () => {
      const { app } = build({
        repository: fakeRepository({ getById: () => Promise.resolve(memoryRecord()) }),
      });
      const response = await verifyRequest(app);
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: string; detail: string };
      expect(body.error).toBe('verification_unavailable');
      expect(body.detail).toContain('unknown result');
    });

    it('does not write an audit row for a verification that never happened', async () => {
      const database = createFakeDatabase(() => []);
      const { app } = build({
        database,
        repository: fakeRepository({ getById: () => Promise.resolve(memoryRecord()) }),
      });
      await verifyRequest(app);
      expect(database.queries.filter((query) => mentions(query.text, 'memory_audit'))).toHaveLength(0);
    });

    it('refuses an id that is not a memory id', async () => {
      const { app } = build();
      const response = await verifyRequest(app, 'not-a-uuid');
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ fields: ['memoryId'] });
    });
  });
});
