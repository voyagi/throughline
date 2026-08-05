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
| Duplicated logic | `npm run gate:dup` | YES | Fired on a real clone rather than a planted one: nine lines of channel wiring copied out of `verify-mcp.ts` into a new `measure-freshness.ts`. The threshold is 0, so one clone is enough. Fixed by extracting `apps/api/src/cli/live-channels.ts` |
| Cross-browser compat | `npm run lint` | NO | No client code yet |
| Bundle size | `npm run gate:size` | NO | No built bundle yet |
| Tracked-file check | `npm run gate:artifacts` | YES | Caught a really tracked `.build-lane` on live data, exit 1, and reports UNKNOWN with exit 2 against an empty index |
| `.npmrc` credential rule | `npm run gate:artifacts` | YES | A planted `//registry.npmjs.org/:_authToken=` line, exit 1, naming file and line without printing the value |
| Dependency advisories | `npm run gate:advisories` | YES | A removed acceptance for a live HIGH, exit 1. Also exit 2 against a tree with no dependencies, and it prints a verdict through a junction where it used to print nothing at all |
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

### The verification channel: fourteen mutations, fifteen protections

Same method, run against the sweep that closed the review findings PR #7 left open. Each defect was
put BACK into the source, the whole suite was run, and the failures were recorded before restoring.

The two counts differ on purpose and the difference is not a rounding error: fourteen defects were
put back, and one of them is named by two separate tests, so fifteen protections are listed below.
Eleven of the fourteen killed exactly one test. The other three killed their own test and siblings
that share the same guard, noted rather than tidied away, because a mutation with a wider blast
radius than the finding it stands for is a weaker proof of that finding, not a stronger one.

- The handshake classifying a server failure instead of carrying on (2 red).
- The handshake refusing a response that carries neither a result nor an error.
- `observationsFrom` reporting an unreadable embedding flag instead of dropping it.
- The live-proof cleanup reporting a failed DELETE instead of swallowing it.
- The schema rule staying identical across its two consumers, which fails on drift in either
  direction rather than only the direction someone thought of.
- `elapsedMs` coming from the injected clock (2 red, both about that clock).
- The default cluster scope being `argument`.
- The protocol version being the one the SERVER named.
- A server REQUEST sharing our id not being read as our answer (3 red: the mutation also breaks
  notification skipping, so only the new test names the collision itself).
- The unattributable-failure latitude staying at `id: null` and not widening to a missing id.
- The re-handshake numbering past the call that failed.
- The foreign-rows hazard being explained only where a foreign message arrived.
- The content-difference message saying "unknown" rather than printing `undefined`.
- The non-object guard in `answersRequest`.
- The SSE boundary staying one character wider than the specification.

A sixteenth protection is structural rather than tested: `exchange` derives "expects an answer"
from whether the body carries an id, so a request that waits for an answer with no id to recognise
it by cannot be constructed. Breaking the derivation turns 17 tests red, which shows it is load
bearing; no test can show the unrepresentable state, because it is unrepresentable.

### And five more, from the review of that sweep

The review planted 21 mutants of its own and killed all 21. It also found two protections that were
claimed and not pinned, and one comment that was measurably false. The fixes for those were put
through the same mutation pass:

- The cleanup surviving a reporter that throws. This one matters more than it sounds: every caller
  runs the cleanup inside a `finally`, so an exception there skips the `await db.close()` on the
  next line, the pool stays open, and the script hangs rather than exits.
- The default reporter writing to `console.warn`, which was the only uncovered function in that
  file and therefore the one path where a live proof's cleanup could go quiet unnoticed.
