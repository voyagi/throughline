import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AgentTurnResponse, HealthResponse, StatusResponse } from '@throughline/contract';
import type { Capabilities, Database, MemoryRepository } from '@throughline/memory';
import { toLamps, toRecallEvent } from './http/contract.ts';
import { runAgentTurn, type ChatModel } from './agent/loop.ts';
import { verifyMemory } from './mcp-verifier.ts';
import { McpError, type McpClient } from './mcp-client.ts';
import { recordVerification } from './http/audit.ts';
import { decideCors, preflightHeaders } from './http/cors.ts';
import type { DemoBudget } from './http/demo-budget.ts';
import { BodyTooLargeError, describeFailure, MalformedJsonError } from './http/failures.ts';
import type { DemoLimits } from './http/limits.ts';
import { createRateLimiter, type RateLimiter } from './http/rate-limit.ts';

/**
 * The HTTP surface.
 *
 * A FACTORY WITH NO SIDE EFFECTS, and the process entry point lives in `main.ts`. Not a
 * self-execution guard at the bottom of this file, because this repository has already paid for
 * that one: `scripts/lib/advisories.mjs` carries the note that
 * `process.argv[1] === fileURLToPath(import.meta.url)` is FALSE whenever a script is reached
 * through a symlink or a Windows junction, so the advisory gate did nothing, printed nothing and
 * exited 0. A gate whose only failure symptom is silence is worse than no gate, and a server whose
 * only failure symptom is silence is the same bug wearing a different hat. There is no guard here
 * to get wrong.
 *
 * WHAT PROTECTS THE DEMO, in the order a request meets it:
 *
 * 1. CORS from an exact allowlist. See `http/cors.ts` for why `hono/cors` is not used.
 * 2. A token bucket per client, in memory, which is fast and forgets everything on a cold start.
 * 3. A daily ceiling counted IN THE DATABASE, checked BEFORE the model call. This is the one that
 *    actually protects the bill, because it is the one a cold start cannot reset.
 *
 * The workspace is NOT read from the request. It is server side configuration. A public demo whose
 * caller names the workspace is a public demo with an access control decision in the request body.
 */

/** Every response the console branches on carries this, so a proxy answering instead is obvious. */
export const SERVER_NAME = 'throughline-api';

/**
 * The bucket a request lands in when the client address cannot be determined.
 *
 * One SHARED bucket rather than a free pass. If the address is unavailable, every anonymous request
 * competes for the same tokens, so the demo gets stricter rather than looser. That is a degradation
 * and it is reported as one: it is logged, because the alternative is a rate limiter that quietly
 * stopped distinguishing clients.
 */
export const UNKNOWN_CLIENT = 'unknown-client';

const turnSchema = z.object({
  message: z.string().min(1, 'a message is required').max(4_000, 'that message is too long'),
});

const verifySchema = z.object({
  memoryId: z.string().uuid('must be a memory id'),
});

