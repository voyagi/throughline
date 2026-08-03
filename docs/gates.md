# Quality gates, and which of them have actually been seen to fail

A gate that has never failed is indistinguishable from a repo with nothing to catch. This file
records, per rule, whether it has been PROVEN by planting a violation and watching it fire, or
whether it is merely configured. Configured is not proven, and the difference is not cosmetic:
three rules in this repo were configured, reported clean, and were protecting nothing.

Re-prove after changing a rule. Delete nothing from the "found by proving" section, because those
are the reasons this discipline pays.

## Status

| Gate | Command | Proven failable | How |
|---|---|---|---|
| Cyclomatic complexity | `npm run gate:complexity` | YES | A 28-branch function. Fired at 28 against the budget of 25 |
| Cognitive complexity | `npm run gate:complexity` | YES | Same function. Fired at 27 against 25 |
| `memory-core-has-no-web-framework` | `npm run gate:deps` | YES | A `hono` import inside `packages/memory`, both hoisted and nested |
| `memory-core-is-independent` | `npm run gate:deps` | YES | A source file planted in `apps/api/src` and imported from the memory core |
| `browser-code-stays-in-the-browser` | `npm run gate:deps` | YES | A planted `apps/web/src/islands` file importing the api |
| `browser-code-has-no-node-builtins` | `npm run gate:deps` | YES | A Node builtin import from a planted island |
| `infra-describes-does-not-run` | `npm run gate:deps` | YES | A planted `infra/` file importing application code |
| `not-to-unresolvable` | `npm run gate:deps` | YES | A deliberately mistyped import |
| `no-circular` | `npm run gate:deps` | YES | A two-file cycle |
| Duplicated logic | `npm run gate:dup` | NO | Currently reports 0 clones. Prove with a pasted block |
| Cross-browser compat | `npm run lint` | NO | No client code yet |
| Bundle size | `npm run gate:size` | NO | No built bundle yet |
| Tracked-file check | `npm run gate:artifacts` | YES | Caught a really tracked `.build-lane` on live data, exit 1, and reports UNKNOWN with exit 2 against an empty index |
| Test suite | `npm test` | YES | Nine separate protections were deleted one at a time and every one went red. See below |

## Protections with a test that goes red when the protection is deleted

Verified by mutation rather than asserted: each protection was removed in a copy of the package and
the suite was re-run. All nine went red.

- The grace window in `planEviction`, checked BEFORE the score.
- The shortfall flag, which is what stops a fully blocked eviction run reporting success.
- The throw in `assertAnswerable`.
- Failure outranking a truncated search in `decideCoverage`.
- The final `clamp` in `scoreMemory`.
- Exponential rather than linear decay in `freshness`.
- The relative weighting of confirmation against contradiction.
- The cosine remap in `cosineSimilarity`.
- `describeCoverage` refusing to say "found nothing" under UNKNOWN coverage.

## Found by proving, not by reading

Three rules were configured, green, and useless. None would have been noticed without planting a
violation, and the first two were fixed and then found to still be wrong.

1. **The build-output exclude was eating half the dependency graph.** The obvious pattern,
   `(^|/)(dist|cdk.out|.astro|coverage)/`, also matches `node_modules/hono/dist/cjs/index.js`. Every
   npm package that ships from a `dist` folder was excluded from the graph entirely, so the rule
   forbidding web frameworks inside the memory core could never fire. The exclude is now anchored to
   this repo's own directories.

2. **`dependencyTypes: ['npm']` skipped the worst case.** An import of a package that is not in the
   importing workspace's `package.json` resolves as `npm-no-pkg`, not `npm`. That is precisely the
   violation worth catching, and the narrower filter excluded it.

3. **`^node_modules/` only matched hoisted installs.** After fixing 1 and 2, the rule still missed a
   package installed into a workspace's own `node_modules` rather than hoisted to the root. Caught by
   planting `packages/memory/node_modules/hono` and watching the "fixed" rule report clean. Now
   `(^|/)node_modules/`.

4. **The forbidden-path check only matched at the repository root.** A tracked `apps/api/.env`, a
   tracked `packages/memory/.claude/settings.json` and a tracked `docs/CLAUDE.md` all reported clean
   with exit 0, which made the only mechanical gate strictly narrower than the `.gitignore` sitting
   next to it. Depth is exactly where a real leak turns up, because nobody puts the second copy at
   the root. Matching is now at any depth, and `git ls-files` is run from the repository root with
   `--full-name`, because it is otherwise relative to the current directory: from a subdirectory it
   listed one file, reported clean, and the non-empty list sailed straight past the empty-index
   guard that was supposed to catch exactly that.

5. **A package-name alternation matched `react` and missed `react-dom`.** Same class as 2 and 3: a
   pattern that looks exhaustive and is not.

A milder one: dependency-cruiser refuses a regex it judges slow, so a negative lookahead
containing `.*` fails the whole run rather than silently doing nothing. That failure mode is fine,
because it is loud.

Every one of these was found by an adversarial review that ran the gates and planted violations
rather than reading them. Two review passes were run before the first push, and the second pass
existed because the fixes from the first were themselves unexamined code.

## Why the tracked-file check is narrower than it looks

`scripts/check-tracked-files.mjs` compares tracked PATHS against a fixed list. It does not read file
content and it does not guess. Green means "no path on the list is tracked", which is narrower than
"this repo leaks nothing", and the script says so in its own header.

It replaced a larger content-scanning gate that was carried in from elsewhere. That gate reported
this repo clean while four of its own files named unrelated private projects, because its content
rules excluded `.mjs` and `.ts` from scanning. A gate that cannot see itself is worse than a small
one that states its limits, so the four files were removed and this was written in their place. The
accessibility gates that came in with them will return in a form written for this repo when there is
a built site to audit.

## Regenerating the lockfile

Deleting `package-lock.json` on its own is NOT a clean regeneration, and the result passes locally
while failing every Linux CI run.

npm reuses whatever is already in `node_modules`, so it records only the platform binding that
happens to be installed. A lockfile regenerated that way on Windows carried
`@astrojs/compiler-binding-win32-x64-msvc` and none of the other eight platforms, and CI died on
`Cannot find module '@astrojs/compiler-binding-linux-x64-gnu'`. The tell is a second package in the
same lockfile carrying all of its variants: `lightningcss` had all fourteen, which is what made the
single-variant entry obviously wrong rather than obviously normal.

Two things that did NOT fix it, both measured: `npm install --package-lock-only --os=linux
--cpu=x64` reported "up to date" and changed nothing, and removing only the offending scope
resolved a different dependency tree and broke the build locally as well.

Remove `node_modules` AND the lockfile, then install. CI is the backstop that catches this, and it
did; no extra gate was added, because a check that duplicates CI is machinery with no new coverage.

## Running them

```bash
npm run gate           # types, complexity, duplication, boundaries, tracked files
npm run verify:ship    # the full surface, each step printing its own exit code
```

`verify:ship` is the only acceptable evidence that this repo is clean at ship time. A sentence
saying so is not evidence.
