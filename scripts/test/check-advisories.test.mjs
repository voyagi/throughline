import { describe, expect, it } from 'vitest';
import {
  advisoryIdFrom,
  decide,
  severityRank,
  summariseAudit,
} from '../check-advisories.mjs';

/**
 * The gate's own controls, exercised against planted violations.
 *
 * A gate nobody has watched fail is indistinguishable from a clean repository, and this one has the
 * additional problem that its clean path is the common one: it will report clean thousands of times
 * and fail perhaps twice. Every branch that can fail is made to fail here.
 *
 * The audit report below is the real shape, copied from `npm audit --json` in this repository on
 * 2026-08-04 (npm 11, auditReportVersion 2) with the fields this gate reads kept verbatim.
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
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 0, total: 2 } },
};

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
    const report = {
      vulnerabilities: {
        minimatch: { severity: 'high', via: ['brace-expansion'], nodes: ['node_modules/minimatch'] },
      },
    };
    expect(summariseAudit(report)).toEqual([]);
  });

  it('refuses a report shape it cannot read rather than calling it empty', () => {
    // The failure that matters: a future npm changing this shape must not read as zero findings.
    for (const bad of [null, undefined, {}, { vulnerabilities: null }, 'not a report']) {
      expect(() => summariseAudit(bad)).toThrow(/vulnerabilities/);
    }
  });

  it('still produces a finding when the advisory url is missing an id', () => {
    const report = {
      vulnerabilities: {
        thing: { severity: 'critical', via: [{ title: 'no url here', severity: 'critical' }], nodes: [] },
      },
    };
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
    const escalated = summariseAudit({
      vulnerabilities: {
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
      },
    });
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
});
