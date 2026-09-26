# Security notes

Open findings, with what was actually verified rather than what was assumed. A finding leaves this
file when it is fixed and the fix is confirmed by a re-run, never when it is explained away.

## Open

None, checked 2026-09-26 right after the bumps in the first Closed entry below. `npm run
gate:advisories` reads `clean (0 finding(s), 0 accepted and current, threshold high)`, `npm audit`
counts 0 vulnerabilities at any severity over 807 dependencies, and `trivy fs --scanners
vuln,secret --severity HIGH,CRITICAL --include-dev-deps` reports 0 on `package-lock.json`. The same
trivy command pointed at the lockfile from before the bumps reports 9, one CRITICAL and eight HIGH,
so the zero is the scanner reading a fixed tree rather than a scanner that reads nothing.

## Closed

### GHSA-26w7-cxv4-gfx2, astro, CRITICAL, and sixteen more

Closed 2026-09-26 by version bumps alone. No acceptance was added or extended, because every fix
had a release old enough for the three day cooldown. The advisories gate is what listed them: by
that day it failed on eight unaccepted findings at HIGH or above plus the expired brace-expansion
acceptance in the next entry, and it printed ten MODERATE findings as notes. Dependabot's alert
list covered the same packages except qs, whose two advisories came from npm's audit alone.

| Package | Advisory | Severity | Was | Now | Reached through |
|---|---|---|---|---|---|
| astro | GHSA-26w7-cxv4-gfx2 | CRITICAL | 7.1.6 | 7.3.4 | `apps/web`, direct |
| astro | GHSA-376h-93r7-7g6f | MODERATE | 7.1.6 | 7.3.4 | `apps/web`, direct |
| sharp | GHSA-rgj7-g3m4-5g8c | HIGH | 0.35.3 | 0.35.4 | astro, optional |
| svgo | GHSA-w27v-7q3p-w38r | HIGH | 4.0.2 | 4.1.0 | astro |
| svgo | GHSA-4vpr-x523-8j87 | MODERATE | 4.0.2 | 4.1.0 | astro |
| js-yaml | GHSA-2883-xcg3-v3hh | HIGH | 4.3.1 | 4.3.2 | astro, `@astrojs/internal-helpers` |
| devalue | GHSA-9rgm-9g3h-6x36 | MODERATE | 5.9.0 | 5.9.4 | astro, `@astrojs/preact` |
| fast-uri | GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp | HIGH | 3.1.5 | 3.1.8 | `@stryker-mutator/core` to `ajv`, development |
| hono | GHSA-crvj-82cr-hjcx, GHSA-g6gw-c38x-mqfc, GHSA-gqvv-2mrq-wpjv | MODERATE | 4.12.34 | 4.13.8 | `apps/api`, direct |
| vitest, @vitest/mocker | GHSA-82fw-gwwq-j7x9 | MODERATE | 4.1.10 | 4.1.11 | root, development |
| qs | GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g | MODERATE | 6.15.3 | 6.16.0 | `@stryker-mutator/core` to `typed-rest-client`, development |

- The cooldown was read from the registry for every version, not assumed. The bumps added or
  changed 89 lockfile entries. The 87 with a registry record of their own were all published more
  than three days before the install, and the other two are bundled inside the aws-cdk-lib 2.270.0
  tarball, which was too. The youngest were astro 7.3.4 and `@astrojs/markdown-satteri` 0.4.2,
  both 3.8 days old. Newer releases still
  inside the window were left alone rather than forced: astro 7.3.5, hono 4.13.9 and
  aws-cdk-lib 2.271.0.
- Each bump took the newest release inside the range its manifest already declared, never a new
  major. The manifests now name the fixed floors (`astro ^7.3.4`, `hono ^4.13.8`, `vitest` and
  `@vitest/coverage-v8` `^4.1.11`, `aws-cdk-lib ^2.270.0`), so a lockfile regenerated from nothing
  cannot resolve any of them back under its fix.
- Only qs needed an override, for the reason its 2026-08-03 entry gives. `typed-rest-client` 2.3.1
  still pins `qs` 6.15.1 exactly and `@stryker-mutator/core` 9.6.1 declares
  `typed-rest-client ~2.3.0`, so the root override moved from `^6.15.2` to `^6.16.0` and resolved
  6.16.0, read back with `npm ls qs --all`. Every other fix came through a range that already
  allowed it: astro 7.3.4 itself requires `svgo ^4.1.0`, `js-yaml ^4.3.2` and `sharp ^0.35.4`,
  `ajv` declares `fast-uri ^3.0.1`, and astro and `@astrojs/preact` both declare `devalue ^5.8.1`.
