import { describe, expect, it } from 'vitest';
import {
  addDays,
  advisoryIdFrom,
  decide,
  MAX_ACCEPTANCE_DAYS,
  parseAccepted,
  severityRank,
  summariseAudit,
} from '../lib/advisories.mjs';

/**
 * The gate's own controls, exercised against planted violations.
 *
 * A gate nobody has watched fail is indistinguishable from a clean repository, and this one has the
 * additional problem that its clean path is the common one: it will report clean thousands of times
 * and fail perhaps twice. Every branch in `lib/advisories.mjs` that can fail is made to fail here.
 * The runner's own three exit codes are not covered from here and are exercised by hand against the
 * real registry, which is stated rather than left for a reader to discover.
 *
 * Imported from `lib/` rather than from the runner, and that is load bearing: the runner calls
 * `main()` unconditionally because the usual "am I the entry point" guard is false through a
 * symlink or a Windows junction, and a gate that silently does nothing is worse than no gate.
 *
 * The audit report below is the real shape, copied from `npm audit --json` in this repository on
 * 2026-08-04 (npm 11.14.1, auditReportVersion 2) with the fields this gate reads kept verbatim.
 */
const LIVE_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    'brace-expansion': {
      name: 'brace-expansion',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 1130734,
          name: 'brace-expansion',
          title:
            'brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation',
          url: 'https://github.com/advisories/GHSA-rgw5-rvv9-x895',
          severity: 'high',
          range: '>=4.0.0 <5.0.9',
        },
      ],
      effects: [],
      range: '4.0.0 - 5.0.8',
      nodes: ['node_modules/aws-cdk-lib/node_modules/brace-expansion'],
      fixAvailable: true,
    },
    hono: {
      name: 'hono',
      severity: 'moderate',
      isDirect: true,
      via: [
        {
          source: 1130733,
          name: 'hono',
          title: 'Hono: ReDoS in CORS middleware via Access-Control-Request-Headers',
          url: 'https://github.com/advisories/GHSA-8j4g-w8fx-2239',
          severity: 'moderate',
          range: '<4.12.34',
        },
      ],
      effects: [],
      range: '<4.12.34',
      nodes: ['node_modules/hono'],
      fixAvailable: true,
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 0, total: 2 },
    dependencies: { prod: 323, dev: 347, optional: 109, peer: 0, peerOptional: 0, total: 783 },
  },
};

/**
 * A report around a set of vulnerabilities, with a metadata block that says the tree is real.
 *
 * Every fixture needs one, because "the audit found nothing" and "the audit had nothing to look at"
 * are now different answers and only the metadata tells them apart.
 */
function reportOf(vulnerabilities, metadata = {}) {
  const counted = Object.values(vulnerabilities).length;
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: counted },
      dependencies: { prod: 10, dev: 5, optional: 0, peer: 0, peerOptional: 0, total: 15 },
      ...metadata,
    },
  };
}

const ACCEPTED_TODAY = [
  {
    id: 'GHSA-rgw5-rvv9-x895',
    package: 'brace-expansion',
    severity: 'high',
    reason: 'bundled where an override cannot reach it',
    recheckAfter: '2026-08-11',
  },
  {
    id: 'GHSA-8j4g-w8fx-2239',
    package: 'hono',
    severity: 'moderate',
    reason: 'fix is inside the release age cooldown',
    recheckAfter: '2026-08-06',
  },
];

describe('severityRank', () => {
  it('orders the severities npm actually emits', () => {
    expect(severityRank('info')).toBeLessThan(severityRank('low'));
    expect(severityRank('low')).toBeLessThan(severityRank('moderate'));
    expect(severityRank('moderate')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('critical'));
  });

  it('ranks a severity it has never seen at the TOP, not the bottom', () => {
    // A new label from a future npm must stop the build, not sail through the gate whose entire
    // job is to stop findings nobody has examined.
    expect(severityRank('catastrophic')).toBeGreaterThan(severityRank('critical'));
    expect(severityRank(undefined)).toBeGreaterThan(severityRank('critical'));
  });
});

describe('advisoryIdFrom', () => {
  it('takes the GHSA slug out of the advisory url', () => {
    expect(advisoryIdFrom('https://github.com/advisories/GHSA-rgw5-rvv9-x895')).toBe(
      'GHSA-rgw5-rvv9-x895',
    );
  });

  it('returns null rather than a wrong id when there is no slug', () => {
    expect(advisoryIdFrom('https://example.com/whatever')).toBeNull();
    expect(advisoryIdFrom(undefined)).toBeNull();
  });
});

