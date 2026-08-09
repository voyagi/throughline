import { z } from 'zod';

/**
 * The demo's safety limits and its CORS allowlist, read from the environment.
 *
 * Takes an environment record rather than reading `process.env`, matching `loadDatabaseConfig`, so
 * every branch here is testable without mutating global state.
 *
 * The two `DEMO_` values have sat in `.env.example` since the first commit being read by nothing.
 * This is where they start meaning something.
 */

/**
 * A browser origin, exactly as a browser sends it in the `Origin` header.
 *
 * Scheme, host and optional port. No path, no trailing slash, no query. The strictness is the
 * point: `http://localhost:4321/` with a trailing slash is a perfectly reasonable thing for an
 * operator to write and it can NEVER match, because a browser never sends the slash. An allowlist
 * entry that cannot match is indistinguishable from an allowlist that is working, right up until
 * somebody tries to use the site. So it is refused at load with the offending value named.
 */
// Deliberately NOT case-insensitive. A browser normalises scheme and host to lower case before it
// sends `Origin`, and the membership test below is exact, so `HTTPS://A.EXAMPLE` in the allowlist
// can never match anything: accepting it here would wave through precisely the silent
// never-matches entry this check exists to catch, which is the failure this docblock claims to
// prevent. Found by a review pointing out that the flag contradicted the comment above it.
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

export interface DemoLimits {
  /** Token bucket capacity per client per minute. */
  readonly ratePerMinute: number;
  /**
   * Hard ceiling on agent turns per UTC day, counted in the database.
   *
   * Zero is legal and means the agent is closed. That is a kill switch an operator can reach for
   * without a deploy, which is worth more than the tidiness of refusing the value.
   */
  readonly maxAgentCallsPerDay: number;
  /** Exact-match allowlist. Empty means no cross-origin browser client is permitted. */
  readonly allowedOrigins: readonly string[];
  /**
   * Whether to read the client address from `X-Forwarded-For`.
   *
   * Off by default and it must stay that way. The header is client-supplied: with this on and no
   * proxy actually in front, anybody can put a fresh value in it on every request and give
   * themselves an unlimited number of rate-limit buckets. It is only safe when a proxy that
   * OVERWRITES or APPENDS the real address is guaranteed to be in front of this process.
   */
  readonly trustProxyHeader: boolean;
  /**
   * How many distinct clients the in-memory rate limiter will track at once.
   *
   * A map keyed by a client-controlled value with no bound is a memory exhaustion bug wearing a
   * rate limiter's clothes.
   */
  readonly maxTrackedClients: number;
}

const limitsSchema = z.object({
  DEMO_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(10_000).default(10),
  DEMO_MAX_AGENT_CALLS_PER_DAY: z.coerce.number().int().nonnegative().max(1_000_000).default(500),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  DEMO_TRUST_PROXY_HEADER: z.enum(['true', 'false']).default('false'),
  DEMO_MAX_TRACKED_CLIENTS: z.coerce.number().int().positive().max(1_000_000).default(10_000),
});

export class LimitsError extends Error {
  override readonly name = 'LimitsError';
}

/**
 * What to say at boot when no browser origin is allowed, or null when one is.
 *
 * WRITTEN AFTER THE FIRST TIME ANYONE LOADED THIS CONSOLE IN A BROWSER. An empty allowlist is a
 * legitimate configuration - it is the right one for a deployment with no browser client - so it
 * cannot be an error. But it is also what an operator gets by following this repository's own
 * README, because `.env.example` does not mention `CORS_ALLOWED_ORIGINS` at all. The result,
 * measured rather than imagined: every page loads, the console reports "The API could not be
 * reached from this browser", and the only sign of the cause is the word `none` at the end of a
 * boot line. A reader concludes the demo is broken.
 *
 * The API is doing exactly what it was told. This is the difference between doing that silently and
 * saying so, which is the same argument the product makes about an empty search result.
 *
 * BOTH LOOPBACK SPELLINGS ARE NAMED because they are different origins to a browser and only one of
 * them is what `npm run dev:web` serves. `astro dev --host 127.0.0.1` means the page is at
 * `http://127.0.0.1:4321`, so an allowlist holding only `http://localhost:4321` never matches. That
 * exact mistake was sitting in this project's own notes, and it was found by trying it.
 *
 * A PURE FUNCTION rather than a `console.log` inside `main.ts`, because `main.ts` calls `main()` at
 * the top level and no test can import it without starting a server. A warning nothing can test is
 * a warning nobody has watched appear.
 */
export function originPolicyWarning(limits: DemoLimits): string | null {
  if (limits.allowedOrigins.length > 0) return null;
  return (
    'CORS_ALLOWED_ORIGINS is empty, so no browser on another origin may call this API and the ' +
    'console will report that it could not be reached. That is correct for a deployment with no ' +
    'browser client. To run the console locally, set ' +
    'CORS_ALLOWED_ORIGINS=http://127.0.0.1:4321,http://localhost:4321 - both spellings, because a ' +
    'browser treats them as different origins and `npm run dev:web` serves the first one.'
  );
}

/**
 * Split, trim and check the allowlist.
 *
 * A wildcard is REFUSED rather than honoured. An allow-origin header naming every site is the
 * reflected origin this design rules out, written the short way, and an operator who sets it has
 * almost certainly not decided to let the whole internet drive this API.
 */
export function parseOrigins(raw: string): readonly string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (entry === '*') {
      throw new LimitsError(
        'CORS_ALLOWED_ORIGINS contains "*". This API takes an explicit list of origins and never a ' +
          'wildcard: a wildcard is the reflected origin the design refuses, spelled differently. ' +
          'Name the origins that may call it.',
      );
    }
    if (!ORIGIN.test(entry)) {
      throw new LimitsError(
        `CORS_ALLOWED_ORIGINS contains "${entry}", which is not an origin a browser can send. An ` +
          'origin is scheme://host with an optional port, and nothing else: no trailing slash, no ' +
          'path. An entry a browser cannot match would silently never work.',
      );
    }
  }

  return entries;
}

export function loadDemoLimits(env: Record<string, string | undefined>): DemoLimits {
  const parsed = limitsSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new LimitsError(`the demo limits are not usable: ${detail}`);
  }

  return {
    ratePerMinute: parsed.data.DEMO_RATE_LIMIT_PER_MINUTE,
    maxAgentCallsPerDay: parsed.data.DEMO_MAX_AGENT_CALLS_PER_DAY,
    allowedOrigins: parseOrigins(parsed.data.CORS_ALLOWED_ORIGINS),
    trustProxyHeader: parsed.data.DEMO_TRUST_PROXY_HEADER === 'true',
    maxTrackedClients: parsed.data.DEMO_MAX_TRACKED_CLIENTS,
  };
}
