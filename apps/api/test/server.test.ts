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
} from '@throughline/memory';
import { createFakeDatabase, mentions } from '../../../packages/memory/test/fake-database.ts';
import type { ChatModel, ChatReply } from '../src/agent/loop.ts';
import { createScriptedChatModel } from '../src/agent/local-model.ts';
import { McpError, type McpClient } from '../src/mcp-client.ts';
import type { DemoBudget } from '../src/http/demo-budget.ts';
import { loadDemoLimits } from '../src/http/limits.ts';
import { createApp, SERVER_NAME, UNKNOWN_CLIENT, type ServerDependencies } from '../src/server.ts';
import { fakeRepository, MEMORY_ID_A, memoryRecord } from './agent-fixtures.ts';

const ORIGIN = 'https://throughline.example';
const POISON = 'arn:aws:sts::123456789012:assumed-role/throughline-admin/session';

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

    // A missing Content-Length is not a promise about size, so the read is measured too.
    it('refuses an oversized body that declares no length', async () => {
      const { app } = build();
      const response = await app.request('/agent/turn', {
        method: 'POST',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: 'x'.repeat(200_000) })));
            controller.close();
          },
        }),
        headers: { 'content-type': 'application/json' },
        // Required by undici whenever the body is a stream.
        duplex: 'half',
      } as RequestInit);
      expect(response.status).toBe(413);
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
      };

      expect(body.recalls).toHaveLength(1);
      const [event] = body.recalls;
      expect(event?.callId).toBe('call-1');
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
    it('never publishes internal schema or table names through a lamp detail', async () => {
      const { app } = build({
        probeCapabilities: () =>
          Promise.resolve({
            ...CAPABILITIES,
            vectorIndex: unknown('could not list indexes on throughline.memory'),
            annPlanUsesIndex: unknown('the query plan could not be read'),
            vectorColumnDimensions: unknown('could not inspect the embedding column on throughline.memory'),
          }),
      });

      const raw = await (await app.request('/status')).text();
      expect(raw).not.toContain('throughline.memory');
      // The lamps must still be UNLIT rather than absent: hiding the reason must not hide the state.
      expect(raw).toContain('UNKNOWN');
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