describe('summariseAudit', () => {
  it('flattens the real report into findings', () => {
    const findings = summariseAudit(LIVE_REPORT);
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.id).sort()).toEqual([
      'GHSA-8j4g-w8fx-2239',
      'GHSA-rgw5-rvv9-x895',
    ]);
    expect(findings.find((finding) => finding.package === 'hono')?.severity).toBe('moderate');
  });

  it('ignores the string entries npm mixes into the same via array', () => {
    const report = reportOf(
      { minimatch: { severity: 'high', via: ['brace-expansion'], nodes: ['node_modules/minimatch'] } },
      { vulnerabilities: { total: 0 } },
    );
    expect(summariseAudit(report)).toEqual([]);
  });

  it('refuses a report shape it cannot read rather than calling it empty', () => {
    // The failure that matters: a future npm changing this shape must not read as zero findings.
    // The reason differs by which guard catches first, and asserting the reason rather than just
    // the throw is what keeps the guards individually load bearing.
    const cases = [
      [null, /vulnerabilities object/],
      [undefined, /vulnerabilities object/],
      ['not a report', /vulnerabilities object/],
      [{}, /report version/],
      [{ auditReportVersion: 2, vulnerabilities: null }, /vulnerabilities object/],
    ];
    for (const [bad, expected] of cases) {
      expect(() => summariseAudit(bad)).toThrow(expected);
    }
  });

  it('refuses a tree with no dependencies rather than calling it clean', () => {
    // Measured before this guard existed: a directory with a bare package.json and no dependencies
    // printed "clean (0 finding(s))" and exited 0. Nothing was audited. The sibling gate
    // check-tracked-files.mjs has always called an empty index UNKNOWN; this is the same floor.
    expect(() =>
      summariseAudit(reportOf({}, { dependencies: { total: 0 } })),
    ).toThrow(/0 dependencies/);
    expect(() => summariseAudit(reportOf({}, { dependencies: undefined }))).toThrow(
      /dependency count is undefined rather than a number/,
    );
  });

  it('refuses a report version nobody has read the shape of', () => {
    // Fail closed on a future npm. A new schema is unknown, not clean, and the cost of being wrong
    // in the other direction is a silent green on a gate whose only job is to not do that.
    expect(() => summariseAudit({ ...LIVE_REPORT, auditReportVersion: 3 })).toThrow(/report version/);
    expect(() => summariseAudit({ ...LIVE_REPORT, auditReportVersion: undefined })).toThrow(
      /report version/,
    );
  });

  it('refuses an array where the vulnerabilities object should be', () => {
    // An array passes every typeof check and Object.entries yields index-to-value pairs, so this
    // reads as zero findings and a clean verdict unless something says otherwise.
    expect(() => summariseAudit(reportOf([]))).toThrow(/vulnerabilities object/);
  });

  it('refuses a summary total that is not a number, whatever shape it took', () => {
    // The guard below only fired on `total > 0`, which disarmed it on every drift it exists to
    // catch: a missing summary, a renamed key and a stringly-typed count all returned clean.
    for (const metadata of [
      { vulnerabilities: undefined },
      { vulnerabilities: { totals: 3 } },
      { vulnerabilities: { total: '3' } },
      { vulnerabilities: [] },
    ]) {
      expect(() => summariseAudit(reportOf({}, metadata))).toThrow(/summary total/);
    }
  });

  it('says which thing is wrong when the dependency count is not a number', () => {
    // The message used to read "reported 15 dependencies. A tree with nothing in it cannot be
    // audited", which contradicts itself in one sentence for a stringly-typed count.
    expect(() => summariseAudit(reportOf({}, { dependencies: { total: '15' } }))).toThrow(
      /dependency count is "15" rather than a number/,
    );
    expect(() => summariseAudit(reportOf({}, { dependencies: { total: 0 } }))).toThrow(
      /reported 0 dependencies/,
    );
  });

  it('refuses a report whose own summary counts more than it could read', () => {
    // The drifted-shape case, and the one that matters most: npm says there is a critical, this
    // gate extracts none, and "I could not read it" and "there is nothing" are the same value.
    const drifted = reportOf(
      { something: { severity: 'critical', via: 'a string where an object used to be' } },
      { vulnerabilities: { critical: 1, total: 1 } },
    );
    expect(() => summariseAudit(drifted)).toThrow(/could read none of them/);
  });

  it('still produces a finding when the advisory url is missing an id', () => {
    const report = reportOf({
      thing: { severity: 'critical', via: [{ title: 'no url here', severity: 'critical' }], nodes: [] },
    });
    const findings = summariseAudit(report);
    expect(findings).toHaveLength(1);
    // Unidentifiable, therefore unmatchable by any acceptance, therefore it fails the gate. That is
    // the correct direction: an advisory this gate cannot name is one nobody can accept.
    expect(findings[0].id).toMatch(/^unidentified:/);
  });
});

