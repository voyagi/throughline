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
- Fix path: a newer `aws-cdk-lib` that bundles minimatch 10.2.6 or later. Whether any released
  version carries the fixed bundle is still UNVERIFIED.
- Attempted 2026-08-03 and correctly refused. `npm install aws-cdk-lib@latest -w @throughline/infra`
  resolved to 2.262.2 rather than 2.263.0, because 2.263.0 was published 2026-07-31T16:53Z and the
  three day supply chain cooldown in `~/.npmrc` had not elapsed. The cooldown is not bypassed to
  clear a finding faster: inside that window "no advisory yet" means detection has not opened, not
  that a package is clean. The command was run, the outcome was measured, and this line records
  what happened rather than what was intended.
- Action, dated: on or after **2026-08-04**, re-run the same command and then re-run trivy. If the
  finding survives the bump, record that here rather than assuming the upgrade cleared it.

## Closed

### GHSA-frvp-7c67-39w9, @hono/node-server, MEDIUM

Closed 2026-08-03 by moving to `^2` (resolved 2.0.12). The whole 1.x line is affected with no 1.x
patch, so this was a major version bump rather than a patch. Done now precisely because `apps/api`
has no source yet: a major bump costs nothing today and would cost a migration later. Peer
dependency checked before the bump rather than after, `@hono/node-server@2` declares `hono: ^4`,
which is what this repo already uses.

### CVE-2026-8723, qs, MEDIUM, development scope

Closed 2026-08-03 with an npm `overrides` entry pinning `^6.15.2`, resolved to 6.15.3. Reached
through `@stryker-mutator/core -> typed-rest-client`. Unlike the brace-expansion case this one is
NOT bundled, which is why an override works here and did nothing there. Verified by reading the
resolved tree, not by assuming the override applied.

## Standing practice

- `trivy fs --scanners vuln,secret --severity HIGH,CRITICAL` runs after every dependency change,
  not on a schedule.
- Dependency installs respect the three day release age cooldown. It is never bypassed to clear a
  finding faster, because "no advisory yet" inside that window means detection has not opened, not
  that a package is clean.
- A zero finding result is only reported as clean when the scan is confirmed to have run. A scan
  that produced no output is UNKNOWN.
