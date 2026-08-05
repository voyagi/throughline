import { describe, expect, it } from 'vitest';
import { DatabaseError } from '@throughline/memory';
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