export interface ServerDependencies {
  readonly limits: DemoLimits;
  readonly repository: MemoryRepository;
  readonly model: ChatModel;
  readonly budget: DemoBudget;
  readonly database: Database;
  readonly schema: string;
  /** The database NAME, which the verification channel takes as an argument. */
  readonly databaseName: string;
  readonly workspaceId: string;
  /**
   * Opens the verification channel, lazily.
   *
   * A function rather than a client, because `loadMcpConfig` THROWS when the channel is not
   * configured and it is not configured today. Eager construction would mean this whole server
   * refuses to start without cloud credentials it does not otherwise need, which would make the
   * offline demo depend on the one thing the offline demo exists to avoid.
   */
  readonly openVerificationChannel: () => McpClient;
  /**
   * Ask the live database what it can do, now.
   *
   * A function and not a value, because `/status` answers "what can this system do right now" and
   * a capability snapshot taken at boot answers a different question. An index dropped at noon
   * would keep reading OK until the next deploy.
   */
  readonly probeCapabilities: () => Promise<Capabilities>;
  /**
   * Whether a verification channel is CONFIGURED. Not whether it answers.
   *
   * The distinction is the point: `/status` reports this as a configuration fact and never as a
   * reachability measurement, because it does not open the channel to draw the lamp.
   */
  readonly verificationChannelConfigured: boolean;
  /** How to identify the caller. Injected so a test never needs a socket. */
  readonly clientAddressOf: (c: Context) => string | null;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

/**
 * The largest body this API will parse, before parsing it.
 *
 * The schemas cap a message at 4,000 characters, and that cap is applied AFTER the whole body has
 * been read and turned into objects. Without this, a public demo happily parses megabytes in order
 * to discover that it is going to reject them, which is a way to spend the process's memory and CPU
 * with no credentials and no rate limit token beyond the first. Generous next to a 4,000 character
 * message so the limit can only ever be hit on purpose.
 */
const MAX_BODY_BYTES = 16 * 1024;

/** Read and validate a JSON body, or fail in a way `describeFailure` can classify. */
async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  // Declared length first, which is the cheap check and the one that stops the work happening. A
  // body with no `Content-Length` still gets measured below, because a missing header is not a
  // promise about size.
  const declared = Number(c.req.header('Content-Length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BodyTooLargeError(`declared ${declared} bytes`);
  }

  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new BodyTooLargeError(`read ${text.length} bytes`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MalformedJsonError('the request body was not valid JSON');
  }
  return schema.parse(raw);
}

function rateLimitMiddleware(
  limiter: RateLimiter,
  deps: Pick<ServerDependencies, 'clientAddressOf' | 'log'>,
): MiddlewareHandler {
  return async (c, next) => {
    const address = deps.clientAddressOf(c);
    if (address === null) {
      deps.log(
        `[rate-limit] no client address available, so this request shares the ${UNKNOWN_CLIENT} ` +
          'bucket with every other unidentified one. The limiter is degraded, not off.',
      );
    }

    const decision = limiter.take(address ?? UNKNOWN_CLIENT);
    if (decision.allowed) {
      await next();
      return;
    }

    return c.json(
      {
        error: 'rate_limited',
        detail: 'That is faster than this demo answers. Wait a moment and ask again.',
      },
      429,
      { 'Retry-After': String(decision.retryAfterSeconds) },
    );
  };
}

export function createApp(deps: ServerDependencies): Hono {
  const { limits, repository, model, budget, workspaceId, log } = deps;
  const allowedOrigins = new Set(limits.allowedOrigins);
  const limiter = createRateLimiter({
    capacity: limits.ratePerMinute,
    windowMs: 60_000,
    now: () => deps.now().getTime(),
    maxTrackedClients: limits.maxTrackedClients,
  });

  const app = new Hono();

  app.use('*', async (c, next) => {
    const cors = decideCors(c.req.header('Origin') ?? null, allowedOrigins);

    if (c.req.method === 'OPTIONS') {
      // A preflight is answered here and never reaches a route, so an origin that is not on the
      // list gets `Vary` and nothing else, which is what makes the browser refuse the real request.
      const headers = cors.allowed ? { ...cors.headers, ...preflightHeaders() } : cors.headers;
      return c.body(null, 204, headers);
    }

    await next();
    for (const [name, value] of Object.entries(cors.headers)) c.header(name, value);
  });

  // NOT rate limited, deliberately. A load balancer has to be able to ask whether this process is
  // alive while a client is over its limit, and the answer costs nothing to produce.
  //
  // It names the server. "Something answered on this port" is not "my server is up": a foreign
  // process holding the port answers a bare TCP check forever, so the body carries an identity a
  // monitor can assert rather than a bare 200.
  app.get('/health', (c) => {
    const body: HealthResponse = { server: SERVER_NAME, status: 'ok' };
    return c.json(body);
  });

  const limited = rateLimitMiddleware(limiter, deps);

  app.post('/agent/turn', limited, async (c) => {
    const body = await readJson(c, turnSchema);

    // BEFORE the model call, never after. Afterwards is an audit trail, not a ceiling.
    const claim = await budget.claim();
    if (!claim.allowed) {
      log(`[budget] refused a turn: the ceiling of ${claim.limit} for ${claim.day} is reached`);
      return c.json(
        {
          error: 'daily_limit_reached',
          detail:
            'This demo has answered as many questions as it is allowed to pay for today. It ' +
            'refuses rather than quietly switching to a recording.',
          limit: claim.limit,
          day: claim.day,
        },
        429,
      );
    }

    // A turn that throws does NOT refund the call. It was attempted, and a refund on failure is a
    // way to spend the provider repeatedly for free.
    const answer = await runAgentTurn({ model, repository, workspaceId }, body.message);

    const response: AgentTurnResponse = {
      text: answer.text,
      coverage: answer.coverage,
      refusedAnAbsenceClaim: answer.refusedAnAbsenceClaim,
      toolCallCount: answer.toolCallCount,
      modelId: answer.modelId,
      transcript: answer.transcript,
      // Receipts as DATA, alongside the transcript rather than instead of it. The transcript is
      // the record of who said what; these are the numbers, so the console never has to recover
      // one by parsing the other.
      recalls: answer.recalls.map((event) => toRecallEvent(event.callId, event.result, deps.now())),
      budget: { used: claim.used, limit: claim.limit, day: claim.day },
    };
    return c.json(response);
  });

  // WHAT THIS SYSTEM CAN ACTUALLY DO RIGHT NOW, asked of the live database rather than remembered
  // from boot. "The last time anyone actually looked" is the fact the status page is about, so a
  // cached answer from process start would be the wrong shape of truth even when its content was
  // right.
  //
  // Rate limited like everything else, deliberately: each call runs real queries against the
  // cluster, and an unlimited status endpoint is a way to spend someone else's database.
  // A short shared cache in front of the probe.
  //
  // One GET runs six statements against the cluster, and the annunciator rail is on every page, so
  // without this a visitor clicking through five pages spends thirty statements to draw the same
  // three lamps. That is a way to spend somebody else's database with no credentials, which is the
  // shape of problem the daily ceiling exists for.
  //
  // IT SAVES STATEMENTS, NOT TOKENS, and an earlier version of this comment claimed both. The
  // `limited` middleware runs BEFORE this handler, so a cached answer has already spent a rate
  // limit token: four calls at a limit of three still give 200, 200, 200, 429 while the probe runs
  // once. Measured, not reasoned about. Giving reads their own looser bucket is the fix for that
  // and it is not this one.
  //
  // Fifteen seconds does not weaken the claim this endpoint makes. "What can this system do right
  // now" is still answered from a probe that ran within the last fifteen seconds, which is a very
  // different thing from the boot snapshot it replaced; an index dropped at noon is reported
  // within fifteen seconds rather than at the next deploy.
  const PROBE_CACHE_MS = 15_000;
  // The PROMISE is cached, not the result, and that is what makes a BURST probe once. Caching the
  // result only helps requests arriving after the first has finished; ten arriving together all
  // miss and all probe, and a status page is exactly the thing that gets hit in bursts. Measured
  // before it was written this way: three concurrent calls probed three times.
  let inFlight: { at: number; capabilities: Promise<Capabilities> } | null = null;

  app.get('/status', limited, async (c) => {
    const now = deps.now().getTime();
    if (inFlight === null || now - inFlight.at >= PROBE_CACHE_MS) {
      const started = deps.probeCapabilities();
      inFlight = { at: now, capabilities: started };
      // Cleared on rejection so one failed probe does not pin this endpoint to a rejected promise
      // for the rest of the window, answering 500 to everybody who follows.
      started.catch(() => {
        if (inFlight?.capabilities === started) inFlight = null;
      });
    }

    const capabilities = await inFlight.capabilities;
    // ONE body-construction path, deliberately. The first version built the response twice, once
    // for the cached branch and once for the fresh one, and a review had to check both to confirm
    // the cluster target was absent from each. Two paths that must agree about what is safe to
    // publish is one more than necessary.
    //
    // `capabilities.target` is NOT served: it is host, port, database and schema of the live
    // cluster, and this endpoint takes no credentials. `observedAt` is the probe's OWN timestamp,
    // so a cached answer reports when somebody actually looked rather than when it was handed over.
    const response: StatusResponse = {
      server: SERVER_NAME,
      observedAt: capabilities.observedAt.toISOString(),
      lamps: toLamps(capabilities, deps.verificationChannelConfigured),
    };
    return c.json(response);
  });

  // A USER ACTION AND NEVER A MODEL TOOL. It costs a round trip over a second channel, and a model
  // that decides when to audit itself is theatre. No daily ceiling either: this one spends no model
  // tokens, and the rate limiter already bounds it.
  app.post('/verify', limited, async (c) => {
    const body = await readJson(c, verifySchema);
    const memory = await repository.getById(workspaceId, body.memoryId);

    const report = await verifyMemory(deps.openVerificationChannel(), {
      database: deps.databaseName,
      schema: deps.schema,
      workspaceId,
      memoryId: body.memoryId,
      memory,
    });

    await recordVerification({
      database: deps.database,
      schema: deps.schema,
      workspaceId,
      memoryId: body.memoryId,
      report,
    });

    return c.json(report);
  });

  app.notFound((c) => c.json({ error: 'not_found', detail: 'No route here.' }, 404));

  app.onError((error, c) => {
    const failure = describeFailure(error);

    // The server's OWN WORDS, masked, and this is the consumer `McpError.serverMessage` was waiting
    // for. Its docblock said the field should be deleted if the HTTP surface shipped without
    // logging it, because masking a value only the test suite ever observes is a promise rather
    // than a control. This is that surface, so it logs it. It goes to the log and never to the
    // response: the masking is a best effort blocklist, while every sentence in `failure.body` is
    // written from scratch and cannot leak.
    const serverWords =
      error instanceof McpError && error.serverMessage !== undefined
        ? ` | server said: ${error.serverMessage}`
        : '';

    // The detail a human needs is LOGGED, never served. Every sentence the caller gets BACK FROM
    // HERE is a literal from `failures.ts`. That is deliberately narrower than it used to read: an
    // earlier version of this comment claimed everything the caller sees comes from there, and a
    // review disproved it by reading a role ARN out of a 200, because `/agent/turn` returns a
    // transcript and this handler never sees the success path. That hole is closed where it was, in
    // the loop, rather than by widening a claim here.
    log(
      `[error] ${c.req.method} ${c.req.path} -> ${failure.status} (${failure.rule}): ` +
        `${String(error)}${serverWords}`,
    );
    return c.json(failure.body, failure.status);
  });

  return app;
}
