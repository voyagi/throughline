/**
 * A token bucket per client, in memory.
 *
 * IN MEMORY IS A REAL LIMIT AND IT IS STATED RATHER THAN HIDDEN. This survives nothing: not a
 * restart, not a second Lambda execution environment, not a second container. It is the fast guard
 * against one impatient visitor, and it is NOT what protects the budget. The thing that protects
 * the budget is the daily ceiling in `demo-budget.ts`, which is counted in the database precisely
 * because this one cannot be.
 *
 * Two failure modes were designed against rather than discovered.
 *
 * A map keyed by client address grows without bound, and the key is chosen by whoever is calling.
 * So entries are swept, and above a hard cap a client this limiter has never seen is refused
 * rather than admitted. That direction is deliberate: under a flood from many addresses the demo
 * gets stricter, never looser, and the alternative is the process running out of memory, which is
 * a worse outage than a 429.
 *
 * A clock that goes backwards would otherwise hand out negative elapsed time and REMOVE tokens
 * from a bucket that was owed some. Elapsed time is floored at zero.
 */

/**
 * Which address to rate limit against.
 *
 * THE LAST entry of `X-Forwarded-For`, never the first, and that is the whole security content of
 * this function. The header is a comma separated chain that each hop APPENDS to, so the leftmost
 * entry is whatever the original client sent, which a client can set to anything it likes. Trusting
 * the leftmost gives every visitor an unlimited supply of rate limit buckets, one per request. The
 * rightmost is the value the nearest proxy appended, which is the only entry the client could not
 * have written.
 *
 * And it is consulted ONLY when an operator has said a proxy is really in front. With no proxy the
 * header is pure client input, so honouring it would be the same bypass with extra steps.
 *
 * Returns null when there is nothing usable, and the caller decides what a null means. It does not
 * invent a key here: a fabricated one would silently turn the limiter off.
 */
export function clientAddressFrom(
  forwardedFor: string | null,
  socketAddress: string | null,
  trustProxyHeader: boolean,
): string | null {
  if (trustProxyHeader && forwardedFor !== null) {
    const hops = forwardedFor
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const nearest = hops[hops.length - 1];
    if (nearest !== undefined) return nearest;
  }
  return socketAddress;
}

export interface RateLimiterOptions {
  /** Tokens available per window per client, from `DEMO_RATE_LIMIT_PER_MINUTE`. */
  readonly capacity: number;
  /** How long a full bucket takes to refill from empty. One minute for the value above. */
  readonly windowMs: number;
  /** Injected so a test can assert the refill curve rather than sleep through it. */
  readonly now: () => number;
  readonly maxTrackedClients: number;
}

export interface RateDecision {
  readonly allowed: boolean;
  /** Whole tokens left after this call. Zero when refused. */
  readonly remaining: number;
  /** What to put in `Retry-After`. At least 1, because a browser reads 0 as "immediately". */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  take(key: string): RateDecision;
  /** How many clients are currently tracked. Exported for the test that proves the bound holds. */
  readonly trackedClients: number;
}

interface Bucket {
  tokens: number;
  lastSeenMs: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { capacity, windowMs, now, maxTrackedClients } = options;
  if (capacity <= 0 || windowMs <= 0 || maxTrackedClients <= 0) {
    throw new Error(
      'a rate limiter needs a positive capacity, window and client bound. A zero here would ' +
        'divide by zero when computing Retry-After and report Infinity seconds.',
    );
  }

  const tokensPerMs = capacity / windowMs;
  const buckets = new Map<string, Bucket>();

  /**
   * Drop buckets that have had long enough to refill completely.
   *
   * A full bucket is indistinguishable from one that was never created, so forgetting it loses no
   * information and cannot advantage the client it belonged to. Evicting by IDLE TIME rather than
   * by any judgement about the client matters: an eviction rule that preferred "clients with few
   * requests" would evict every brand new bucket first, which is the one thing a rate limiter must
   * not do, because a brand new bucket is exactly what an attacker keeps creating.
   */
  function sweep(at: number): void {
    for (const [key, bucket] of buckets) {
      if (at - bucket.lastSeenMs >= windowMs) buckets.delete(key);
    }
  }

  return {
    take(key: string): RateDecision {
      const at = now();
      if (buckets.size >= maxTrackedClients) sweep(at);

      const existing = buckets.get(key);
      if (!existing && buckets.size >= maxTrackedClients) {
        // Every tracked bucket is still active and the table is full. Refusing an unknown client
        // is the fail-closed direction; admitting it would mean an unbounded map.
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(windowMs / 1000) };
      }

      const bucket = existing ?? { tokens: capacity, lastSeenMs: at };
      const elapsedMs = Math.max(0, at - bucket.lastSeenMs);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedMs * tokensPerMs);
      bucket.lastSeenMs = at;
      buckets.set(key, bucket);

      if (bucket.tokens < 1) {
        const msUntilOneToken = (1 - bucket.tokens) / tokensPerMs;
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil(msUntilOneToken / 1000)),
        };
      }

      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    },

    get trackedClients(): number {
      return buckets.size;
    },
  };
}
