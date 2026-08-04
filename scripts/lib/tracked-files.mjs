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
 * NEITHER RULE BELOW IS A PARSER, and four rewrites of the surrounding prose failed by forgetting
 * it. Read this before changing either one.
 *
 * They are line-shape heuristics that approximate npm's ini syntax, and every place the
 * approximation differs from npm is a gap by construction. SEVEN have been found and closed so far,
 * each after a comment claimed the enumeration was finished: the bare `key` and `password` config
 * names, whitespace around the equals, quoted keys, quoted values, an empty username in the URL
 * form, and a scheme containing `+` such as `git+https`. Every one was found by someone checking
 * what npm ACCEPTS rather than what the regex reads nicely as.
 *
 * So the rule for editing these is: change them only against npm's own parser, and add a fixture in
 * both directions. Do not reason from the regex to what npm does. That is the mistake, every time.
 *
 * KNOWN REMAINING DIFFERENCES FROM NPM. This list is OPEN, and saying so is the point. Every
 * previous version of this comment enumerated the gaps as if the enumeration were finished, and
 * every one of those versions was wrong within a day. Three forms were found after the list itself
 * became the claim. Treat what follows as the gaps somebody has looked for, not the gaps there are.
 *
 * THE KEY CHARACTER CLASS, which is a family rather than an item. The key side matches
 * `[\w@/:.-]`, and npm's ini accepts a key containing anything else: whitespace (`my key = ...`),
 * and every one of `% + ~ ! , * $ & ( ) ' \ [ ] { } ^ | < > ? "` and tab. All resolve in npm and
 * none is matched here. Widening the class is not obviously right, because the key side is also
 * what keeps the rule from firing on ordinary prose, so this is left open rather than guessed at.
 *
 * AN EMPTY KEY. ` = https://user:token@host/` parses to the key `""` and resolves. A DELIBERATE
 * TRADE: the key pattern is `+` rather than `*`, and with `*` the leading `\s*` and the key both
 * compete for a run of spaces, backtracking quadratically at 37 seconds per 200,000 characters
 * against 0.76 milliseconds bounded. A gate one long line can stall is a gate somebody deletes, so
 * this misses a form nobody writes on purpose instead. Said out loud rather than left as an
 * accident, and pinned by a test that states why it is open.
 *
 * A value split across lines is NOT a divergence, and the reason previously given for that was
 * wrong. npm's ini has no line continuation, so `registry=https://u:p\` and `@host/` are two keys
 * and npm does not reconstitute the URL either. The first line is NOT caught by this rule, which
 * is fine: there is no credential for npm to resolve.
 *
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
  // Comment markers repeat in the wild (`## key=`), and npm's ini accepts a quoted key.
  '^\\s*(?:[#;]+\\s*)?["\']?(?:' +
    '(?:\\/\\/[^\\s=]*:)?_(?:auth|authtoken|auth_token|password|secret)' +
    '|' +
    '(?:\\/\\/[^\\s=]*:)?(?:key|cert|password)' +
    ')(?:\\[\\])?["\']?\\s*=',
  'i',
);

/**
 * A credential embedded in a registry URL, which is the shape carrying no secret key name at all.
 *
 * `registry=https://user:token@host/` is perfectly ordinary npm configuration and a perfectly
 * ordinary leak. What discriminates is the VALUE: a colon-separated pair before an `@`, required so
 * that an everyday `https://host/path` does not trip it. The key on the left is not inspected
 * beyond its character class, because any key can hold a URL.
 *
 * Every piece of the key side exists because npm's ini parser accepts a form this rule once missed,
 * and each was a real hole rather than a hypothetical:
 *
 * `\s*` before the `=`, because `registry = https://user:token@host/` resolves normally and both
 * rules used to miss it while `NPMRC_CREDENTIAL` accepted spacing from its first version.
 *
 * `["']?` around the key and before the value, because `npm config list` PRINTS the spaced and
 * quoted form. Pasting npm's own output produced exactly the shape the gate could not see.
 *
 * `[#;]+` because comment markers double up in the wild. Note what that is NOT: npm's ini skips any
 * line starting `#` or `;`, so `## registry = ...` is a comment to npm exactly as `#` is, and it
 * configures nothing. Comment lines are scanned anyway, and for a different reason entirely: a
 * commented-out token is still a committed token, and the `#` stops npm rather than stopping
 * whoever reads the repository.
 *
 * `(?:\[\])?` for ini array syntax, which npm does resolve.
 *
 * On the value side, `[\w+.-]+` for the scheme rather than `\w+`, because `git+https://` and
 * `git+ssh://` are ordinary npm registry values and the `+` made both invisible. And `[^\s:@/]*`
 * for the username rather than `+`, because `https://:TOKEN@host/` with an EMPTY username is the
 * canonical way to put a bare token in a registry URL, and requiring one character missed exactly
 * the most likely real leak in the file. npm's own redactor classifies all three as credentials.
 *
 * `[\w@/:.-]+` rather than `*`, and this one costs coverage on purpose. With `*` the leading `\s*`
 * and the key can both consume a run of spaces, which backtracks quadratically: 200,000 spaces
 * measured at 37 seconds against 0.76 milliseconds bounded. The price is the empty-key form, listed
 * with the other known divergences above. A build gate that one long line can stall is a build gate
 * somebody eventually deletes, so the trade goes this way, deliberately and in writing.
 */
export const URL_CREDENTIAL =
  /^\s*(?:[#;]+\s*)?["']?[\w@/:.-]+(?:\[\])?["']?\s*=\s*["']?[\w+.-]+:\/\/[^\s:@/]*:[^\s@/]+@/i;

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
