import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, DatabaseError } from '@throughline/memory';
import { createFakeDatabase, mentions } from '../../../packages/memory/test/fake-database.ts';
import { McpError } from '../src/mcp-client.ts';
import type { VerificationReport } from '../src/mcp-verifier.ts';
import { CONSOLE_ACTOR, recordVerification } from '../src/http/audit.ts';
import { decideCors, preflightHeaders } from '../src/http/cors.ts';
import { createDemoBudget, utcDayOf } from '../src/http/demo-budget.ts';
import {
  BodyTooLargeError,
  describeFailure,
  FAILURE_RULES,
  MalformedJsonError,
} from '../src/http/failures.ts';
import { loadDemoLimits, LimitsError, parseOrigins } from '../src/http/limits.ts';
import { clientAddressFrom, createRateLimiter } from '../src/http/rate-limit.ts';

/** A string shaped like the thing that must never reach a caller. */
const POISON =
  'arn:aws:sts::123456789012:assumed-role/throughline-admin/session is not authorized to perform ' +
  'bedrock:InvokeModel, and postgresql://root:hunter2@host:26257/defaultdb';

describe('the demo limits', () => {
  it('has working defaults, so an empty environment still starts', () => {
    expect(loadDemoLimits({})).toEqual({
      ratePerMinute: 10,
      maxAgentCallsPerDay: 500,
      allowedOrigins: [],
      trustProxyHeader: false,
      maxTrackedClients: 10_000,
    });
  });

  // Empty rather than a permissive default. A cross-origin caller is something an operator names.
  it('allows nothing across origins until somebody says otherwise', () => {
    expect(loadDemoLimits({}).allowedOrigins).toEqual([]);
  });

  // Zero closes the agent, which is a kill switch an operator can reach without a deploy.
  it('accepts a daily ceiling of zero', () => {
    expect(loadDemoLimits({ DEMO_MAX_AGENT_CALLS_PER_DAY: '0' }).maxAgentCallsPerDay).toBe(0);
  });

  // A per-minute rate of zero is not a kill switch, it is a division by zero in Retry-After.
  it.each(['0', '-1', 'ten'])('refuses a per-minute rate of %j', (value) => {
    expect(() => loadDemoLimits({ DEMO_RATE_LIMIT_PER_MINUTE: value })).toThrow(LimitsError);
  });

  // The header is client supplied. Trusting it with no proxy in front lets anybody mint a fresh
  // bucket per request, so it must be off unless someone deliberately turns it on.
  it('does not trust X-Forwarded-For unless told to, and only by an exact word', () => {
    expect(loadDemoLimits({}).trustProxyHeader).toBe(false);
    expect(loadDemoLimits({ DEMO_TRUST_PROXY_HEADER: 'true' }).trustProxyHeader).toBe(true);
    expect(() => loadDemoLimits({ DEMO_TRUST_PROXY_HEADER: 'yes' })).toThrow(LimitsError);
  });
});

