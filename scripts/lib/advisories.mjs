/**
 * The advisory gate's decision logic, with no process, no network and no exit codes.
 *
 * Separated from the runner for one reason, and it is not tidiness. The runner used to guard its
 * own `main()` with `process.argv[1] === fileURLToPath(import.meta.url)` so that a test could
 * import these functions without running the gate. That comparison is false whenever the script is
 * reached through a symlink or a Windows junction, because `import.meta.url` is the real path and
 * `argv[1]` is the path as invoked. The gate then did nothing, printed nothing, exited 0, and
 * `npm run gate` called it a pass. A gate whose only failure symptom is silence is worse than no
 * gate. With the pure parts here, the runner calls `main()` unconditionally and has no guard left
 * to get wrong.
 *
 * WHAT THIS IS NOT. It is npm's advisory database and nothing else. A clean result means "no
 * advisory in that database matches this tree today". It does not see an unpublished vulnerability
 * and it does not read code.
 */

import { readFileSync } from 'node:fs';

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

/** Findings at or above this severity must be accepted explicitly or the build stops. */
export const FAIL_AT_OR_ABOVE = 'high';

/**
 * The `npm audit --json` schema version this file knows how to read.
 *
 * Asserted rather than assumed, and the direction is deliberate: a report version nobody has looked
 * at is UNKNOWN, not clean. When npm ships a new one this gate stops the build and somebody reads
 * the new shape, which costs an afternoon. The alternative costs a silent green.
 */
export const SUPPORTED_REPORT_VERSION = 2;

/**
 * How far ahead an acceptance may be dated.
 *
 * Without a ceiling, "accepted until 2099" is a permanent suppression wearing a date's clothing,
 * and the mechanism whose entire purpose is to make a decision come back around would be the thing
 * that buries it. A quarter is long enough for an upstream fix to land and short enough that
 * nobody forgets what they accepted.
 */
export const MAX_ACCEPTANCE_DAYS = 90;

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
 * One key for one advisory in one package, so a shared id cannot make two entries look like one.
 *
 * `JSON.stringify` of the pair rather than a separator character. The first version used a literal
 * NUL byte, on the reasoning that no identifier can contain one. It renders as a space in every
 * editor, so it was invisible, and git then classified this whole file as BINARY: no diff, no
 * blame, no `git grep`, on the one module that decides whether the build passes, in a repository
 * whose entire argument is auditability. An escape sequence would have been fine. A raw control
 * character in source is a trap that hides itself.
 */
function keyOf(entry) {
  return JSON.stringify([entry.id, entry.package]);
}

/**
 * Refuse a report this code cannot read, before reading it.
 *
 * `!report.vulnerabilities` rather than a bare typeof check: `typeof null` is 'object', so a null
 * field walked straight through the obvious version of this guard and died inside Object.entries
 * with "Cannot convert undefined or null to object", which names neither the file nor the field.
 * An ARRAY is refused for a nastier reason: it passes every typeof check, `Object.entries` happily
 * yields index-to-value pairs, and the result is zero findings and a clean verdict.
 */
function assertReadableReport(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('npm audit did not return a report with a vulnerabilities object');
  }
  if (report.auditReportVersion !== SUPPORTED_REPORT_VERSION) {
    throw new Error(
      `npm audit returned report version ${JSON.stringify(report.auditReportVersion)} and this ` +
        `gate reads version ${SUPPORTED_REPORT_VERSION}. An unread shape is unknown, not clean: ` +
        'read the new format and update this file rather than letting it report a green.',
    );
  }
  if (
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== 'object' ||
    Array.isArray(report.vulnerabilities)
  ) {
    throw new Error('npm audit did not return a report with a vulnerabilities object');
  }
}

/**
 * Refuse a result that came from nothing, after reading it.
 *
 * Two questions with the same wrong answer available to both: was there a tree to audit, and does
 * what this extracted account for what npm says it found. The summary total must be a NUMBER, not
 * merely a positive one. The first version only fired on `total > 0`, which disarmed it on every
 * shape drift it existed to catch: a renamed key, a missing summary and a stringly-typed count all
 * skipped it and returned clean. A guard that switches itself off in exactly its own scenario is a
 * comment.
 */
function assertAudited(report, findings) {
  const dependencies = report.metadata?.dependencies?.total;
  if (typeof dependencies !== 'number') {
    throw new Error(
      `npm audit's dependency count is ${JSON.stringify(dependencies)} rather than a number, so ` +
        'there is no way to tell whether anything was audited. Unknown, not clean.',
    );
  }
  if (dependencies <= 0) {
    throw new Error(
      `npm audit reported ${dependencies} dependencies. A tree with nothing in it cannot be ` +
        'audited, so this is unknown rather than clean.',
    );
  }

  const counted = report.metadata?.vulnerabilities?.total;
  if (typeof counted !== 'number') {
    throw new Error(
      `npm audit's summary total is ${JSON.stringify(counted)} rather than a number, so there is ` +
        "nothing to check this gate's own reading against. Unknown, not clean.",
    );
  }
  if (counted > 0 && findings.length === 0) {
    throw new Error(
      `npm audit's own summary counts ${counted} vulnerabilities and this gate could read none of ` +
        'them out of the report. The report shape has changed, so the result is unknown rather ' +
        'than clean.',
    );
  }
}

