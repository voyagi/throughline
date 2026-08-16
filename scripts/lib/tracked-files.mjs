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
 * approximation differs from npm is a gap by construction. NINE have been found and closed so far,
 * each after a comment claimed the enumeration was finished: the bare `key` and `password` config
 * names, whitespace around the equals, quoted keys, quoted values, a doubled `##` comment marker,
 * ini `[]` array syntax, an empty username in the URL form, and a scheme containing `+` such as
 * `git+https`. Every one was found by someone checking what npm ACCEPTS rather than what the regex
 * reads nicely as.
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
 * TRADE: the key pattern is `+` rather than `*`, and with `*` the match backtracks quadratically,
 * 37 seconds per 200,000 characters against 0.76 milliseconds bounded. A gate one long line can
 * stall is a gate somebody deletes, so this misses a form nobody writes on purpose instead. Pinned
 * by a test that states why it is open.
 *
 * WHY `+` WORKS, stated exactly, because the plausible-sounding version of this is wrong and the
 * wrong version is dangerous. The key class holds NO whitespace, so the key never competes with
 * anything for a run of spaces. The competing pair is `^\s*` and the `\s*` before the `=`, and a
 * NULLABLE key is what lets them share one run: with `*` the key can match empty at every split
 * point, so the two whitespace runs divide the input in O(n squared) ways, since the second run may
 * also stop short rather than consume the remainder. `+` removes that by making the key unable to
 * match empty, not by bounding anything.
 *
 * READ THAT AGAIN BEFORE CLOSING THE FIRST DIVERGENCE ABOVE. The obvious way to cover a key
 * containing whitespace is to add `\s` to the key class and keep the `+`. That is far worse than
 * the problem this trade avoids: measured at 138 SECONDS for an 8,000 character line, against 37
 * seconds for 200,000. Three whitespace-capable quantifiers in a row is cubic. If that divergence
 * is ever closed, it needs a different shape entirely and a timing measurement to go with it.
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
 * `[\w@/:.-]+` rather than `*`, and this one costs coverage on purpose. A NULLABLE key lets `^\s*`
 * and the `\s*` before the `=` divide one run of spaces in O(n) ways, which backtracks
 * quadratically: 200,000 spaces measured at 37 seconds against 0.76 milliseconds. The `+` fixes it
 * by making the key unable to match empty, not by bounding its length, and the difference between
 * those two explanations is a 138 second trap documented with the divergences above. The price is
 * the empty-key form. A build gate one long line can stall is a build gate somebody deletes.
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

/**
 * Literals that must never appear in ANY tracked file, whatever the file is for.
 *
 * The first entry exists because a secret scanner could not have caught the leak it answers. The
 * owner's real AWS account id was committed in a source comment and three test fixtures, copied
 * out of a live AccessDeniedException, and an account id embedded in an ARN has no credential
 * shape for a scanner to match: the 2026-08-12 ship-safe pass ran gitleaks over the full history
 * and correctly reported no leaked credential while this sat in the tree. An account id is not a
 * secret, but committed to a repository that becomes public it is targeting information, and it is
 * exactly the identifier the runtime controls in `apps/api/src/http/failures.ts` exist to keep out
 * of responses. Fixtures copied from live errors are precisely how it would come back, so the gate
 * holds the value itself and refuses it anywhere.
 *
 * ASSEMBLED FROM HALVES, deliberately, and this is not the evasion the test file's header warns
 * about. Splitting a fixture VALUE to sneak it past a detector defeats a control. Splitting THIS
 * value is the opposite move: the goal is that no tracked line carries the literal, and this
 * rule's own definition is a tracked line. Joined at load, it is matched everywhere and greppable
 * nowhere.
 */
export const FORBIDDEN_LITERALS = [
  {
    name: 'real-aws-account-id',
    value: ['255358', '859614'].join(''),
    replaceWith: 'the reserved documentation account id 123456789012',
  },
];

/**
 * The text of one tracked file, decoded from its bytes.
 *
 * UTF-8 unless a UTF-16 byte-order mark says otherwise. This exists because the first version of
 * the literal sweep read everything as UTF-8 and claimed an ASCII digit string survives that read
 * wherever it appears, which is false in exactly one realistic case: Windows PowerShell 5.1's `>`
 * redirection writes UTF-16LE, where every ASCII digit is interleaved with NUL bytes, so a UTF-8
 * read of such a file never contains the contiguous literal and a fixture made that way would
 * have sailed through. Found by review before it could. Both byte orders are decoded; a BOM-less
 * UTF-16 file still reduces to the UTF-8 read, which is stated as the known remaining gap rather
 * than implied away.
 */
export function trackedFileText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // Node has no big-endian UTF-16 decoder, so swap a COPY into little-endian first.
    return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  }
  return buffer.toString('utf8');
}

/**
 * The 1-based lines in one file that carry a forbidden literal, with the rule name that fired.
 *
 * A plain substring test per line, not a regex: every entry is an exact value, and the miss this
 * rule answers was an exact value sitting in ordinary lines.
 */
export function forbiddenLiteralLinesIn(text) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const rule of FORBIDDEN_LITERALS) {
      if (line.includes(rule.value)) hits.push({ line: index + 1, name: rule.name });
    }
  }
  return hits;
}
