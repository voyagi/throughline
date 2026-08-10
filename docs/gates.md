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
| `no-hono-cors-middleware` | `npm run gate:deps` | YES | A planted `import { cors } from 'hono/cors'`, which fired the rule BY NAME. The first attempt fired `not-to-unresolvable` instead, because the resolver was not reading package exports maps, so the middleware resolved to no path and a path rule had nothing to match. See below |
| Duplicated logic | `npm run gate:dup` | YES | Fired on a real clone rather than a planted one: nine lines of channel wiring copied out of `verify-mcp.ts` into a new `measure-freshness.ts`. The threshold is 0, so one clone is enough. Fixed by extracting `apps/api/src/cli/live-channels.ts` |
| Cross-browser compat | `npm run lint` | YES | Client code now EXISTS (`apps/web/src/islands`), so the "no client code yet" that used to sit here is false. A review then falsified the replacement too: it fires, reproduced with a planted `navigator.getBattery()` reported unsupported in Safari 26.3 and iOS Safari 18.5-18.7, exit 1. Two wrong claims in one row, one after the other, which is why the third one names its repro |
| Bundle size | `npm run gate:size` | NO | A built bundle now EXISTS (`apps/web/dist/_astro`), so the "no built bundle yet" that used to sit here is false. `size-limit` is installed and `gate:size` is in NO chain: not in `gate`, not in `verify:ship`. A budget nobody runs is not a budget |
| Colour contrast | `npm run gate:contrast` | YES | A darkened `--unlit` token, reported as `2.12:1 is below AA 4.5:1`, exit 1 |
| Page accessibility | `npm run gate:a11y` | YES | `h1` changed to `p`, reported as `2.4.6 expected exactly one <h1>, found 0` on all five pages, exit 1. An independent pass planted eleven violations covering all seven rules and each was reported by name |
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

### The agent loop: thirteen mutations against the absence controls

The agent must be structurally unable to report an absence it did not establish, and three
independent controls are claimed for that. Each protection was removed on its own, the whole suite
was run, the failures were recorded, and the tree was restored and confirmed clean before the next
one.

**Measured at commit `da283fe`, baseline 736 tests across 21 files.** Every one of the thirteen runs
also collected 736, which is the only reason the red counts below mean anything. Each mutation was
applied by a harness that REFUSES to run unless it changed exactly the line it names, because a
mutation that silently failed to apply scores a green run against unmutated code, which is how this
section once published a count for a tree nobody had mutated.

This is the fourth measurement of this set. The first ran at 605 and published a count that
described the wrong mutation, the second ran at 627 and was overtaken before anyone read it, the
third ran at 652 and was overtaken the same way. This one was taken LAST, after the HTTP surface
landed, rather than first: re-measuring before the unit would have invalidated it a fourth time by
the exact mechanism this paragraph describes.

TWELVE OF THE THIRTEEN COUNTS ARE UNCHANGED from 652 to 736, which is worth more than it looks: the
suite grew by 84 tests and the blast radius of every one of these mutations stayed exactly where it
was, so the new tests neither cover this area nor mask it.

**The thirteenth changed, from 2 red to 1, and the cause is measured rather than guessed.** At
`01bfe35` the matcher was `\b(?:...)` with NO trailing boundary, verified by reading that commit.
So the prefix stem really did eat "no memory limit", the negative control for RAM fired, and 2 was
correct for that tree. The trailing boundary landed in the round-four fix, so a stem followed by a
word character can no longer match at all, and that control can no longer fire. The one red left is
`catches "There were no memories about checkout."`, named rather than counted. A wider variant of
the same mutation, `memories` to `memor` at all four occurrences in the phrase list rather than one,
was run to check that the drop was not the mutation being applied too narrowly: it rewrites all four
occurrences of the word in that block, of which three are phrases and the fourth is a comment, and
it scores 4 red with the RAM control green in that run too. A mutation count is a statement about ONE tree, and this
is what that sentence costs when it is true.

