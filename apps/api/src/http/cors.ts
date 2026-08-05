/**
 * CORS, written here rather than taken from `hono/cors`.
 *
 * THIS IS A SECURITY DECISION AND NOT A PREFERENCE. `hono/cors` carries GHSA-8j4g-w8fx-2239, a
 * moderate ReDoS reachable through the `Access-Control-Request-Headers` request header, fixed in
 * hono 4.12.34. That version was published 2026-08-03 and this repository sets `min-release-age=3`
 * in `.npmrc`, whose own comment says the cooldown "is never bypassed to clear an advisory faster".
 * So the dependency stays where it is and the vulnerable middleware is never mounted.
 *
 * That is a stronger position than the upgrade would have been, and it survives the upgrade: an
 * allowlist of exact strings has no regular expression in it at all, so there is no pathological
 * input to find. `scripts/check-tracked-files.mjs` learned the same lesson the expensive way, and
 * `docs/gates.md` records the 37-second and 138-second measurements behind it.
 *
 * A dependency-cruiser rule named `no-hono-cors-middleware` fails the build if anything imports the
 * middleware, so this decision is enforced rather than remembered.
 *
 * The other half of the design note: the allowed origin is MATCHED, never REFLECTED. Echoing back
 * whatever arrived in `Origin` is the same as having no policy, and it is worse than a wildcard
 * because it also works with credentials.
 */

/** What a preflight may ask for. FIXED, and deliberately not derived from the request. */
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/**
 * Echoing `Access-Control-Request-Headers` back is the exact input path of the advisory above, and
 * it is also how an allowlist quietly becomes "yes to everything". A fixed list is what this API
 * actually reads.
 */
const ALLOWED_HEADERS = 'content-type';

/** Ten minutes. Long enough to matter, short enough that a policy change is not stuck in caches. */
const MAX_AGE_SECONDS = '600';

export interface CorsDecision {
  /** Headers to attach to the response. Never empty: `Vary` is always present. */
  readonly headers: Readonly<Record<string, string>>;
  /** Whether the request's origin is on the allowlist. False for a same-origin request too. */
  readonly allowed: boolean;
}

/**
 * Decide the CORS headers for one request.
 *
 * `Vary: Origin` is set whether or not the origin is allowed, and that is not belt and braces. A
 * shared cache that stored the allowed response without it would hand those headers to a different
 * origin, and one that stored the refusal would deny an origin that is on the list. The header
 * describes what the response DEPENDS ON, so it is true in both directions and must be sent in
 * both.
 *
 * @param origin the request's `Origin` header, or null when it sent none (same-origin, or curl).
 * @param allowed exact-match set. Membership is an O(1) string lookup with no pattern matching.
 */
export function decideCors(origin: string | null, allowed: ReadonlySet<string>): CorsDecision {
  const vary = { Vary: 'Origin' };
  if (origin === null || !allowed.has(origin)) {
    return { headers: vary, allowed: false };
  }

  return {
    headers: {
      ...vary,
      // The MATCHED value from our own list, which happens to equal the request's. Writing it this
      // way rather than passing `origin` through is the difference between an allowlist and a
      // reflector, and it is one refactor away from being wrong.
      'Access-Control-Allow-Origin': origin,
    },
    allowed: true,
  };
}

/** The extra headers a preflight response carries, on top of `decideCors`. */
export function preflightHeaders(): Readonly<Record<string, string>> {
  return {
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': MAX_AGE_SECONDS,
  };
}