- A failed handshake leaving the client with no session. The review's mutant, `handshakeComplete =
  true` inserted before the check, SURVIVED the original test: the first call still threw, so the
  test stayed green, while a second call skipped the handshake and put a tool call on a session
  that was never established. Killed now by asserting the second call re-handshakes.
- The handshake refusal being described in the handshake's own words rather than in a sentence
  `classifyServerMessage` measured on a `tools/call`.
- The SSE whitespace latitude, in the shape that separates it from the specification.

The last one is worth reading in the source. The comment justifying that latitude claimed both
readings fail closed, and the review disproved it by execution: one event carrying a complete
document, a whitespace-only line, then garbage, is returned as an answer here and reported as
unread by a conformant reader. The behaviour was kept, because it is bounded by the id check and
because changing this transport is how two fail-open defects were introduced here before. The
false justification was not kept.

#### One mutation scored UNKNOWN before it scored anything

The first attempt at the cleanup mutant left a dangling `catch`, so the module never parsed, the
cleanup suite never ran, and the harness printed "nothing red" while judging nothing. It ran 427
tests where the baseline is 495 and nothing in the output said so. Mutation runs are now read
against the baseline COUNT, never against the absence of failures, which is the same rule this
repository applies to every other check that can return zero results for two different reasons.

### The agent loop: seven mutations against the absence controls

The agent must be structurally unable to report an absence it did not establish, and three
independent controls are claimed for that. Each was removed on its own, the whole suite was run,
the failures were recorded, and the tree was restored and confirmed clean before the next one. The
baseline is 605 tests across 19 files, and every one of the seven runs also collected 605, which is
the only reason the red counts below mean anything.

Seven bullets follow, one per mutation, counted from the list itself.

- Control 1, ordering: the coverage verdict pushed second instead of first (4 red). Three are the
  tests that read line one under each verdict. The fourth is the offline end-to-end run, because
  the local model reads the verdict off that first line too, which is real coupling and is left
  visible here rather than hidden behind a tidier mutation.
- Control 1, withholding: the early return deleted, so a failed recall renders its memories anyway
  (2 red, exactly the two tests written for it).
- Control 2: `worseOf` replaced by last-verdict-wins (1 red, exactly its own test). The pair that
  runs COVERED then UNKNOWN still passes under this mutation, which is the point of testing both
  orderings: only UNKNOWN then COVERED can tell the two rules apart.
- Control 3: `judgeAnswer` permitting every answer (11 red). The widest blast radius here, and the
  honest reading is that control 3 is load bearing across the whole suite rather than that this
  mutation is a sharper proof than the others.
- A failed recall no longer degrading the turn to UNKNOWN (2 red). This is the fail-open hole that
  reading the loop against the real repository turned up: a turn that recalled once COVERED and
  then threw kept COVERED, and the absence claim was permitted on a search that had broken.
- `worseOf` losing its allowlist, so an unrecognised verdict scores -1 through `indexOf` and is
  silently dropped (3 red).
- The refusal pushed back as a `tool_result` carrying an id no `tool_call` announced (4 red). One
  is the structural test that no tool result answers an unannounced id; the others follow because
  the local model keys its correction on seeing a refusal turn.

Not proven by mutation, and said plainly rather than counted in: the `CoverageUnknownError` arm in
`runTool`. `createRepository` does not throw it, because `runRecall` catches an embedder failure, a
failed count query, a failed candidate query and an unscoreable row and returns an UNKNOWN receipt
for each. The arm is exercised by a throwing double and refines the message only. What sets
coverage on that path is the recall-failed rule above, which is the fifth bullet and is mutation
proven.

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

`scripts/check-tracked-files.mjs` compares tracked PATHS against a fixed list, and reads the content
of exactly one kind of file. Green means "no path on the list is tracked, and no tracked `.npmrc`
carries one of the NAMED auth keys or a credential embedded in a URL".

### A gate that tests for secrets must not look like it contains them

GitGuardian failed PR #6 on two lines of `scripts/test/tracked-files.test.mjs`: a Basic Auth String
and a Generic Password. Both were fixtures, deliberately fake, proving the rule above catches those
exact shapes. The scanner was still right to fire. A `user:password@host` string in committed source
is precisely what it exists to stop, and "it is a test fixture" is something only a reader knows.

Two tempting responses were rejected. Adding an exclusion for that path would also hide a real
secret pasted there later. Splitting the literal so the detector cannot match it is the same evasion
in better clothes, in a repository whose argument is that you do not route around a security control
because you personally are confident.

What changed was the VALUES, and explaining why that is safe took five attempts, four of which were
wrong. That is worth more than the explanation itself, so here is the failure mode.

Each wrong version described the regexes as if reading them told you what they do. They said things
like "the rule matches on the key, never on what follows the equals", which sounds precise and is
the wrong axis entirely. **Neither rule is a parser.** Both are line-shape heuristics approximating
npm's ini syntax, and every place the approximation differs from npm is a gap by construction.

Nine gaps have been found and closed, each after a comment claimed the enumeration was finished:

- the bare `key` and `password` config names, which hold an inline PEM and a plaintext password and
  have no leading underscore,
- whitespace around the equals, which npm accepts and one rule handled while the other did not,
- a quoted value, which is the form `npm config list` PRINTS, so pasting npm's own output produced
  exactly the shape the gate could not see,
- a quoted key and ini array syntax, both of which npm resolves normally, and a doubled `##` marker,
  which it does not. All three defeated both rules,