The rule for
reading it: a commit that touches only documentation leaves these standing, and a commit that
changes any file the suite loads makes them unverified until re-run. That set is `packages/*/src`,
`apps/*/src`, `scripts/lib`, and every directory named in `vitest.config.ts` `test.include`. It read
`apps/api/src` until a fourth reading found the same omission this section has already recorded
twice: `apps/web/test/api-shape.test.ts` imports `../src/scripts/api.ts` and `../src/scripts/shapes.ts`
directly, so the suite loads `apps/web/src` and a change there is a change the counts cannot survive.

**ALL THIRTEEN ARE UNVERIFIED AS OF 2026-08-10, BY THE RULE DIRECTLY ABOVE.** The work that landed
as `f185b4b` changes FIVE groups in that set, counted with `git diff --name-only ae8bd70 f185b4b`:
one file in `apps/api/src`, one in `packages/contract/src`, five under `apps/api/test`, five under
`apps/web/test` and six under `apps/web/src`. THE REF IS A MERGED SHA AND NOT `HEAD` ON PURPOSE:
the previous version counted against `ae8bd70..HEAD` while HEAD was still moving, and its last two
figures were four and five, correct when written and false two commits later when the same branch
touched `presentation.ts` and `presentation.test.ts`. A count against a moving ref cannot be
re-derived by a reader, which is the whole failure this section keeps recording. This paragraph has
now been written four times: it named three groups, then four, then five with two of the per-group
figures already stale. In a section whose own text says the set has been got wrong three times, once
for omitting a directory, that is the same failure again, one level down: the rule fired on the
document that states it, and nobody re-derived it. Saying so here is the
point of writing the rule down: the counts stop being readable as current the moment something in
that set moves, and nothing else in this repository would have told a reader that. They are left
standing rather than deleted, because a measurement that says when it went stale is worth more than
no measurement at all, and re-running thirteen mutations is a unit of its own rather than a line in
somebody else's.

It is written out here, maintenance cost and all, because it has now been got wrong THREE times and
the third attempt was the instruction to derive it. First it was `apps/api/src/agent/**`. Then it
was `packages/*/src` plus `apps/api/src` plus their tests, which omitted `scripts/test` entirely.
Then it was "read that set off `vitest.config.ts`", and that file does not carry the answer: it
lists three TEST globs and a coverage include, and it names `scripts/lib` nowhere, while
`scripts/test/tracked-files.test.mjs` and `scripts/test/check-advisories.test.mjs` both import from
it. A reader following that instruction reproduces the exact omission it was written to fix, which
is worse than the omission, because it looks like a method. `scripts/test` and the `scripts/lib`
modules it imports account for 146 of the 736, measured with `npx vitest run scripts/test` rather
than inferred, and unchanged across every baseline this section has recorded because nothing under
`scripts/` has moved since `01bfe35`.

### How a citation is written, since three rounds have now closed the same category

A CITATION NAMES A FILE AND AN IDENTIFIER, NOT A LINE, and this is written down once here rather
than argued again in each file that carries one. A file and an identifier survive an edit to the
file; a line number has no mechanism keeping it true, and every round that swept them found the
sweep itself had a blind spot. One commit re-derived twenty numbers in a guard module and left three
in the guard's own TEST file. The next closed every `Console.tsx:NNN` in the repository and left two
bare `:NNN` continuations, which its verification grep could not match, and one of those was stale
by 52 lines.

Two forms are allowed, and nothing else:

- name the reader, as in "`freshness.toFixed` inside `ArchiveStrip`", which is what a reader greps
  for anyway,
- or anchor the number to a NAMED COMMIT THAT IS AN ANCESTOR OF `main`, as
  `apps/api/test/turn-coherence.ts` does with `read at f185b4b`, so any clone can resolve it.