- The astro bump also moved packages nobody named, through astro's own ranges: the one hoisted
  `zod`, which `apps/api` imports, went from 4.4.3 to 4.6.5, `diff` from 8.0.4 to 9.0.0 (astro is
  its only dependent), and the Astro compiler bindings from 0.3.2 to 0.4.1. `@astrojs/preact` stays
  at 6.0.2: no advisory reaches it and it declares no range on astro.
- Reachability, stated rather than implied. The site is static output, sets no `base`, and no page
  imports `astro:assets`, so the CRITICAL (AVIF image optimisation), the base-stripping MODERATE,
  the sharp advisory and the svgo pair had no path here. They are fixed rather than reasoned about.
  One advisory WAS on the request path: GHSA-crvj-82cr-hjcx is hono's query parser reading
  parameters after a URL fragment, and `apps/api/src/server.ts` reads `kind` and `limit` through
  `c.req.queries` and `c.req.query`. fast-uri, qs and vitest are development tooling that runs on a
  developer machine and in CI.
- Confirmed by re-runs, not by the installs succeeding: the gate, `npm audit` and trivy as recorded
  under Open, and `npm run verify:ship` passing on the result. The `astro check` blind spot measured
  in `docs/gates.md` was re-measured on astro 7.3.4 and still holds.

### CVE-2026-69152, brace-expansion 5.0.8, HIGH, bundled inside aws-cdk-lib

**Closed 2026-09-26 by `npm install aws-cdk-lib@2.270.0 -w @throughline/infra`.** 2.270.0
(published 2026-09-17T18:33Z, 8.8 days old, so past the cooldown) still bundles minimatch 10.2.5,
and under it brace-expansion **5.0.9**, read from the `version` field of
`node_modules/aws-cdk-lib/node_modules/brace-expansion/package.json`: the same two-minute
inspection the bullets below describe. `npm audit` then reported nothing on that path, and the
acceptance in `scripts/accepted-advisories.json` was deleted rather than extended. Which release
between 2.265.0 and 2.270.0 first shipped the fixed bundle was not measured, because only 2.270.0
was installed.

The recheck the last bullet below dated 2026-08-20 did not run on that date, and from that day the
gate failed, as designed, until this change. `main` took no commits between 2026-08-18 and the day
it closed. Everything from here down is the record as it stood while the finding was
open.

This is the successor to the finding below, and the shape of the change is worth stating plainly:
the dated upgrade ran, it worked, and one HIGH remains. `aws-cdk-lib` 2.263.0 bundles
brace-expansion 5.0.8, which closes CVE-2026-14257. A second advisory then landed on the same
package: CVE-2026-69152 (GHSA-rgw5-rvv9-x895) covers 4.0.0 through 5.0.8 and is fixed in 5.0.9,
which the newest `aws-cdk-lib`, 2.263.0, still does not bundle. An upgrade that closes a CVE and
inherits its replacement is progress, not a clean result, and calling it clean would be the exact
false claim this file exists to prevent.

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
- Re-checked 2026-08-09, two days early, and the outcome is that nothing moved. `npm view
  aws-cdk-lib version` is still 2.263.0, which is the version the `^2.263.0` range in
  `infra/package.json` resolves to, so there is no release to take. The installed
  `node_modules/aws-cdk-lib/node_modules/brace-expansion` is still 5.0.8 and the committed
  lockfile still records that path as `"inBundle": true`. `npm audit --json` reports exactly one
  finding, this one, high, with that bundled path as its only node. The strongest evidence is
  npm's own refusal: `npm audit fix --dry-run` prints that 5.0.8 is a bundled dependency of
  `aws-cdk-lib@2.263.0` and that it cannot be fixed automatically, then advises checking for
  updates to `aws-cdk-lib`. Its summary line still says a fix is available, which is the
  `fixAvailable: true` field in the report and is wrong for a bundled path. Read the warnings, not
  the summary.
- **A release did land, 2026-08-10, and it still cannot be taken.** `npm view aws-cdk-lib version`
  now returns **2.264.0**, published **2026-08-10T17:58:12Z**, where the 2026-08-09 recheck above
  recorded 2.263.0 as newest. At the time of writing it is under two days old, inside the three day
  `min-release-age` cooldown, which expires **2026-08-13T17:58Z**. The cooldown is not bypassed to
  clear a finding faster, for the reason the superseded entry below already states.
