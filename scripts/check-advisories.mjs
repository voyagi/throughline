#!/usr/bin/env node
/**
 * Fails the build on a dependency advisory nobody has looked at, and on an acceptance nobody has
 * looked at lately.
 *
 * WHY THIS EXISTS. Six mechanical gates ran on this repository and not one of them looked at a
 * dependency advisory: `verify:ship` covers types, tests, lint, complexity, duplication,
 * architecture boundaries and tracked paths. The only thing tracking an open HIGH was a dated line
 * in `docs/security-notes.md`, and prose cannot fail a build. This repository has already learned
 * that lesson once about AI-process artifacts; this is the same lesson about dependencies.
 *
 * WHAT IT DOES. It reads `npm audit --json`, compares the findings against a committed list of
 * accepted ones, and fails when any of these is true:
 *
 *   - a finding at or above the fail threshold is not on the accepted list,
 *   - an acceptance is past its recheck date, which is how a dated decision resurfaces by itself,
 *   - an acceptance matches nothing, which means the advisory is gone and the entry is now a note
 *     about the past that reads like a live risk assessment,
 *   - an acceptance names a severity the advisory no longer has, which is how "moderate, we will
 *     get to it" quietly becomes a critical nobody re-read.
 *
 * WHAT IT IS NOT. It is npm's advisory database and nothing else. It does not see a vulnerability
 * that has not been published, it does not read code, and a clean result means "no advisory in that
 * database matches this tree today". Trivy covers a wider surface and runs separately.
 *
 * A NOTE ON THE COOLDOWN. `.npmrc` in this repository sets `min-release-age`, so a fix published
 * minutes ago is not installable here yet. That is deliberate: inside that window "no advisory yet"
 * means detection has not opened, not that a package is clean. When this gate demands a fix that
 * the cooldown will not install, the answer is an acceptance with a short recheck date, never a
 * bypass.
 *
 * Exit codes: 0 clean, 1 something needs a human, 2 the check could not run. A check that could not
 * run is never reported as clean.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

/** Findings at or above this severity must be accepted explicitly or the build stops. */
const FAIL_AT_OR_ABOVE = 'high';

export function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(String(severity).toLowerCase());
  // An unrecognised severity ranks at the TOP rather than the bottom. A new severity label from a
  // future npm would otherwise sail through a gate whose whole job is to stop unexamined findings.
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/** The GHSA identifier is the stable one. The numeric `source` changes between advisory databases. */
export function advisoryIdFrom(url) {
  const match = /\/advisories\/(GHSA-[a-z0-9-]+)/i.exec(String(url ?? ''));
  return match ? match[1] : null;
}

/**
 * Flatten `npm audit --json` into the findings this gate reasons about.
 *
 * Measured against npm 11 on 2026-08-04: `vulnerabilities` is keyed by package name, and each
 * entry's `via` array holds either a string (another package in the chain) or the advisory object
 * carrying `url`, `title` and `severity`. Both shapes appear in one report, so both are handled.
 */
export function summariseAudit(report) {
  // `!report.vulnerabilities` rather than a bare typeof check: `typeof null` is 'object', so a null
  // field walked straight through the obvious version of this guard and died inside Object.entries
  // with "Cannot convert undefined or null to object", which names neither the file nor the field.
  // A gate whose failure message does not say what is wrong is most of the way to being ignored.
  if (!report || typeof report !== 'object' || !report.vulnerabilities ||
      typeof report.vulnerabilities !== 'object') {
    throw new Error('npm audit did not return a report with a vulnerabilities object');
  }
  const findings = [];
  for (const [packageName, entry] of Object.entries(report.vulnerabilities)) {
    const via = Array.isArray(entry?.via) ? entry.via : [];
    for (const source of via) {
      if (!source || typeof source !== 'object') continue;
      const id = advisoryIdFrom(source.url);
      findings.push({
        package: packageName,
        id: id ?? `unidentified:${packageName}:${source.title ?? 'untitled'}`,
        severity: String(source.severity ?? entry.severity ?? 'unknown').toLowerCase(),
        title: String(source.title ?? 'untitled advisory'),
        url: String(source.url ?? ''),
        paths: Array.isArray(entry.nodes) ? entry.nodes : [],
      });
    }
  }
  return findings;
}