THE ANCESTOR HALF IS NOT PEDANTRY, and this rule had to learn it on its own exemplar. That anchor
read `de773d8` for two commits, which is a MID-BRANCH commit of PR #18, the second of the five
`gh pr view 18 --json commits` lists. `git merge-base --is-ancestor de773d8 origin/main` FAILS, so the sha
resolves only in a clone that still has the branch, and it resolves here today purely because a
stale local branch has not been deleted yet. The twenty numbers it vouched for were correct the
entire time, which is what makes this the quiet failure rather than the loud one: an anchored
citation looks more rigorous than a bare number and can be less useful. A squash merge leaves EVERY
branch commit unreachable and not merely the tip, and a squash merge is exactly when somebody is
most likely to write one down. The merged equivalent is `f185b4b`, and
`git diff de773d8 f185b4b -- apps/api/src/agent/loop.ts` is empty.

(THAT SENTENCE CALLED `de773d8` "the pre-squash tip" for one commit, in three files at once, and a
review checked it against `gh pr view 18`: the tip was `9f453b4`. The evidence that falsified the
claim was one command away and the claim was written without running it. The correction also makes
the rule stronger, because the reason an anchor dies is not that it was a tip.

BOTH REFERENCES HERE NAMED A LOCAL TAG UNTIL A SWEEP CAUGHT THEM, which is the same defect one turn
later and in the paragraph introducing the rule. `git ls-remote --tags origin` is EMPTY: those tags
were never pushed, so a tag-relative name resolves in exactly one clone on earth and is strictly
worse than the sha it was decorating. If a citation needs a name a reader can resolve, the only
safe ones are a sha that is an ancestor of `main`, an identifier, or a command they can run.)

