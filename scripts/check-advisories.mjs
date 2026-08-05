/**
 * Fails the build on a dependency advisory nobody has looked at, and on an acceptance nobody has
 * looked at lately.
 *
 * WHY THIS EXISTS. Six mechanical gates ran on this repository and not one of them looked at a
 * dependency advisory: `verify:ship` covers types, tests, lint, complexity, duplication,
 * architecture boundaries and tracked paths. The only thing tracking an open HIGH was a dated line
 * in `docs/security-notes.md`, and prose cannot fail a build.
 *
 * WHAT IT DOES. Reads `npm audit --json`, compares the findings against a committed list of
 * accepted ones, and fails when any of these is true:
 *
 *   - a finding at or above the fail threshold is not on the accepted list,
 *   - an acceptance is past its recheck date, which is how a dated decision resurfaces by itself,
 *   - an acceptance is dated further out than the horizon, which is a suppression in disguise,
 *   - an acceptance matches nothing, so it is now a note about the past that reads like a live
 *     risk assessment,
 *   - an acceptance names a severity the advisory no longer has.
 *
 * The decision itself lives in `lib/advisories.mjs` so that importing it for a test cannot run the
 * gate. This file therefore calls `main()` unconditionally: the usual
 * `process.argv[1] === fileURLToPath(import.meta.url)` guard is false through a symlink or a
 * Windows junction, and the gate then does nothing, prints nothing and exits 0.
 *
 * A NOTE ON THE COOLDOWN. `.npmrc` sets `min-release-age`, so a fix published minutes ago is not
 * installable here yet. When this gate demands a fix the cooldown will not install, the answer is
 * an acceptance with a short recheck date, never a bypass.
 *
 * Exit codes: 0 clean, 1 something needs a human, 2 the check could not run. A check that could not
 * run is never reported as clean.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decide, FAIL_AT_OR_ABOVE, loadAccepted, summariseAudit } from './lib/advisories.mjs';

/**
 * Run `npm audit --json`.
 *
 * It exits non-zero whenever it finds anything at all, which is not a failure of the command, so
 * the JSON on stdout is read either way. A run that produces no parseable JSON is UNKNOWN, and
 * UNKNOWN is not clean. npm's own error summary is carried into the message rather than dropped,
 * because "could not run" is not a diagnosis and the reason is already in hand.
 */
function runAudit(cwd) {
  try {
    return execFileSync('npm', ['audit', '--json'], {
      cwd,
      encoding: 'utf8',
      shell: true,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    // A report and a failure BOTH arrive as JSON on stdout, and telling them apart matters for the
    // message a human reads. A failed audit emits `{"error":{...}}` with no `vulnerabilities`, and
    // returning that as a report meant the version assertion fired and advised somebody to go read
    // npm's new report format when the registry was simply unreachable. The complaint text below
    // was written for exactly this case and had become unreachable for it.
    if (stdout.trim().startsWith('{') && !isNpmErrorPayload(stdout)) return stdout;
    throw new Error(
      `npm audit could not run: ${npmComplaint(error)}. Offline, or no lockfile? This gate needs ` +
        'the registry and refuses to report clean without it.',
    );
  }
}

/**
 * True when the JSON on stdout is npm reporting a failure rather than an audit report.
 *
 * An `error` member is enough on its own. The first version also required `vulnerabilities` to be
 * absent, which reads as more careful and is the opposite: a payload carrying BOTH would have been
 * treated as a clean report with an error stapled to it. npm's audit command cannot emit that shape
 * today, but its display layer merges the two by design, so the conjunct was betting on an
 * implementation detail staying still. Erring towards "this run failed" costs an exit 2 and a
 * re-run; erring the other way reports a green.
 */
function isNpmErrorPayload(stdout) {
  try {
    return Boolean(JSON.parse(stdout)?.error);
  } catch {
    // Unparseable JSON is not an error payload this can read, and the caller treats it as a failure
    // anyway. Saying "no" here keeps that single decision in one place.
    return false;
  }
}

/** npm's own words about why it failed, from whichever channel it used. */
function npmComplaint(error) {
  const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
  if (stdout.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(stdout);
      const summary = parsed?.error?.summary ?? parsed?.error?.detail;
      if (typeof summary === 'string' && summary.trim()) return summary.trim();
    } catch {
      // Fall through to the generic text below. A parse failure here is itself the diagnosis.
    }
  }
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr) return stderr.split('\n').slice(0, 3).join(' ');
  return error?.message ?? 'unknown error';
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const acceptedFile = path.join(here, 'accepted-advisories.json');
  const today = new Date().toISOString().slice(0, 10);

  let findings;
  let accepted;
  try {
    // The acceptance list is validated BEFORE the audit runs, so a malformed suppression list
    // cannot be discovered only on the runs where something was found.
    accepted = loadAccepted(acceptedFile);
    findings = summariseAudit(JSON.parse(runAudit(repoRoot)));
  } catch (error) {
    console.error(`[advisories] UNKNOWN: ${error.message}`);
    console.error('[advisories] Refusing to report clean on a check that did not run.');
    process.exit(2);
  }

  const { status, problems, notes } = decide({ findings, accepted, today });

  for (const note of notes) console.log(`[advisories] note: ${note}`);

  if (status === 'clean') {
    console.log(
      `[advisories] clean (${findings.length} finding(s), ${accepted.length} accepted and current, ` +
        `threshold ${FAIL_AT_OR_ABOVE})`,
    );
    process.exit(0);
  }

  console.error(`[advisories] ${problems.length} problem(s):`);
  for (const problem of problems) {
    console.error(`  ${problem.kind}  ${problem.package}  ${problem.id}`);
    console.error(`      ${problem.detail}`);
  }
  console.error('');
  console.error('Fix the dependency if a fix exists and the release age cooldown allows it.');
  console.error(`If it does not, add or update an entry in ${path.relative(repoRoot, acceptedFile)}`);
  console.error('with a reason and a recheck date, and record the reasoning in docs/security-notes.md.');
  process.exit(1);
}

main();
