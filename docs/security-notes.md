# Security notes

Open findings, with what was actually verified rather than what was assumed. A finding leaves this
file when it is fixed and the fix is confirmed by a re-run, never when it is explained away.

## Open

### CVE-2026-14257, brace-expansion 5.0.7, HIGH, bundled inside aws-cdk-lib

Found by `trivy fs --scanners vuln,secret --severity HIGH,CRITICAL` on 2026-08-02, immediately
after the first dependency install.

- Path: `node_modules/aws-cdk-lib/node_modules/brace-expansion` at 5.0.7, reached through
  `aws-cdk-lib@2.262.2 -> minimatch@10.2.5`.
- Fixed upstream in brace-expansion 5.0.8. The top level copy in this tree is already 5.0.9.
- An npm `overrides` entry does NOT fix it, and this was verified rather than assumed: the
  lockfile records that entry with `inBundle: true`, so it ships inside the `aws-cdk-lib` tarball
  and npm cannot rewrite it. An override was added, measured to change nothing, and removed. A
  no-op mitigation left in place reads as protection and provides none.
- Reachability: `aws-cdk-lib` runs at synthesis time on a developer machine or in CI. It never
  runs in Lambda and it is never in the request path. The vulnerability is a denial of service
  through a maliciously crafted glob pattern, and every glob pattern reaching it is one this repo
  wrote. Real exposure here is close to nil, which is a reason to schedule the fix rather than a
  reason to stop tracking it.
- Fix path: a newer `aws-cdk-lib` that bundles minimatch 10.2.6 or later. 2.263.0 exists as of
  2026-08-02 but is inside the three day supply chain cooldown configured in `~/.npmrc`, so it is
  deliberately not installable yet. Whether it carries the fixed bundle is UNVERIFIED.
- Action, dated: on or after 2026-08-05, run `npm install aws-cdk-lib@latest -w @throughline/infra`
  and re-run trivy. If the finding survives the bump, record that here rather than assuming the
  upgrade cleared it.

## Standing practice

- `trivy fs --scanners vuln,secret --severity HIGH,CRITICAL` runs after every dependency change,
  not on a schedule.
- Dependency installs respect the three day release age cooldown. It is never bypassed to clear a
  finding faster, because "no advisory yet" inside that window means detection has not opened, not
  that a package is clean.
- A zero finding result is only reported as clean when the scan is confirmed to have run. A scan
  that produced no output is UNKNOWN.