/**
 * Flatten `npm audit --json` into the findings this gate reasons about.
 *
 * Measured against npm 11.14.1 on 2026-08-04: `vulnerabilities` is keyed by package name and each
 * entry's `via` array holds either a string (another package in the chain) or the advisory object
 * carrying `url`, `title` and `severity`. Both shapes appear in one report, so both are handled.
 *
 * The guards around this loop are the difference between a check and a formality. Extracting
 * nothing and there being nothing are the same value, so everything that could produce the first is
 * turned into a loud failure.
 */
export function summariseAudit(report) {
  assertReadableReport(report);

  const findings = [];
  for (const [packageName, entry] of Object.entries(report.vulnerabilities)) {
    const via = Array.isArray(entry?.via) ? entry.via : [];
    for (const source of via) {
      if (!source || typeof source !== 'object') continue;
      const id = advisoryIdFrom(source.url);
      findings.push({
        package: packageName,
        // An advisory this gate cannot name is one nobody can accept, so it is given a name that no
        // acceptance will ever match and therefore fails the gate. That is the correct direction.
        id: id ?? `unidentified:${packageName}:${source.title ?? 'untitled'}`,
        severity: String(source.severity ?? entry.severity ?? 'unknown').toLowerCase(),
        title: String(source.title ?? 'untitled advisory'),
        url: String(source.url ?? ''),
      });
    }
  }

  assertAudited(report, findings);
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
  // Keyed by advisory AND package, matching the lookup below. Keyed by id alone, a stale entry
  // sharing an id with a live one is silently marked as matched and never reported.
  const matched = new Set();

  for (const finding of findings) {
    const acceptance = accepted.find(
      (entry) => entry.id === finding.id && entry.package === finding.package,
    );
    if (acceptance) {
      matched.add(keyOf(acceptance));
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
    problems.push(...acceptanceProblems(acceptance, matched, today));
  }

  return { status: problems.length === 0 ? 'clean' : 'fail', problems, notes };
}

/** What is wrong with one acceptance, if anything: stale, expired, or dated past the horizon. */
function acceptanceProblems(acceptance, matched, today) {
  const named = { id: acceptance.id, package: acceptance.package };

  if (!matched.has(keyOf(acceptance))) {
    return [
      {
        ...named,
        kind: 'stale_acceptance',
        detail:
          'this advisory no longer matches anything in the tree. Delete the entry: an acceptance ' +
          'for a finding that is gone reads as a live risk assessment and is a note about the past.',
      },
    ];
  }

  // String comparison, because an ISO date sorts lexicographically and parsing one introduces a
  // timezone question that has no right answer for "the day a human should look again". The skew
  // between UTC here and the owner's UTC+2 moves an expiry at most two hours late, never early.
  if (String(acceptance.recheckAfter) < today) {
    return [
      {
        ...named,
        kind: 'expired_acceptance',
        detail:
          `the recheck date ${acceptance.recheckAfter} has passed (today is ${today}). Re-run the ` +
          'fix attempt, then either close the finding or extend the date with a written reason.',
      },
    ];
  }

  const horizon = addDays(today, MAX_ACCEPTANCE_DAYS);
  if (String(acceptance.recheckAfter) > horizon) {
    return [
      {
        ...named,
        kind: 'acceptance_too_far_out',
        detail:
          `the recheck date ${acceptance.recheckAfter} is further out than ${MAX_ACCEPTANCE_DAYS} ` +
          `days (past ${horizon}). A date nobody will live to see is a permanent suppression with ` +
          'a date written on it, which is the one thing this file must not become.',
      },
    ];
  }

  return [];
}

/** `today` plus n days, as YYYY-MM-DD. UTC throughout, matching how `today` is produced. */
export function addDays(today, days) {
  const at = new Date(`${today}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export function parseAccepted(parsed, source = 'the acceptance list') {
  if (!Array.isArray(parsed?.accepted)) {
    throw new Error(`${source} must contain an "accepted" array`);
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
    // A date that parses as text but not as a day, 2026-02-31 being the classic, would otherwise
    // compare as a perfectly ordinary string forever.
    if (new Date(`${entry.recheckAfter}T00:00:00Z`).toISOString().slice(0, 10) !== entry.recheckAfter) {
      throw new Error(`recheckAfter is not a real date: "${entry.recheckAfter}" for ${entry.id}`);
    }
  }
  return parsed.accepted;
}

export function loadAccepted(file) {
  return parseAccepted(JSON.parse(readFileSync(file, 'utf8')), file);
}