- an EMPTY USERNAME in the URL form, `https://:TOKEN@host/`, which is the canonical way to put a
  bare token in a registry URL and was therefore the likeliest real leak of the lot,
- a scheme containing a plus, `git+https://` and `git+ssh://`, both ordinary npm registry values.

Every one was found by checking what npm ACCEPTS, never by rereading the regex, and the last three
only by running a differential against npm's own parser and its own redactor. So the rule for
editing these is: change them only against npm's parser, and add a fixture in both directions.

Comment lines are scanned, and the reason is not that npm honours them. It does not: its ini skips
any line starting `#` or `;`, singly or doubled, so a commented assignment configures nothing. They
are scanned because a commented-out token is still a committed token. The marker stops npm, and
does not stop whoever reads the repository.

Closing the whitespace gap introduced quadratic backtracking in the gate itself, measured at 37
seconds for a 200,000 character line. Bounding the key to one-or-more brings that to 0.76
milliseconds.

The mechanism is worth getting right, because the plausible-sounding version is wrong and the wrong
version is a trap. The key class holds no whitespace, so the key never competes for a run of spaces.
What competes is the leading whitespace and the whitespace before the equals, and a NULLABLE key is
what lets them share one run: with a star the key can match empty at every split point, and the
second run may also stop short rather than take the remainder, so the two divide the input in
quadratically many ways. The plus removes that by making the key unable to match empty, not by
bounding its length.

**That distinction matters for the next person who touches this.** The obvious way to close the
first divergence listed below, a key containing whitespace, is to add `\s` to the key class and keep
the plus. That is far worse than the problem the trade avoids: measured at 138 seconds for an 8,000
character line, against 37 seconds for 200,000. Three whitespace-capable quantifiers in a row is
cubic. Closing that gap needs a different shape and a timing measurement beside it.

**That bound costs coverage, and an earlier version of this paragraph claimed it did not.** It loses
the empty-key form, ` = https://user:token@host/`, which npm parses to the key `""` and resolves.
That is a deliberate trade: the alternative is a build gate one long line can stall. It is listed
below and pinned by a test that states why it is open, so closing it means deleting a test that
argues against you.

**The list of remaining differences is OPEN, and that is the most important sentence here.** Every
previous version of this section enumerated the gaps as though the enumeration were finished, and
every one of those versions was wrong within a day. Three more forms were found after the list
itself became the claim. What follows is the gaps somebody has looked for, not the gaps there are.

The key character class is a family rather than an item: the rules match `[\w@/:.-]` on the key
side, and npm's ini accepts a key containing anything else, whitespace and every one of
`% + ~ ! , * $ & ( ) ' \ [ ] { } ^ | < > ?` and tab among them. Widening it is not obviously right,
because the key side is also what stops the rule firing on ordinary prose, so it is left open rather
than guessed at. The empty key is the other, described above.

"A value split across lines" was listed here and is not a divergence at all, and the reason first
given for that was also wrong. npm's ini has no line continuation, so such a value parses as two
keys and npm does not reconstitute the URL either. There is no credential for it to resolve.

The 81 tests passed unchanged when only the fixture values moved, which is the proof those values
were never load-bearing. The count is higher now because closing the gaps added its own fixtures.