describe('the CORS allowlist', () => {
  it('refuses a wildcard, which is the reflected origin written short', () => {
    expect(() => parseOrigins('*')).toThrow(LimitsError);
    expect(() => parseOrigins('https://a.example, *')).toThrow(LimitsError);
  });

  // A trailing slash is the silent one: a browser never sends it, so the entry can never match and
  // the allowlist looks like it is working right up until somebody uses the site.
  it.each(['http://localhost:4321/', 'https://a.example/app', 'localhost:4321', 'ftp://a.example'])(
    'refuses %j, which a browser cannot send as an origin',
    (entry) => {
      expect(() => parseOrigins(entry)).toThrow(LimitsError);
    },
  );

  it('accepts an ordinary list and trims it', () => {
    expect(parseOrigins(' http://localhost:4321 , https://throughline.example ')).toEqual([
      'http://localhost:4321',
      'https://throughline.example',
    ]);
    expect(parseOrigins('')).toEqual([]);
  });

  const allowed = new Set(['https://throughline.example']);

  it('never sends an allow-origin header for an origin that is not on the list', () => {
    const decision = decideCors('https://attacker.example', allowed);
    expect(decision.allowed).toBe(false);
    expect(decision.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('matches exactly, so a case variant is a different origin', () => {
    expect(decideCors('https://THROUGHLINE.example', allowed).allowed).toBe(false);
  });

  it('echoes only a matched origin, and a request with none is not allowed', () => {
    expect(decideCors('https://throughline.example', allowed).headers).toEqual({
      Vary: 'Origin',
      'Access-Control-Allow-Origin': 'https://throughline.example',
    });
    expect(decideCors(null, allowed).allowed).toBe(false);
  });

  // Vary in BOTH directions or a shared cache hands one origin the other's answer.
  it.each([
    ['an allowed origin', 'https://throughline.example'],
    ['a refused origin', 'https://attacker.example'],
    ['no origin at all', null],
  ])('sets Vary: Origin for %s', (_label, origin) => {
    expect(decideCors(origin, allowed).headers['Vary']).toBe('Origin');
  });

  // The advisory's input path is Access-Control-Request-Headers. Nothing may be derived from it.
  it('answers a preflight from a fixed list rather than from the request', () => {
    expect(preflightHeaders()['Access-Control-Allow-Headers']).toBe('content-type');
    expect(preflightHeaders()['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
  });
});

describe('the token bucket', () => {
  const limiterAt = (clock: { ms: number }, capacity = 3) =>
    createRateLimiter({
      capacity,
      windowMs: 60_000,
      now: () => clock.ms,
      maxTrackedClients: 10,
    });

  it('allows exactly the capacity, then refuses', () => {
    const clock = { ms: 0 };
    const limiter = limiterAt(clock);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')].every((d) => d.allowed)).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('never reports Retry-After as zero, which a browser reads as "immediately"', () => {
    const clock = { ms: 0 };
    const limiter = limiterAt(clock, 1);
    limiter.take('a');
    expect(limiter.take('a').retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('refills over time rather than all at once', () => {
    const clock = { ms: 0 };
    const limiter = limiterAt(clock);
    for (let i = 0; i < 3; i += 1) limiter.take('a');
    clock.ms = 20_000; // a third of the window, so one token of three
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('keeps one client out of another client\'s bucket', () => {
    const clock = { ms: 0 };
    const limiter = limiterAt(clock, 1);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('b').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  // A clock that goes backwards must not REMOVE tokens from a bucket that was owed some.
  it('does not punish a client when the clock goes backwards', () => {
    const clock = { ms: 100_000 };
    const limiter = limiterAt(clock, 2);
    limiter.take('a');
    clock.ms = 0;
    expect(limiter.take('a').allowed).toBe(true);
  });

  it('forgets buckets that have had a full window to refill, so the map stays bounded', () => {
    const clock = { ms: 0 };
    const limiter = createRateLimiter({
      capacity: 1,
      windowMs: 60_000,
      now: () => clock.ms,
      maxTrackedClients: 3,
    });
    for (const key of ['a', 'b', 'c']) limiter.take(key);
    expect(limiter.trackedClients).toBe(3);

    clock.ms = 60_000;
    limiter.take('d');
    expect(limiter.trackedClients).toBe(1);
  });

  // Fail CLOSED when every tracked bucket is still active: the demo gets stricter under a flood
  // from many addresses, and the alternative is an unbounded map keyed by whoever is calling.
  it('refuses an unknown client rather than growing past the bound', () => {
    const clock = { ms: 0 };
    const limiter = createRateLimiter({
      capacity: 5,
      windowMs: 60_000,
      now: () => clock.ms,
      maxTrackedClients: 2,
    });
    limiter.take('a');
    limiter.take('b');
    expect(limiter.take('c').allowed).toBe(false);
    expect(limiter.trackedClients).toBe(2);
    // A client already known still gets served.
    expect(limiter.take('a').allowed).toBe(true);
  });

  it.each([0, -1])('refuses to be built with capacity %i rather than dividing by zero', (capacity) => {
    expect(() => createRateLimiter({ capacity, windowMs: 60_000, now: () => 0, maxTrackedClients: 1 })).toThrow();
  });
});

describe('which address the limiter counts against', () => {
  // THE LAST hop, never the first. Each proxy APPENDS, so the leftmost entry is whatever the client
  // sent and a client can put a fresh value there on every request, minting itself an unlimited
  // supply of buckets. The rightmost is the one the nearest proxy wrote.
  it('takes the nearest proxy\'s entry and not the client\'s', () => {
    expect(clientAddressFrom('198.51.100.9, 203.0.113.7', '10.0.0.1', true)).toBe('203.0.113.7');
  });

  it('ignores the header entirely when no proxy is declared', () => {
    expect(clientAddressFrom('198.51.100.9', '10.0.0.1', false)).toBe('10.0.0.1');
  });

  it.each([
    ['an empty header', '', '10.0.0.1'],
    ['a header of only separators', ' , , ', '10.0.0.1'],
  ])('falls back to the socket for %s', (_label, header, socket) => {
    expect(clientAddressFrom(header, socket, true)).toBe(socket);
  });

  // Null rather than an invented key. A fabricated address would silently turn the limiter off by
  // giving every request its own bucket.
  it('reports null when there is nothing usable, rather than inventing a key', () => {
    expect(clientAddressFrom(null, null, true)).toBeNull();
    expect(clientAddressFrom(null, null, false)).toBeNull();
  });
});

describe('the daily ceiling', () => {
  const budgetWith = (respond: Parameters<typeof createFakeDatabase>[0], limit: number, at = '2026-08-05T12:00:00Z') => {
    const database = createFakeDatabase(respond);
    return {
      database,
      budget: createDemoBudget({ database, schema: 'throughline', limit, now: () => new Date(at) }),
    };
  };

  const grants = (text: string): unknown[] => (mentions(text, 'update') ? [{ calls: '7' }] : []);
  const refuses = (): unknown[] => [];

  it('reports the call it just spent', async () => {
    const { budget } = budgetWith(grants, 500);
    await expect(budget.claim()).resolves.toEqual({
      allowed: true,
      used: 7,
      limit: 500,
      day: '2026-08-05',
    });
  });

  // A refusal establishes only that the count is at or above the ceiling. Reporting the ceiling as
  // "used" would be a measurement nobody took.
  it('reports used as null when it refuses, rather than inventing a count', async () => {
    const { budget } = budgetWith(refuses, 500);
    await expect(budget.claim()).resolves.toEqual({
      allowed: false,
      used: null,
      limit: 500,
      day: '2026-08-05',
    });
  });

  // The whole point of the design: the ceiling is a condition INSIDE the update, so two concurrent
  // turns cannot both pass on the last available call. If this moves into application code the
  // atomicity goes with it.
  it('puts the ceiling inside the UPDATE rather than in a read followed by a write', async () => {
    const { database, budget } = budgetWith(grants, 500);
    await budget.claim();
    const update = database.texts().find((text) => mentions(text, 'update'));
    expect(update).toBeDefined();
    expect(mentions(update ?? '', 'set calls = calls + 1', 'where day = $1 and calls < $2')).toBe(true);
  });

  // Seeding the row at 1 would hand out a free call on the first request of the day even with the
  // ceiling set to zero, which is the setting an operator reaches for to close the demo.
  it('seeds the day at zero, so a ceiling of zero really is closed', async () => {
    const { database, budget } = budgetWith(refuses, 0);
    const decision = await budget.claim();
    expect(decision.allowed).toBe(false);
    const insert = database.queries.find((query) => mentions(query.text, 'insert into'));
    expect(insert?.values).toEqual(['2026-08-05']);
    expect(mentions(insert?.text ?? '', 'values ($1, 0)', 'on conflict (day) do nothing')).toBe(true);
  });

  // The day comes from the application, not from the cluster's current_date, because the cluster's
  // session time zone is a setting somebody can change without touching this repository.
  it('rolls over on the UTC day and passes it as a parameter', async () => {
    const { database, budget } = budgetWith(grants, 500, '2026-08-05T23:59:59Z');
    await budget.claim();
    expect(database.queries[1]?.values).toEqual(['2026-08-05', 500]);

    const next = budgetWith(grants, 500, '2026-08-06T00:00:01Z');
    await next.budget.claim();
    expect(next.database.queries[1]?.values).toEqual(['2026-08-06', 500]);
  });

  it('reads a day off an instant without a timezone in the middle', () => {
    expect(utcDayOf(new Date('2026-08-05T23:59:59.999Z'))).toBe('2026-08-05');
  });
});

describe('the audit row for a verification', () => {
  const report: VerificationReport = {
    verdict: 'AGREES',
    memoryId: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'demo',
    checkedAt: new Date('2026-08-05T12:00:00Z'),
    elapsedMs: 42,
    reason: 'both channels agree on every compared field',
    comparedFields: ['id', 'kind'],
    notCompared: ['embedding'],
    differences: [],
    observations: [],
    failure: null,
  };

  it('writes the verify operation the table has always permitted', async () => {
    const database = createFakeDatabase(() => []);
    await recordVerification({
      database,
      schema: 'throughline',
      workspaceId: 'demo',
      memoryId: report.memoryId,
      report,
    });

    const [query] = database.queries;
    expect(mentions(query?.text ?? '', 'insert into', 'memory_audit', "'verify'")).toBe(true);
    expect(query?.values?.[2]).toBe(CONSOLE_ACTOR);
  });

  // An IP address is personal data, this demo serves the EU, and audit rows deliberately outlive
  // the memories they describe, so a retention policy for the memory would not cover them.
  it('records which surface asked and never who asked', async () => {
    const database = createFakeDatabase(() => []);
    await recordVerification({
      database,
      schema: 'throughline',
      workspaceId: 'demo',
      memoryId: report.memoryId,
      report,
    });
    expect(JSON.stringify(database.queries)).not.toContain('203.0.113');
    expect(CONSOLE_ACTOR).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

describe('turning a thrown thing into a response', () => {
  /**
   * One sample per rule, keyed by the rule's own name.
   *
   * The coverage assertion below reads `FAILURE_RULES` rather than this map, so a rule added
   * without a sample turns red. That direction is the whole point: three versions of a control in
   * this repository were written from their author's model of a list instead of from the list, and
   * every one of them could only catch the previous round's bug.
   */
  const samples: Record<string, unknown> = {
    'invalid-request': z.object({ memoryId: z.string().uuid() }).safeParse({ memoryId: POISON }).error,
    'malformed-json': new MalformedJsonError(POISON),
    'body-too-large': new BodyTooLargeError(POISON),
    'database-unreachable': new DatabaseError(POISON, '08006'),
    'verification-channel-failed': new McpError('auth_rejected', POISON, { serverMessage: POISON }),
    'server-misconfigured': new ConfigError(POISON),
  };

  it('has a sample for every rule, so this file cannot drift from the rule list', () => {
    expect(FAILURE_RULES.length).toBeGreaterThan(0);
    expect(FAILURE_RULES.map((rule) => rule.name).sort()).toEqual(Object.keys(samples).sort());
  });

  it.each(FAILURE_RULES.map((rule) => [rule.name] as const))(
    'answers %s without letting the error write the response',
    (name) => {
      const failure = describeFailure(samples[name]);
      expect(failure.rule).toBe(name);
      const rendered = JSON.stringify(failure.body);
      expect(rendered).not.toContain('arn:aws');
      expect(rendered).not.toContain('hunter2');
      expect(rendered).not.toContain('123456789012');
    },
  );

  // The fallback is where a provider error lands, so it carries the same guarantee.
  it('answers an unclassified error from a literal, which is where an ARN would otherwise arrive', () => {
    const failure = describeFailure(new Error(POISON));
    expect(failure.status).toBe(500);
    expect(failure.rule).toBe('unclassified');
    expect(JSON.stringify(failure.body)).not.toContain('arn:aws');
  });

  it.each([null, undefined, 'a string', 42])('survives %j being thrown', (thrown) => {
    expect(describeFailure(thrown).status).toBe(500);
  });

  // Field PATHS are the one thing that comes from the request, and a path is built from the
  // schema's own keys, so it cannot quote what arrived.
  it('names which fields failed without quoting their values', () => {
    const error = z
      .object({ message: z.string().min(1), mode: z.enum(['live', 'canned']) })
      .safeParse({ message: '', mode: POISON }).error;
    const failure = describeFailure(error);
    expect(failure.status).toBe(400);
    expect(failure.body.fields).toEqual(['message', 'mode']);
    expect(JSON.stringify(failure.body)).not.toContain('arn:aws');
  });
});