- What the new release does and does not tell us, stated carefully because the tempting inference is
  wrong. Its declared `minimatch` range is unchanged at `^10.2.5` and `minimatch` is still listed in
  `bundleDependencies`. **Neither fact is evidence about the bundled brace-expansion either way.**
  The vulnerable copy sits under `minimatch` inside the tarball, so a rebuild can pick up 5.0.9
  without the declared range moving at all, and an unchanged range can equally sit over an unchanged
  bundle. The only way to know is to install it and read the `version` field of
  `node_modules/aws-cdk-lib/node_modules/brace-expansion/package.json`, which the cooldown forbids
  until the date above. Recorded here so the next session does not re-derive it, and does not read
  the unchanged range as a result.
- Re-checked 2026-08-16, during the scanner head-to-head fixes: the opportunistic check the bullet
  above anticipated has now been run. The cooldown had opened for 2.264.0, so it was installed in
  a worktree. `npm update aws-cdk-lib` resolved to 2.264.0 while correctly skipping 2.265.0
  (published 2026-08-13T19:54Z, still inside the cooldown at the time), and the `version` field of
  `node_modules/aws-cdk-lib/node_modules/brace-expansion/package.json` read **5.0.8**. `npm audit`
  still reported exactly this one HIGH on the same bundled path. So the release that landed cannot
  clear the finding, the lockfile was restored rather than bumped for nothing, and the
  unchanged-range caution above was right in the optimistic direction too: a rebuild CAN pick up a
  new bundle, and this one did not.
- Action, dated: re-check on or after **2026-08-20**, and record the outcome here either way.
  2.265.0 leaves the cooldown at **2026-08-16T19:54Z**, so by the recheck date it is installable
  and the same two-minute inspection answers whether its bundle moved to 5.0.9. Tightened from the
  2026-09-09 date the previous action set, because a concrete uninspected candidate now exists,
  and waiting a month past it would be a suppression wearing a schedule.

### CVE-2026-14257, brace-expansion 5.0.7, HIGH, bundled inside aws-cdk-lib, SUPERSEDED

Closed on 2026-08-04 by the upgrade described above. It sat under Open for as long as its
replacement on the same path was open, and moved to Closed with it on 2026-09-26. Read the two
entries together.

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

### GHSA-8j4g-w8fx-2239 and three more, hono, MODERATE and LOW

Closed 2026-08-08 by `npm install hono@4.12.34 -w @throughline/api`. The acceptance in
`scripts/accepted-advisories.json` was DELETED rather than extended, which the gate enforces anyway:
an acceptance matching nothing fails as `stale_acceptance`.

There is ONE copy of hono in the tree, hoisted, and `@hono/node-server@2.0.12` declares `hono: ^4`
and resolves to it. An earlier version of this line said the upgrade "resolved 4.12.34 for both the
direct dependency and the copy under `@hono/node-server`", which implied a nested install that does
not exist: `package-lock.json` has exactly one `node_modules/hono` entry. The effect is the same and
the description was wrong, which is the kind of sentence this file exists to keep honest.

The cooldown was checked rather than assumed, because the handoff that scheduled this work carried
an arithmetic error the time before. Read from the registry on 2026-08-08T10:57Z: 4.12.34 was
published 2026-08-03T02:36:40Z and `.npmrc` sets `min-release-age=3` days, so it cleared
2026-08-06T02:36Z. It was NOT bypassed.

- **`latest` was 4.13.1 by the time this ran, not 4.13.0 as the handoff said, and 4.13.1 was itself
  still inside the cooldown** (published 2026-08-07T06:45Z, clears 2026-08-10T06:45Z). Pinning
  4.12.34 was therefore both the smallest step that fixes the finding and the only installable one.
  This is the case the "pinned, never `@latest`" rule exists for.
- The upgrade closed THREE more hono advisories that had appeared since 2026-08-05 and were sitting
  below the gate's HIGH threshold as notes: `memo()` retaining SSR output across requests
  (MODERATE, cross-user data disclosure), the Proxy Helper not stripping headers named in
  `Connection` (LOW), and an algorithmic-complexity DoS in the Language middleware (MODERATE). None
  of those middlewares is imported here, but they are fixed rather than reasoned about now.
