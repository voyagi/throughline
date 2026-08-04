/**
 * The tracked-file gate's decisions, as pure functions with no filesystem and no exit codes.
 *
 * Split out for a reason that this branch has now paid for twice. The `.npmrc` credential rule has
 * missed a real secret key in two consecutive reviews, `key=` and then `password=`, and both times
 * the reason it survived was the same: nothing tested it. The rule lived inside a script that calls
 * `main()` at import, so no test could reach it without running the gate. A security predicate
 * pinned by nothing is a predicate that drifts, and this one drifted twice in an afternoon.
 *
 * The runner keeps the filesystem and the process. Everything a test needs to hold still is here.
 */

/** Directory names that must never appear as a path segment, at any depth. */
const FORBIDDEN_DIRECTORY_SEGMENTS = ['.claude', '.codex', '.agents', '.planning', '.crash-buffers'];

/** Exact file names that must never be tracked, at any depth. */
const FORBIDDEN_FILE_NAMES = [
  'claude.md',
  'agents.md',
  'human-todo.md',
  'verification.md',
  '.build-lane',
];

/** Path prefixes that must never be tracked. Anchored, because these name one specific place. */
const FORBIDDEN_PATH_PREFIXES = ['design/_scratch/'];

/**
 * Environment files, in both shapes: `.env`, `.env.production`, and `prod.env`.
 *
 * The third shape was missed until `git check-ignore secrets/prod.env` was actually run and came
 * back NOT ignored. A pattern anchored on a leading `.env` looks exhaustive and is not, and the
 * gate having the same blind spot as the .gitignore meant neither layer would have caught it.
 *
 * `.env.example` SHOULD be tracked, so it is carved out by name rather than by hoping the pattern
 * happens to miss it.
 */
const ENV_FILE = /^(\.env(\..+)?|.+\.env)$/;
const ALLOWED_ENV_FILES = new Set(['.env.example', '.env.sample', '.env.template']);

export function isForbidden(trackedPath) {
  const candidate = trackedPath.toLowerCase();
  const segments = candidate.split('/');
  const basename = segments[segments.length - 1] ?? '';

  if (FORBIDDEN_PATH_PREFIXES.some((prefix) => candidate.startsWith(prefix))) return true;
  if (segments.slice(0, -1).some((segment) => FORBIDDEN_DIRECTORY_SEGMENTS.includes(segment))) {
    return true;
  }
  if (FORBIDDEN_FILE_NAMES.includes(basename)) return true;
  if (ENV_FILE.test(basename) && !ALLOWED_ENV_FILES.has(basename)) return true;

  return false;
}

/**
 * npm config keys that hold a secret, as they appear in an .npmrc.
 *
 * TWO FAMILIES, and the second one is NOT a closed set. Say that plainly, because the comment that
 * used to sit here implied it was, and the enumeration has been wrong twice.
 *
 * The underscore family is the familiar one, matched with an optional registry-scope prefix because
 * the real shape of a leak is `//registry.npmjs.org/:_authToken=...` rather than a bare key.
 *
 * The bare family is where the misses live, because nothing about the name warns you. `key` holds
 * an INLINE PEM private key rather than a path to one. `password` holds a plaintext password;
 * `_password` was caught and `password` was not. Both were found by review, one round apart, each
 * after a comment here claimed the list was complete.
 *
 * `keyfile` and `certfile` are deliberately NOT matched: those name a path. That distinction is
 * right and it is also exactly how `key` got missed, so the boundary is drawn with an anchor rather
 * than with a prefix, and every change here gets a test in both directions.
 */
export const NPMRC_CREDENTIAL = new RegExp(
  '^\\s*(?:[#;]\\s*)?(?:' +
    '(?:\\/\\/[^\\s=]*:)?_(?:auth|authtoken|auth_token|password|secret)' +
    '|' +
    '(?:\\/\\/[^\\s=]*:)?(?:key|cert|password)' +
    ')\\s*=',
  'i',
);

/**
 * A credential embedded in a registry URL, which is the shape carrying no key name at all.
 *
 * `registry=https://user:token@host/` is perfectly ordinary npm configuration and a perfectly
 * ordinary leak. A colon-separated pair before the `@` is required so an everyday
 * `https://host/path` value does not trip it.
 */
export const URL_CREDENTIAL = /^\s*(?:[#;]\s*)?[\w@/:.-]*=\s*\w+:\/\/[^\s:@/]+:[^\s@/]+@/i;

/**
 * The 1-based line numbers in one `.npmrc` that carry a credential.
 *
 * Comment lines are scanned deliberately. A commented-out token is still a committed token: the `#`
 * stops npm reading it and stops nothing else. Whoever reads the public repository does not care
 * that the credential was disabled.
 */
export function credentialLinesIn(text) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (NPMRC_CREDENTIAL.test(line) || URL_CREDENTIAL.test(line)) hits.push(index + 1);
  }
  return hits;
}
