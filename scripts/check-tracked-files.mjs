#!/usr/bin/env node
/**
 * Fails the build when a file that should never be tracked is tracked.
 *
 * This repo is going public, and untracking is index-only: anything committed once stays readable
 * in history forever. Prose in a checklist cannot fail a build, so this exists to make the rule
 * mechanical.
 *
 * WHAT THIS IS NOT: it checks tracked PATHS against a fixed list, plus ONE content rule described
 * below. It does not otherwise read file content and it does not guess. A green result means "no
 * path on the list is tracked and .npmrc carries no credential", which is narrower than "this repo
 * leaks nothing". Said plainly here so nobody reads the green as broader than it is.
 *
 * THE ONE CONTENT RULE. `.npmrc` is deliberately tracked, because the supply chain cooldown has to
 * travel with the repository rather than live on one laptop. That makes it the one file here whose
 * whole purpose is to hold npm configuration and whose format also accepts registry credentials.
 * A path rule cannot tell those apart, so this reads that single file and fails on an auth line.
 * The cost of missing it is not a bad build: it is a token committed to a repository that becomes
 * public, where removing it from the index changes nothing about history.
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
 * Matched with an optional registry-scope prefix, because the real shape of a leak is
 * `//registry.npmjs.org/:_authToken=...` rather than a bare key. Case-insensitive, and the value
 * is never printed: the point is to fail, not to reproduce the secret in a build log.
 */
const NPMRC_CREDENTIAL = /^\s*(?:\/\/[^\s=]*:)?_(?:auth|authtoken|password|auth_token)\s*=/i;

function npmrcCredentialLines(root) {
  const file = path.join(root, '.npmrc');
  if (!existsSync(file)) return [];
  const found = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith('#') || line.trimStart().startsWith(';')) continue;
    if (NPMRC_CREDENTIAL.test(line)) found.push(index + 1);
  }
  return found;
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

  const credentialLines = npmrcCredentialLines(root);
  if (credentialLines.length > 0) {
    console.error(
      `[tracked-files] .npmrc carries an auth line at line ${credentialLines.join(', ')}. The ` +
        'value is not printed here on purpose.',
    );
    console.error('');
    console.error('That file is tracked and this repository becomes public. Move the credential to');
    console.error('~/.npmrc or an environment variable. If it was ever COMMITTED, removing it from');
    console.error('the index changes nothing: rotate the token, because history keeps it.');
    process.exit(1);
  }

  console.log(
    `[tracked-files] clean (${tracked.length} tracked paths checked against the list, ` +
      'and .npmrc checked for auth lines)',
  );
  process.exit(0);
}

main();