- **The `no-hono-cors-middleware` rule in `.dependency-cruiser.cjs` STAYS.** A matched allowlist is
  a stronger position than a patched reflector: `apps/api/src/http/cors.ts` matches an exact `Set`
  of origins with no regular expression in it, and without the rule the import returns the first
  time somebody reaches for the obvious middleware. The rule was proven failable by planting that
  import and watching it fire by name.

### GHSA-5p4m-2wfm-xmqj js-yaml HIGH and GHSA-2v37-7h3g-55p8 nanoid HIGH

Found 2026-08-08 by the advisories gate, NOT by the handoff, which knew about neither: both
advisories were published after the previous session ended, and both were unaccepted HIGHs, so
`gate:advisories` failed on three problems rather than the one that was expected. Closed the same
day by `npm update js-yaml nanoid`, resolved 4.3.1 and 3.3.17.

- Neither needed an `overrides` entry, checked before reaching for one: `astro@7.1.6` and
  `@astrojs/internal-helpers@0.10.2` both declare `js-yaml: ^4.3.0` and `postcss@8.5.25` declares
  `nanoid: ^3.3.16`, so the caret ranges already permitted the fixed versions and a lockfile update
  was enough. An override that duplicates a range the parent already allows is a permanent
  instruction recording a temporary fact.
- Cooldown checked for both: js-yaml 4.3.1 published 2026-07-31T17:39Z, nanoid 3.3.17 published
  2026-08-03T10:39Z. Both outside the three day window on 2026-08-08.
- Reachability, stated rather than implied: both are BUILD AND TEST tooling, neither is in the
  Lambda runtime path. js-yaml arrives through `astro`, so it runs when the site is built; nanoid
  arrives through `vitest -> vite -> postcss`, so it runs when the suite runs. That lowers the
  urgency and does not remove the finding, because both execute on a developer machine and in CI.
- **`npm install`'s own closing line said `found 0 vulnerabilities` while both were still installed
  and both still had open HIGH advisories.** That summary is not the gate and was not treated as
  one: `npm audit` run immediately afterwards reported all three. A zero from a command whose main
  job was something else is unknown, not clean.

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
  that a package is clean.
  Its reach is narrower than the sentence above sounds, and the narrower version is the true one.
  `min-release-age` governs RESOLUTION, so it applies to `npm install` and not to `npm ci`, which
  reads the lockfile. It also requires npm 11.10.0 or newer, where the key was introduced; an older
  npm ignores it in silence. The version is verified against the npm changelog. The silence was
  measured on npm 10.9.8 during review on 2026-08-04 (no warning for this key or for a deliberately
  nonsense one, exit 0 either way, while 11.14.1 does warn about the nonsense one) and is recorded
  as measured-once rather than reproducible here, since this machine runs 11.14.1. So on an old npm
  there is nothing at all to notice, which is worse than a warning and is why `engines.npm` names
  the version that makes the setting real. CI runs `npm ci` on the Node 22 line, which bundles
  npm 10.9.x, so the cooldown does nothing there and never did. What actually protects CI is the
  committed lockfile plus `npm run gate:advisories`. An earlier version of this section claimed the
  cooldown covered CI, which was the same shape of error as the one that put it in this file to
  begin with.
- A zero finding result is only reported as clean when the scan is confirmed to have run. A scan
  that produced no output is UNKNOWN. The advisory gate exits 2, distinct from both clean and
  failing, in six situations: it cannot reach the registry; npm reports a failure rather than a
  report, such as a missing lockfile; the acceptance list is malformed; the audit report announces
  a schema version this gate has not been taught to read; the tree it audited has no dependencies
  at all; and npm's own summary counts vulnerabilities the gate could read none of. The last four
  were added after reviews measured the gate printing "clean (0 finding(s))" against an empty tree
  and against a report whose shape had drifted. Extracting nothing and there being nothing were the
  same value, which is precisely the failure this project exists to argue against, committed by the
  component built to catch it.
- The `.npmrc` secret rule detects an enumerated list of npm config keys plus credentials embedded
  in a URL. It is a floor, not a proof, and the list has been wrong twice: `key` holds an inline PEM
  private key rather than a path, and `password` holds a plaintext password while its underscore
  sibling was caught all along. Both were found by review, one round apart, each time next to a
  comment asserting the enumeration was complete. It is now tested from both directions, twenty
  lines that must fail the build and thirty-two that must not, in `scripts/test/tracked-files.test.mjs`.
