# Security notes

Open findings, with what was actually verified rather than what was assumed. A finding leaves this
file when it is fixed and the fix is confirmed by a re-run, never when it is explained away.

## Open

### CVE-2026-69152, brace-expansion 5.0.8, HIGH, bundled inside aws-cdk-lib

This is the successor to the finding below, and the shape of the change is worth stating plainly:
the dated upgrade ran, it worked, and one HIGH remains. `aws-cdk-lib` 2.263.0 bundles
brace-expansion 5.0.8, which closes CVE-2026-14257. A second advisory then landed on the same
package: CVE-2026-69152 (GHSA-rgw5-rvv9-x895) covers 4.0.0 through 5.0.8 and is fixed in 5.0.9,
which no released `aws-cdk-lib` bundles yet. An upgrade that closes a CVE and inherits its
replacement is progress, not a clean result, and calling it clean would be the exact false claim
this file exists to prevent.

- Measured 2026-08-04, not assumed. `npm install aws-cdk-lib@latest -w @throughline/infra`
  resolved to 2.263.0 (published 2026-07-31T16:53Z, 3.79 days old, so past the cooldown). The
  bundled copy moved 5.0.7 to 5.0.8. `trivy fs --scanners vuln,secret --severity HIGH,CRITICAL`
  then reported CVE-2026-14257 gone and CVE-2026-69152 open on the same path.
- The count did move, and the honest version of that is worth having in writing. Scanned against
  one advisory database on one day, the pre-upgrade lockfile carries two HIGH findings on this
  package and the post-upgrade lockfile carries one. The first version of this entry said the count
  did not move, which compared a scan from before the second advisory was published against a scan
  from after: a pessimistic error, but the same class of mistake as an optimistic one.
- The `overrides` route was re-tested against this version rather than assumed to still fail. An
  entry pinning `^5.0.9` was added, `npm install` was run, and
  `node_modules/aws-cdk-lib/node_modules/brace-expansion` was still 5.0.8 afterwards. The override
  was removed again, because the top level copy in this tree was already 5.0.9 before it, so the
  entry protected nothing at all.
- That experiment leaves no trace in the commit, so here is how to repeat it in two minutes rather
  than taking this paragraph on trust. Add `"brace-expansion": "^5.0.9"` to the root `overrides`,
  run `npm install`, then read the `version` field of
  `node_modules/aws-cdk-lib/node_modules/brace-expansion/package.json`. It stays at 5.0.8. Remove
  the entry and run `npm install` again. The cause is checkable without running anything at all:
  `aws-cdk-lib`'s manifest names `minimatch` in `bundleDependencies`, and the committed
  `package-lock.json` marks that path `"inBundle": true` with no `resolved` and no `integrity`,
  which is npm recording that it never fetched or resolved it.
- Reachability is unchanged from the entry below: synthesis time only, never in Lambda, never in
  the request path, and every glob pattern reaching it is one this repo wrote.
- Fix path: an `aws-cdk-lib` release that bundles minimatch with brace-expansion 5.0.9 or later.
  Action, dated: re-check on or after **2026-08-11**, and record the outcome here either way.

### GHSA-8j4g-w8fx-2239, hono, MODERATE, deferred by the cooldown

`npm audit` surfaced this during the same upgrade: hono before 4.12.34 has a ReDoS in the CORS
middleware, reachable through the `Access-Control-Request-Headers` header. `apps/api` declares
`hono: ^4`.

- Not fixed today, and deliberately so. 4.12.34 was published 2026-08-03T02:36Z and 4.13.0 on
  2026-08-03T21:54Z, so on 2026-08-04 both sit inside the three day supply chain cooldown that
  `.npmrc` now sets for this repository. The cooldown is not bypassed to clear a finding faster.
- Exposure today is nil in the strict sense: no HTTP surface exists yet, so the CORS middleware is
  not mounted anywhere. That is a fact about today, not a mitigation.
- Action, dated: on or after **2026-08-06**, `npm install hono@latest -w @throughline/api`, then
  re-run `npm audit` and trivy. Whoever builds the HTTP surface before that date configures CORS
  with an explicit origin allowlist rather than a reflected origin, and re-checks this line.

### CVE-2026-14257, brace-expansion 5.0.7, HIGH, bundled inside aws-cdk-lib, SUPERSEDED

Closed on 2026-08-04 by the upgrade described above, and kept here rather than moved to Closed
because its replacement is still open on the same path. Read the two entries together.

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
- Action, dated **2026-08-04**: done. The command was re-run, 2.263.0 installed, and trivy re-run.
  This CVE is gone from the tree and CVE-2026-69152 took its place on the same path. The outcome
  is recorded above rather than inferred from the upgrade having succeeded.

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

- `npm run gate:advisories` is part of `npm run gate`, so it runs in `verify:ship` and in CI. It
  fails on a HIGH or CRITICAL nobody has accepted, on an acceptance whose recheck date has passed,
  and on an acceptance that no longer matches anything. Acceptances live in
  `scripts/accepted-advisories.json` and each one is a dated decision rather than a suppression.
  This exists because everything above it was prose, and prose cannot fail a build: for two days
  the only thing tracking an open HIGH in this repository was a sentence in this file.
- `trivy fs --scanners vuln,secret --severity HIGH,CRITICAL --include-dev-deps` runs after every
  dependency change, not on a schedule. The dev-deps flag is not optional: without it trivy skips
  the development tree, which here is 347 of 783 packages, and those packages execute on developer
  machines and in CI with the same privileges as everything else. A scan that silently covers 56
  percent of the tree while reporting "clean" is the kind of result this file exists to refuse.
- Dependency installs respect the three day release age cooldown, set in this repository's own
  `.npmrc` rather than only in a developer's home directory. It is never bypassed to clear a
  finding faster, because "no advisory yet" inside that window means detection has not opened, not
  that a package is clean. Measured before committing: `npm ci` is unaffected by it, so
  reproducible installs and CI are not slowed or broken by the rule.
- A zero finding result is only reported as clean when the scan is confirmed to have run. A scan
  that produced no output is UNKNOWN. The advisory gate exits 2, distinct from both clean and
  failing, when it cannot reach the registry.
