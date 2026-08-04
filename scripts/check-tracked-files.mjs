/**
 * Fails the build when a file that should never be tracked is tracked.
 *
 * No shebang, deliberately. This runs as `node scripts/check-tracked-files.mjs` and is never
 * executed directly, and a shebang on a file checked out with CRLF makes a vitest import of it die
 * with "SyntaxError: Invalid or unexpected token" on Windows while passing on Linux. That already
 * cost this repository one commit whose own tests could not run on the platform they were written
 * on. `.gitattributes` pins LF for fresh checkouts; this removes the trigger as well as the cause.
 *
 * This repo is going public, and untracking is index-only: anything committed once stays readable
 * in history forever. Prose in a checklist cannot fail a build, so this exists to make the rule
 * mechanical.
 *
 * WHAT THIS IS NOT: it checks tracked PATHS against a fixed list, plus ONE content rule described
 * below. It reads no other file's content and it does not guess. A green result means "no path on
 * the list is tracked, and no tracked .npmrc carries one of the NAMED auth keys or a credential
 * embedded in a URL". That is narrower than "no tracked .npmrc carries a credential", which is
 * itself narrower than "this repo leaks nothing", and the distance between those three is exactly
 * where the last miss lived. Said plainly so nobody reads the green as broader than it is.
 *
 * THE ONE CONTENT RULE. `.npmrc` is deliberately tracked, because the supply chain cooldown has to
 * travel with the repository rather than live on one laptop. That makes it the one file here whose
 * whole purpose is to hold npm configuration and whose format also accepts registry credentials.
 * A path rule cannot tell those apart, so every tracked `.npmrc` at any depth is read and an auth
 * line fails the build. The cost of missing one is not a bad build: it is a token committed to a
 * repository that becomes public, where removing it from the index changes nothing about history.
 *
 * Matching is at ANY DEPTH, deliberately. A root-anchored version of this script passed a tracked
 * `apps/api/.env` and a tracked `packages/memory/.claude/settings.json` while reporting clean, so
 * the only mechanical gate was strictly narrower than the .gitignore beside it. Depth is exactly
 * where a real leak turns up, because nobody puts the second copy at the root.
 *
 * Exit codes: 0 clean, 1 a forbidden path is tracked, 2 the scan could not run. A scan that could
 * not run is never reported as clean.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Directory names that must never appear as a path segment, at any depth. */
const FORBIDDEN_DIRECTORY_SEGMENTS = [
  '.claude',
  '.codex',
  '.agents',
  '.planning',
  '.crash-buffers',
];

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

