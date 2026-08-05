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
 * The DECISIONS live in `lib/tracked-files.mjs` and are tested there. This file owns the
 * filesystem, the git calls and the exit codes, and nothing a test needs to hold still.
 *
 * WHAT THIS IS NOT: it checks tracked PATHS against a fixed list, plus ONE content rule described
 * below. It reads no other file's content and it does not guess. A green result means "no path on
 * the list is tracked, and no tracked .npmrc carries one of the NAMED secret keys or a credential
 * embedded in a URL". That is narrower than "no tracked .npmrc carries a credential", which is
 * itself narrower than "this repo leaks nothing". The distance between those three is exactly where
 * the last two misses lived, so it is spelled out rather than implied.
 *
 * THE ONE CONTENT RULE. `.npmrc` is deliberately tracked, because the supply chain cooldown has to
 * travel with the repository rather than live on one laptop. That makes it the one file here whose
 * whole purpose is to hold npm configuration and whose format also accepts registry credentials.
 * A path rule cannot tell those apart, so every tracked `.npmrc` at any depth is read and a secret
 * line fails the build. The cost of missing one is not a bad build: it is a token committed to a
 * repository that becomes public, where removing it from the index changes nothing about history.
 *
 * Matching is at ANY DEPTH, deliberately. A root-anchored version of this script passed a tracked
 * `apps/api/.env` and a tracked `packages/memory/.claude/settings.json` while reporting clean, so
 * the only mechanical gate was strictly narrower than the .gitignore beside it. Depth is exactly
 * where a real leak turns up, because nobody puts the second copy at the root.
 *
 * Exit codes: 0 clean, 1 a forbidden path is tracked or a credential is in a tracked .npmrc,
 * 2 the scan could not run. A scan that could not run is never reported as clean.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { credentialLinesIn, isForbidden } from './lib/tracked-files.mjs';

/**
 * List every tracked path, repo-relative.
 *
 * `--full-name` plus running from the repository root, because `git ls-files` is otherwise
 * relative to the current directory: run from a subdirectory it lists only that subtree, and the
 * resulting non-empty list sails past the empty-index guard below while checking almost nothing.
 */
function listTrackedFiles(root) {
  const output = execFileSync('git', ['ls-files', '--full-name', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Every tracked `.npmrc`, at any depth, read for something that should never have been committed.
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
    for (const line of credentialLinesIn(readFileSync(file, 'utf8'))) {
      hits.push(`${relative}:${line}`);
    }
  }
  return hits;
}

function main() {
  let tracked;
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    if (!root) throw new Error('git rev-parse --show-toplevel returned nothing');
    tracked = listTrackedFiles(root);
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
    console.error(`[tracked-files] ${credentialHits.length} secret line(s) in a tracked .npmrc:`);
    // Path and line number only. The value is never printed: the point is to fail the build, not to
    // reproduce the secret in a log that is itself readable.
    for (const hit of credentialHits) console.error(`  ${hit}`);
    console.error('');
    console.error('Those files are tracked and this repository becomes public. Move the credential');
    console.error('to ~/.npmrc or an environment variable. Commenting it out is not enough, because');
    console.error('the value stays readable. If it was ever COMMITTED, removing it from the index');
    console.error('changes nothing, so rotate the secret: history keeps it.');
    process.exit(1);
  }

  const npmrcCount = tracked.filter((entry) => path.basename(entry) === '.npmrc').length;
  console.log(
    `[tracked-files] clean (${tracked.length} tracked paths checked against the list, ` +
      `${npmrcCount} tracked .npmrc read for secret lines)`,
  );
  process.exit(0);
}

main();