A count in prose is a citation too: name what it EXCLUDES ("seventeen of eighteen, every one but
`createdAt`") or state the method that reproduces it, so the reader can re-derive it instead of
trusting it. A figure whose stated method returns a different number is worse than no figure.

THE REPOSITORY DOES NOT YET MEET THE ANCESTOR HALF, and saying so is the point of writing the rule
down. THE METHOD IS EVERY HEX TOKEN THAT RESOLVES TO A COMMIT, backticked or not, which is the whole
correction: take every `[0-9a-f]{7,40}` token in tracked files, keep the ones
`git rev-parse --verify <token>^{commit}` accepts, and test each with
`git merge-base --is-ancestor <token> origin/main`. Measured on THIS commit, which is unmerged and
therefore has no ancestor sha of its own to be anchored to: THIRTEEN shas are cited and NINE are not
ancestors.

ONE of the nine is `de773d8`, quoted in this file, in `apps/api/test/turn-coherence.ts` and in
`apps/api/test/turn-coherence.test.ts` as the specimen that taught the rule rather than as a live
anchor. The remaining EIGHT are pre-existing and are a unit of their own:

- `6c8162d` and `766e3b3` sit on the undeleted local branch `fix/status-hour-and-turn-coherence`, in
  `apps/api/test/turn-coherence.test.ts` (`766e3b3` also in `apps/web/test/status-island.test.ts`);
- `01bfe35` and `da283fe` in this file, `694957e` in `apps/api/test/server.test.ts`, and `13f5429`,
  `a4fa1df` and `5a19e33` in `apps/web/test/archive-island.test.ts`, are reachable from NO ref at
  all. `git name-rev` returns `undefined` for every one of them. They survive in this clone only as
  unreferenced objects held by the reflog, and one `git gc` makes them unresolvable even here, which
  is a sharper deadline than a branch nobody has deleted.

Most of them cannot simply be re-anchored. `01bfe35` is cited for what that specific tree CONTAINED,
so moving its anchor would falsify the sentence rather than repair it. Each needs its measurement
re-checked against the merged tree first, which is why this is a unit and not a sweep.

THE FIRST VERSION OF THIS CENSUS SAID ELEVEN, SEVEN AND SIX, because it matched only BACKTICKED
shas. `a4fa1df` and `5a19e33` are written bare, six times across four lines in
`apps/web/test/archive-island.test.ts`, in a table whose own header says every cell names the commit
it was measured at. They are live anchors and the sweep could not see them. That is the identical
blind spot this section records three paragraphs above for bare `:NNN` continuations: a sweep scoped
to a FORMAT rather than to a MEANING closes the instances it can match and reports the category
closed. Scope a sweep to what a thing IS, never to how it happens to be typed.

Thirteen bullets follow, one per mutation, counted from the list itself.

- Control 1, ordering: the coverage verdict pushed second instead of first (5 red). Most are the
  tests that read line one under each verdict. One is the offline end-to-end run, because the local
  model reads the verdict off that first line too, which is real coupling and is left visible here
  rather than hidden behind a tidier mutation.
- Control 1, withholding: the early return deleted, so a failed recall renders its memories anyway
  (2 red, exactly the two tests written for it).
- Control 2, at the CALL SITE: `worseOf(worstCoverage, ...)` in `runAgentTurn` replaced by
  last-verdict-wins (1 red). Naming the call site matters, and the first version of this bullet did
  not. Mutating `worseOf` ITSELF to last-wins is a different mutation with a different blast radius,
  because `worseOf` has unit tests of its own that this one leaves green. The single red is the loop
  test that recalls UNKNOWN and then COVERED; the reverse ordering still passes under the mutation,
  which is exactly why both orderings are tested.
- Control 3: `judgeAnswer` permitting every answer (13 red). The widest blast radius here, and the
  honest reading is that control 3 is load bearing across the whole suite rather than that this
  mutation is a sharper proof than the others.
- A failed recall no longer degrading the turn to UNKNOWN (2 red). The fail-open hole that reading
  the loop against the real repository turned up: a turn that recalled once COVERED and then threw
  kept COVERED, and the absence claim was permitted on a search that had broken.
- `worseOf` losing its allowlist, so an unrecognised verdict scores -1 through `indexOf` and is
  silently dropped (3 red).
- The refusal pushed back as a `tool_result` carrying an id no `tool_call` announced (6 red).
- An empty PARTIAL recall described as "a real absence" again (2 red). A cut-short search that
  returned nothing has established nothing, and saying otherwise invited the exact claim control 3
  then refuses.
- The record-format flattening removed, so a memory's stored content can forge an `id` or
  `asserted by` line of its own (3 red).
- The budget branch's `tool_call` announcement DELETED, so an over-budget call is answered by a
  result no call announced (5 red). The prose here said "announced AFTER the budget check rather
  than before" and that is a different mutation, worth 1 red, which a review measured. The wording
  was left over from when the announcement existed in two places; deleting the single remaining one
  is what was actually run. Naming the mutation you ran rather than the one you meant to run is the
  second time this section has needed that correction.
- The operator shown `verdict.refusal`, the second-person text written for the model, instead of
  `refusalForTheUser` (3 red).
- The round-cap notice pushed as an `assistant` turn rather than in the loop's own role (1 red).
  This one is worth more than its count. It is the THIRD instance of a single defect, loop-authored
  text under the model's role, and the first two were each fixed on one path while the sibling kept
  doing it. The test that kills it drives five scenarios across all three exits from `runAgentTurn`
  (two pairs share a return) instead of
  asserting "on any path" from one of them, which is precisely what hid the first two.
- A whole-word archive noun turned back into a prefix stem, `memories` to `memor` (1 red, and it was
  2 at `01bfe35`). The one red is `catches "There were no memories about checkout."`. The sentence
  this bullet used to credit, "The container has no memory limit set", is NOT withheld by this
  mutation any more and the proof is that its test stayed green under the run: a stem followed by a
  word character cannot match once there is a trailing boundary, and at `01bfe35` there was not one.
  So the RAM control this bullet named is no longer what kills this mutation, and saying so is the
  point of re-measuring rather than carrying a number forward. The negative controls are still one
  per RETAINED stem; the block that preceded them tested only alternatives that had been deleted,
  which is why it could not see the same bug twice.

Not proven by mutation, and said plainly rather than counted in: the `CoverageUnknownError` arm in
`runTool`. `createRepository` does not throw it, because `runRecall` catches an embedder failure, a
failed count query, a failed candidate query and an unscoreable row and returns an UNKNOWN receipt
for each. The arm is exercised by a throwing double and refines the message only. What sets coverage
on that path is the recall-failed rule above, which is the fifth bullet and is mutation proven.

Two behaviours in this area are pinned as LIMITS rather than protections, and no mutation is claimed
for either, because tightening them is a design change rather than a regression. An absence claim is
bound to the TURN, not to the question: a turn that searched one subject may assert absence about
another. And a recall refused by its own schema never reached the repository, so it leaves the
verdict alone.

### The HTTP surface: three mutations against the demo's ceilings

Same method, run at `da283fe` against a baseline of 736. These three are the guarantees the surface
actually makes, as opposed to the things it merely does.

- The daily ceiling checked AFTER the model call instead of before (1 red, and it is the right one:
  `refuses without calling the model at all`). The test counts the model's calls and asserts zero on
  a refusal, which is the only thing that makes the ordering a fact rather than a comment in the
  handler. Checking afterwards spends the money and then reports that it should not have.
- The CORS allowlist reflecting whatever arrived in `Origin` (4 red, at both the unit and the route
  level). A reflector is not a weaker allowlist, it is no policy at all, and it is one deleted
  condition away from being what this file has instead of `hono/cors`.
- The error mapper interpolating the thrown value into the response body (2 red, the unit and the
  end-to-end). Both assert on the ARN, the account id and the connection string that the planted
  error carries. This is the mutation that matters most, because the property is invisible when it
  holds: a response that leaks a role ARN looks exactly like one that does not until somebody reads
  it.

### A rule that could not fire, found by planting rather than by reading it

`no-hono-cors-middleware` was written, looked correct, and matched nothing. The planted
`import { cors } from 'hono/cors'` was caught by `not-to-unresolvable` instead, and that is the tell:
dependency-cruiser was not honouring package EXPORTS MAPS, so a subpath import resolved to no module
at all, and every rule in that config matches on paths. A module with no path cannot violate a path
rule.

It would have sat in the config as the mechanical control over an accepted security advisory while
matching nothing, which is the fourth entry in the list below and the reason that list exists.

The same run also showed a real import failing the gate, `@hono/node-server/conninfo` in
`apps/api/src/main.ts`, which was going to ship. One resolver fix, `exportsFields` plus
`conditionNames`, closed both directions: the rule now fires by its own name, and correct code stops
being reported as a violation. Watching a rule fire is not enough. Watch it fire BY NAME.

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

**Updated 2026-08-05, when the moment this paragraph predicted actually arrived.** The exclusion is
now `design/mockups/**` rather than the HTML alone.

The previous version of this section said the exclusion covered the HTML only, that
`design/mockups/board.css` stayed inside the gate, and that the whole thing expired on its own once
the site was built as components. `apps/web` now exists, its chrome is one layout component, and
`apps/web/src/styles/board.css` is the port of that shared stylesheet. The gate immediately reported
eight CSS clones between the two files, which is correct: they are the same stylesheet twice.

So the question the old paragraph left open had to be answered, and it was answered this way. The
mockups are kept as the frozen bake-off artefact, because they are the record of a design decision
that `design/ART-DIRECTION.md` argues from at length, and deleting the evidence for an argument
makes the argument unreadable. But they stop being authoritative: `ART-DIRECTION.md` section 3 now
names the product stylesheet as the list a colour has to appear in, so there is no longer a
question about which of the two files a reader should edit.

That makes every file under `design/mockups/` a historical artefact rather than product code, and
duplication between a frozen artefact and the product it specified is not the duplication this gate
exists to prevent. Deleting them outright is the cleaner end state and it is the right call for the
ship-safe pass, once nothing references them; it was not made here because it would have removed
the source of an argument in the same change that shipped the thing the argument produced.

## The two accessibility gates, and what each was watched failing at

Both landed with `apps/web` on 2026-08-05, and both were planted-and-watched before being trusted,
because a gate nobody has seen fail is a gate nobody has tested.

### `gate:contrast` - the ratios the stylesheet claims

`scripts/check-contrast.mjs` parses the colour tokens out of `apps/web/src/styles/board.css`, builds
the day palette and the night palette the way the cascade does (night inherits every token it does
not override), and recomputes the WCAG 2.1 relative-luminance ratio for 15 pairs in each watch. It
fails when a pair falls below 4.5:1, and it fails when a ratio recorded for that pair stops matching
what the tokens compute.

Watched failing: `--unlit` was changed from `#a3b3a0` to `#5a6858` and the gate reported
`[day] --unlit #5a6858 on --rail #24382e (the UNKNOWN lamp, which still has to be readable):
2.12:1 is below AA 4.5:1`, exit 1. Restored.

All 30 pairs pass, and every ratio written in the stylesheet was confirmed by independent
computation, which is the first time those numbers have been checked by anything but the person who
wrote them.

**The first version of this gate scraped the expected ratios out of the CSS comments and was
wrong.** One comment carries two ratios against one token (`4.81:1 on bay, 6.26:1 on rail`), so the
scraper attached the first number it found to every background that token appears on, and reported
seven mismatches that existed only inside the scraper. A ratio is a fact about a PAIR. It is now
recorded against a pair, in the gate.

### `gate:a11y` - the structure of what was actually shipped

`scripts/check-a11y.mjs` reads the built HTML in `apps/web/dist` with `linkedom` and checks WCAG 2.1
A and AA structure: a language on `<html>`, a non-empty `<title>`, exactly one `<main>`, exactly one
`<h1>`, no skipped heading levels, `alt` on every image, a label on every control, discernible text
in every link and button, no positive `tabindex`, and a skip link pointing at an element that
exists.

It reads the BUILT output rather than the source because the pages are Astro components and Preact
islands, so the markup a visitor receives does not exist in any single source file. A gate reading
`.astro` files would be checking an intention. Reading `dist` also covers the server-rendered HTML
of every island, so the console's own form control is checked the same way a template's is.

Watched failing: the layout's `<h1 class="sr-only">` was changed to a `<p>` and the gate reported
`2.4.6 expected exactly one <h1>, found 0` on all five pages, exit 1. Restored.

It refuses to pass on an empty run. No `dist` is an error, and zero HTML files found is an error,
because a checker that reports success from finding nothing is the failure this document keeps
describing.

### A measured limitation of `astro check`, recorded rather than assumed

`astro check` is wired into `verify:ship` as its own step, because `tsc` cannot read a `.astro` file
at all and the root `tsconfig.json` excludes that workspace, so step 1 says nothing about the site.
It catches real errors, and it caught several while the pages were being written: an
`exactOptionalPropertyTypes` violation, two JSX parse errors, an implicit `any`.

**It does not catch an unknown prop passed to an Astro component here.** Measured on 2026-08-05 by
planting `bogusPropThatDoesNotExist="x"` on `<Board>` in `src/pages/status.astro` and running the
check: 0 errors, 0 warnings. Removing the `types` override from `apps/web/tsconfig.json` did not
change it. Versions: astro 7.1.6, `@astrojs/check` 0.9.10, which is the latest published release
(2026-07-27), so this is not a version skew that an upgrade fixes.

The consequence, stated so nobody reads more into that step than it delivers: the `Props` interface
in `Board.astro` is documentation, not enforcement, and `Astro.props` has to be cast there or every
`.map` over a prop infers `any` and silently stops being checked. What does enforce the pages'
correctness is `gate:a11y`, which reads what was shipped.

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