function isForbidden(trackedPath) {
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
 * List every tracked path, repo-relative.
 *
 * `--full-name` plus running from the repository root, because `git ls-files` is otherwise
 * relative to the current directory: run from a subdirectory it lists only that subtree, and the
 * resulting non-empty list sails past the empty-index guard below while checking almost nothing.
 */
function listTrackedFiles() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (!root) throw new Error('git rev-parse --show-toplevel returned nothing');
  const output = execFileSync('git', ['ls-files', '--full-name', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Auth-bearing npm config keys, as they appear in an .npmrc.
 *
 * Two families, because npm has two and only one of them starts with an underscore.
 *
 * The underscore family is the familiar one, matched with an optional registry-scope prefix
 * because the real shape of a leak is `//registry.npmjs.org/:_authToken=...` rather than a bare key.
 *
 * `key` and `cert` have no underscore and are the ones that got missed. npm's `key` holds an
 * INLINE PEM private key, not a path: a tracked `.npmrc` carrying one passed this gate and exited
 * 0, proven end to end. The near-miss is instructive. An earlier comment here excluded `certfile`
 * and `keyfile` as "a path, not a secret", which is correct for those two and lands exactly one
 * character away from the inline siblings that ARE the secret. `keyfile` and `certfile` stay
 * excluded; `key` and `cert` do not.
 */
const NPMRC_CREDENTIAL = new RegExp(
  '^\\s*(?:[#;]\\s*)?(?:' +
    // //host/:_authToken=, or a bare _auth=
    '(?:\\/\\/[^\\s=]*:)?_(?:auth|authtoken|auth_token|password|secret)' +
    '|' +
    // key= and cert= carry the PEM itself. Anchored so keyfile and certfile do not match.
    '(?:\\/\\/[^\\s=]*:)?(?:key|cert)' +
    ')\\s*=',
  'i',
);

/**
 * A credential embedded in a registry URL, which is the shape carrying no `_` key at all.
 *
 * `registry=https://user:token@host/` is perfectly ordinary npm configuration and a perfectly
 * ordinary leak. A colon-separated pair before the `@` is required so an everyday
 * `https://host/path` value does not trip it.
 */
const URL_CREDENTIAL = /^\s*(?:[#;]\s*)?[\w@/:.-]*=\s*\w+:\/\/[^\s:@/]+:[^\s@/]+@/i;

/**
 * Every tracked `.npmrc`, at any depth, read for something that should never have been committed.
 *
 * THREE decisions, each from a specific miss found by review:
 *
 * Depth, not the root only. This script's own header says depth is where a real leak turns up,
 * because nobody puts the second copy at the top. A tracked `apps/api/.npmrc` used to pass.
 *
 * Comment lines are scanned too. A commented-out token is still a committed token: the `#` stops
 * npm reading it and stops nothing else. Whoever reads the public repository does not care that
 * the credential was disabled.
 *
 * TRACKED files, not files on disk. A developer's untracked local `.npmrc` full of tokens is
 * exactly what should exist and is none of this gate's business.
 */
function npmrcCredentialHits(root, tracked) {
  const hits = [];
  for (const relative of tracked) {
    if (path.basename(relative) !== '.npmrc') continue;
    const file = path.join(root, relative);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (NPMRC_CREDENTIAL.test(line) || URL_CREDENTIAL.test(line)) {
        hits.push(`${relative}:${index + 1}`);
      }
    }
  }
  return hits;
}

function main() {
  let tracked;
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    tracked = listTrackedFiles();
  } catch (error) {
    console.error(`[tracked-files] UNKNOWN: could not enumerate tracked files: ${error.message}`);
    console.error('[tracked-files] Refusing to report clean on a scan that did not run.');
    process.exit(2);
  }

  if (tracked.length === 0) {
    console.error('[tracked-files] UNKNOWN: the index is empty, so nothing was checked.');
    console.error('[tracked-files] Refusing to report clean on a scan that did not run.');
    process.exit(2);
  }

  const violations = tracked.filter(isForbidden);
  if (violations.length > 0) {
    console.error(`[tracked-files] ${violations.length} forbidden path(s) are tracked:`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error('');
    console.error('Remove them from the index with `git rm -r --cached <path>` (this keeps them on');
    console.error('disk), and confirm they are covered by .gitignore so they cannot return.');
    console.error('If any of them was ever COMMITTED, the index is not enough: it stays readable');
    console.error('in history, and going public needs that history dealt with first.');
    process.exit(1);
  }

  const credentialHits = npmrcCredentialHits(root, tracked);
  if (credentialHits.length > 0) {
    console.error(`[tracked-files] ${credentialHits.length} auth line(s) in a tracked .npmrc:`);
    // Path and line number only. The value is never printed: the point is to fail the build, not to
    // reproduce the secret in a log that is itself readable.
    for (const hit of credentialHits) console.error(`  ${hit}`);
    console.error('');
    console.error('Those files are tracked and this repository becomes public. Move the credential');
    console.error('to ~/.npmrc or an environment variable. Commenting it out is not enough, because');
    console.error('the value stays readable. If it was ever COMMITTED, removing it from the index');
    console.error('changes nothing, so rotate the token: history keeps it.');
    process.exit(1);
  }

  const npmrcCount = tracked.filter((entry) => path.basename(entry) === '.npmrc').length;
  console.log(
    `[tracked-files] clean (${tracked.length} tracked paths checked against the list, ` +
      `${npmrcCount} tracked .npmrc read for auth lines)`,
  );
  process.exit(0);
}

main();