describe('decide', () => {
  it('is clean when every finding is accepted and every acceptance is current', () => {
    const result = decide({
      findings: summariseAudit(LIVE_REPORT),
      accepted: ACCEPTED_TODAY,
      today: '2026-08-04',
    });
    expect(result.status).toBe('clean');
    expect(result.problems).toEqual([]);
  });

  it('fails on a high finding nobody has accepted', () => {
    const result = decide({
      findings: summariseAudit(LIVE_REPORT),
      accepted: [ACCEPTED_TODAY[1]],
      today: '2026-08-04',
    });
    expect(result.status).toBe('fail');
    expect(result.problems.map((problem) => problem.kind)).toContain('unaccepted');
  });

  it('does not fail on a moderate finding nobody has accepted, but says so', () => {
    const result = decide({
      findings: summariseAudit(LIVE_REPORT),
      accepted: [ACCEPTED_TODAY[0]],
      today: '2026-08-04',
    });
    expect(result.status).toBe('clean');
    expect(result.notes.join(' ')).toMatch(/hono/);
  });

  it('fails the day after an acceptance expires, which is the whole point of the date', () => {
    // The gap this closes: before this gate, the only thing tracking a dated decision was a line in
    // a markdown file, and nothing anywhere re-read it.
    const onTheDay = decide({
      findings: summariseAudit(LIVE_REPORT),
      accepted: ACCEPTED_TODAY,
      today: '2026-08-06',
    });
    expect(onTheDay.status).toBe('clean');

    const dayAfter = decide({
      findings: summariseAudit(LIVE_REPORT),
      accepted: ACCEPTED_TODAY,
      today: '2026-08-07',
    });
    expect(dayAfter.status).toBe('fail');
    const expired = dayAfter.problems.filter((problem) => problem.kind === 'expired_acceptance');
    expect(expired).toHaveLength(1);
    expect(expired[0].package).toBe('hono');
  });

  it('fails on an acceptance that no longer matches anything', () => {
    const result = decide({
      findings: [],
      accepted: ACCEPTED_TODAY,
      today: '2026-08-04',
    });
    expect(result.status).toBe('fail');
    expect(result.problems.every((problem) => problem.kind === 'stale_acceptance')).toBe(true);
  });

  it('fails when an advisory grew more severe than the acceptance was written for', () => {
    const escalated = summariseAudit(
      reportOf({
        hono: {
          severity: 'critical',
          via: [
            {
              title: 'now much worse',
              url: 'https://github.com/advisories/GHSA-8j4g-w8fx-2239',
              severity: 'critical',
            },
          ],
          nodes: ['node_modules/hono'],
        },
      }),
    );
    const result = decide({ findings: escalated, accepted: [ACCEPTED_TODAY[1]], today: '2026-08-04' });
    expect(result.status).toBe('fail');
    expect(result.problems[0].kind).toBe('severity_changed');
  });

  it('does not let an acceptance for one package cover the same advisory in another', () => {
    const findings = summariseAudit(LIVE_REPORT);
    const wrongPackage = [{ ...ACCEPTED_TODAY[0], package: 'some-other-package' }, ACCEPTED_TODAY[1]];
    const result = decide({ findings, accepted: wrongPackage, today: '2026-08-04' });
    expect(result.status).toBe('fail');
    expect(result.problems.map((problem) => problem.kind).sort()).toEqual([
      'stale_acceptance',
      'unaccepted',
    ]);
  });

  it('is clean on a tree with no findings and no acceptances', () => {
    expect(decide({ findings: [], accepted: [], today: '2026-08-04' }).status).toBe('clean');
  });

  it('refuses an acceptance dated beyond the horizon, which is a suppression in disguise', () => {
    // Without this, "accepted until 2099" is permanent and the one mechanism built to make a
    // decision come back around is the thing that buries it.
    const farOut = [{ ...ACCEPTED_TODAY[0], recheckAfter: '2099-12-31' }, ACCEPTED_TODAY[1]];
    const result = decide({
      findings: summariseAudit(LIVE_REPORT),
      accepted: farOut,
      today: '2026-08-04',
    });
    expect(result.status).toBe('fail');
    expect(result.problems.map((problem) => problem.kind)).toContain('acceptance_too_far_out');
  });

  it('allows a date exactly on the horizon and refuses the day past it', () => {
    const findings = summariseAudit(LIVE_REPORT);
    const onHorizon = [
      { ...ACCEPTED_TODAY[0], recheckAfter: addDays('2026-08-04', MAX_ACCEPTANCE_DAYS) },
      ACCEPTED_TODAY[1],
    ];
    expect(decide({ findings, accepted: onHorizon, today: '2026-08-04' }).status).toBe('clean');

    const pastHorizon = [
      { ...ACCEPTED_TODAY[0], recheckAfter: addDays('2026-08-04', MAX_ACCEPTANCE_DAYS + 1) },
      ACCEPTED_TODAY[1],
    ];
    expect(decide({ findings, accepted: pastHorizon, today: '2026-08-04' }).status).toBe('fail');
  });

  it('keys an acceptance unambiguously, whatever the id and package contain', () => {
    // Mutation testing found nothing pinning the separator: reverting keyOf to a plain `:` left
    // every test green. The pair below is why a separator is the wrong shape regardless of which
    // character is chosen. `A:B` + `C` and `A` + `B:C` collapse to the same string under `:`, so
    // the live entry marks the stale one as matched and its staleness is never reported.
    const findings = [
      { id: 'GHSA-a:b', package: 'c', severity: 'high', title: 'one', url: '' },
    ];
    const accepted = [
      {
        id: 'GHSA-a:b',
        package: 'c',
        severity: 'high',
        reason: 'live',
        recheckAfter: '2026-09-01',
      },
      {
        id: 'GHSA-a',
        package: 'b:c',
        severity: 'high',
        reason: 'stale, and it must not hide behind the entry above',
        recheckAfter: '2026-09-01',
      },
    ];
    const result = decide({ findings, accepted, today: '2026-08-04' });
    const stale = result.problems.filter((problem) => problem.kind === 'stale_acceptance');
    expect(stale).toHaveLength(1);
    expect(stale[0].package).toBe('b:c');
  });

  it('does not let a live acceptance mark a stale one with the same id as matched', () => {
    // The lookup keys on id AND package, so the matched set has to as well. Keyed by id alone, the
    // second entry below is silently considered matched and its staleness never reported.
    const sharedId = [
      ACCEPTED_TODAY[0],
      ACCEPTED_TODAY[1],
      { ...ACCEPTED_TODAY[1], package: 'a-package-that-is-not-in-the-tree' },
    ];
    const result = decide({
      findings: summariseAudit(LIVE_REPORT),
      accepted: sharedId,
      today: '2026-08-04',
    });
    expect(result.status).toBe('fail');
    const stale = result.problems.filter((problem) => problem.kind === 'stale_acceptance');
    expect(stale).toHaveLength(1);
    expect(stale[0].package).toBe('a-package-that-is-not-in-the-tree');
  });
});