The general rule for this repo: a fixture that has to look like a real credential to test something
is a sign the rule under test is matching the wrong thing. And a permanently red secret scanner is
worse than no scanner, because it teaches everyone to scroll past the one that matters.

### The green result is narrower than it sounds, and the wording is on its third attempt

That phrasing is deliberate and it is the third attempt at it. It is narrower than "no tracked
`.npmrc` carries a credential", which is what this said until a review proved otherwise: npm's `key`
holds an inline PEM private key rather than a path, the rule named only the underscore-prefixed keys
and `key` has no underscore, and a tracked `.npmrc` carrying a private key made this gate print
`clean` and exit 0. The near-miss is worth keeping in mind. The comment excluding `certfile` and
`keyfile` as "a path, not a secret" was correct about those two and landed one character from the
inline siblings that are the secret itself. Detection by an enumerated list is a floor, and the
floor should be described as a floor.

That one content rule exists because `.npmrc` is deliberately tracked, so the supply chain cooldown
travels with the repository instead of living on one laptop. It is the only file here whose format
holds both ordinary configuration and registry credentials, and no path rule can tell those apart.
Every tracked `.npmrc` at any depth is read, comment lines included, because a commented-out token
is still a committed token: the `#` stops npm and stops nothing else. Proven failable on a planted
`_authToken` line, and the failure names the file and line without printing the value.

It replaced a larger content-scanning gate that was carried in from elsewhere. That gate reported
this repo clean while four of its own files named unrelated private projects, because its content
rules excluded `.mjs` and `.ts` from scanning. A gate that cannot see itself is worse than a small
one that states its limits, so the four files were removed and this was written in their place. The
accessibility gates that came in with them will return in a form written for this repo when there is
a built site to audit.

## Why the duplication gate ignores the design mockups

`design/mockups/*.html` is excluded from jscpd. The exclusion is deliberate, it is as narrow as it
can be, and it is the only exclusion in this repo that was added to let a commit through, so it gets
written down rather than buried in a config diff.

The five mockups are standalone files opened directly in a browser with no template engine and no
build step. Each one therefore repeats the page chrome: the header, the sheet index, the annunciator
rail. jscpd measured 7 clones and 7.5 percent duplicated markup, essentially all of it that chrome.
There is no way to remove it without giving the mockups a build step, and a build step would make
them worse at the one job they have, which is to be opened and looked at.

Being exact about what the 7 clones are, because "it is all chrome" was the first draft of this
paragraph and it was not true: 3 of the 7 are the header, index and annunciator, and the other 4,
about 55 percent of the duplicated tokens, are the same demonstration strips repeated across pages.
A build step would fix the first group and not the second, since the same strip genuinely appears
on more than one page on purpose. Both kinds of repetition are properties of standalone mockups,
but only one of them is the kind a template would remove.

The exclusion covers the HTML only. `design/mockups/board.css`, which is the shared part and the
part where real duplication would matter, stays inside the gate and reports zero clones.

This exclusion expires on its own. When the site is built as components the chrome becomes one
component, the mockups stop being the source of truth for layout, and the pattern the gate was
complaining about stops existing. If these files are still here and still excluded when the built
site ships, that is a leftover, not a decision.

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

Three things run only against a live cluster and are deliberately outside `npm run gate`, because a
gate that cannot run offline is a gate people learn to skip:

```bash
npm run verify:live              # the memory layer, end to end on real rows
npm run verify:mcp               # the verification channel, 29 asserted checks
npm run measure:freshness -- 25  # how long a written row can stay invisible to that channel
```

The third one exists because a sentence in `mcp-verifier.ts` calls an absent row a FINDING rather
than a replication artifact, and that is the most alarming thing the component can say. It rested
on a single 436 ms sample, which rules out the multi-second window it was aimed at and says nothing
about a shorter one. Re-measure rather than re-argue: a trial that ever needs a second read is the
result that changes the code.

`verify:ship` is the only acceptable evidence that this repo is clean at ship time. A sentence
saying so is not evidence.