/**
 * The whole decision, as a pure function of the findings, the acceptances and today's date.
 *
 * Pure so the gate's own controls can be proven to fail in a test rather than by editing a file and
 * hoping. A gate that has never been seen to fail is indistinguishable from a clean repository.
 */
export function decide({ findings, accepted, today, failAtOrAbove = FAIL_AT_OR_ABOVE }) {
  const threshold = severityRank(failAtOrAbove);
  const problems = [];
  const notes = [];
  const matched = new Set();

  for (const finding of findings) {
    const acceptance = accepted.find(
      (entry) => entry.id === finding.id && entry.package === finding.package,
    );
    if (acceptance) {
      matched.add(acceptance.id);
      if (String(acceptance.severity).toLowerCase() !== finding.severity) {
        problems.push({
          kind: 'severity_changed',
          id: finding.id,
          package: finding.package,
          detail:
            `accepted as ${acceptance.severity}, now reported as ${finding.severity}. The ` +
            'acceptance was written against a different risk, so it does not carry over.',
        });
      }
      continue;
    }
    if (severityRank(finding.severity) >= threshold) {
      problems.push({
        kind: 'unaccepted',
        id: finding.id,
        package: finding.package,
        detail: `${finding.severity}: ${finding.title} (${finding.url})`,
      });
    } else {
      notes.push(`${finding.severity} ${finding.package}: ${finding.title}`);
    }
  }

  for (const acceptance of accepted) {
    if (!matched.has(acceptance.id)) {
      problems.push({
        kind: 'stale_acceptance',
        id: acceptance.id,
        package: acceptance.package,
        detail:
          'this advisory no longer matches anything in the tree. Delete the entry: an acceptance ' +
          'for a finding that is gone reads as a live risk assessment and is a note about the past.',
      });
      continue;
    }
    // String comparison, because an ISO date sorts lexicographically and parsing one introduces a
    // timezone question that has no right answer for "the day a human should look again".
    if (String(acceptance.recheckAfter) < today) {
      problems.push({
        kind: 'expired_acceptance',
        id: acceptance.id,
        package: acceptance.package,
        detail:
          `the recheck date ${acceptance.recheckAfter} has passed (today is ${today}). Re-run the ` +
          'fix attempt, then either close the finding or extend the date with a written reason.',
      });
    }
  }

  return { status: problems.length === 0 ? 'clean' : 'fail', problems, notes };
}

export function loadAccepted(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed?.accepted)) {
    throw new Error(`${file} must contain an "accepted" array`);
  }
  for (const entry of parsed.accepted) {
    for (const field of ['id', 'package', 'severity', 'recheckAfter', 'reason']) {
      if (typeof entry?.[field] !== 'string' || entry[field].length === 0) {
        throw new Error(`an accepted advisory is missing "${field}": ${JSON.stringify(entry)}`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.recheckAfter)) {
      throw new Error(`recheckAfter must be YYYY-MM-DD, got "${entry.recheckAfter}" for ${entry.id}`);
    }
  }
  return parsed.accepted;
}

/**
 * Run `npm audit --json`.
 *
 * It exits non-zero whenever it finds anything at all, which is not a failure of the command, so
 * the JSON on stdout is read either way. A run that produces no parseable JSON is UNKNOWN, and
 * UNKNOWN is not clean.
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
    if (stdout.trim().startsWith('{')) return stdout;
    throw new Error(
      `npm audit could not run: ${error?.message ?? 'unknown error'}. ` +
        'Offline? This gate needs the registry and refuses to report clean without it.',
    );
  }
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const acceptedFile = path.join(here, 'accepted-advisories.json');
  const today = new Date().toISOString().slice(0, 10);

  let findings;
  let accepted;
  try {
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

// Only when run directly, so the exported functions above can be imported by a test without the
// import itself calling process.exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