describe('addDays', () => {
  it('walks the calendar rather than adding milliseconds', () => {
    expect(addDays('2026-08-04', 1)).toBe('2026-08-05');
    expect(addDays('2026-08-04', 90)).toBe('2026-11-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    // A leap day, because a naive implementation is only ever wrong here.
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('parseAccepted', () => {
  it('accepts the list this repository actually ships', () => {
    expect(parseAccepted({ accepted: ACCEPTED_TODAY })).toHaveLength(2);
  });

  it('refuses a file with no accepted array', () => {
    for (const bad of [null, {}, { accepted: {} }, { accepted: 'none' }]) {
      expect(() => parseAccepted(bad, 'the list')).toThrow(/must contain an "accepted" array/);
    }
  });

  it('refuses an entry missing any of the five required fields', () => {
    // A suppression entry with no reason is a suppression. Each field is removed in turn so that
    // deleting any one of the five checks is visible here.
    for (const field of ['id', 'package', 'severity', 'recheckAfter', 'reason']) {
      const entry = { ...ACCEPTED_TODAY[0] };
      delete entry[field];
      expect(() => parseAccepted({ accepted: [entry] })).toThrow(new RegExp(`missing "${field}"`));
      expect(() => parseAccepted({ accepted: [{ ...ACCEPTED_TODAY[0], [field]: '' }] })).toThrow(
        new RegExp(`missing "${field}"`),
      );
    }
  });

  it('refuses a recheck date that is not a date', () => {
    expect(() => parseAccepted({ accepted: [{ ...ACCEPTED_TODAY[0], recheckAfter: 'soon' }] })).toThrow(
      /must be YYYY-MM-DD/,
    );
    expect(() =>
      parseAccepted({ accepted: [{ ...ACCEPTED_TODAY[0], recheckAfter: '2026-8-11' }] }),
    ).toThrow(/must be YYYY-MM-DD/);
    // Shaped like a date, and not one. This compares as an ordinary string forever otherwise.
    expect(() =>
      parseAccepted({ accepted: [{ ...ACCEPTED_TODAY[0], recheckAfter: '2026-02-31' }] }),
    ).toThrow(/not a real date/);
  });
});
