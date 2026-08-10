/**
 * Every way one agent turn can argue with itself, as data.
 *
 * THE FOURTH SIBLING, AND THE FIRST ON THIS SIDE OF THE WIRE. `archive-state.ts`, `recall-state.ts`
 * and `status-state.ts` each exist because a web surface believed a body whose own fields
 * contradicted each other. All three now refuse such a body. The API that WRITES those bodies
 * checked none of its own, so the guarantee stopped at the browser: a console can only refuse what
 * it is sent, and nothing said the thing being sent was coherent in the first place.
 *
 * A TEST HELPER AND NOT PRODUCTION CODE, which is a decision with a reason. The web guards are
 * production because a PAGE has to survive a body it did not write. The loop WROTE this body, and a
 * runtime self-check would be the loop grading its own homework, which `loop.ts` names as theatre in
 * the paragraph explaining why it will not have the model judge its own subject matter. So this runs
 * in CI, over every exit the loop has, and ships nothing.
 *
 * EVERY `loop.ts` LINE NUMBER IN THIS FILE IS READ AT `f185b4b`, and that anchor is not decoration.
 * It said `de773d8` for two commits, which is a MID-BRANCH commit of PR #18 and is not an ancestor
 * of `origin/main`: `git merge-base --is-ancestor de773d8 origin/main` fails, so a clone without
 * that branch cannot resolve it. `f185b4b` is the squash that merged the branch,
 * `git diff de773d8 f185b4b -- apps/api/src/agent/loop.ts` is empty, so every number below is as
 * true of this anchor as of the old one and a reader can now actually check them. (That sentence
 * called `de773d8` the pre-squash TIP. The tip was `9f453b4`. What kills an anchor is the squash,
 * not which commit of the branch it was.)
 *
 * TWENTY DISTINCT NUMBERS, and the word DISTINCT is what makes the figure reproducible. Extracting
 * every backticked citation from this file returns TWENTY FIVE occurrences, two written in full as
 * `loop.ts:NNN` and twenty three as bare `:NNN` continuations, which carry EIGHTEEN distinct values
 * between them. Add 177 and 311, which appear below as prose rather than as citations, and the set
 * is twenty. Those two are deliberately unbackticked HERE as well: the sentence used to claim they
 * appear "nowhere in backticks" while printing both of them in backticks, which put the reader
 * straight back into the twenty five versus twenty confusion this paragraph exists to end. It also
 * stated a method returning twenty seven beside a figure of twenty, so a reader re-deriving it got
 * neither number and could not tell which end was wrong. The count also said twenty-one for one
 * commit, which is what you get by counting the `toRecallEvent` map in `server.ts` as well: that is
 * a different file and this anchor does not vouch for it, which is the entire reason not to count
 * it. It has since gone stale, exactly as an unvouched citation is expected to.
 *
 * All twenty were correct at `ae8bd70` and every one BELOW THE FUNCTION SIGNATURE was wrong by five
 * or by seventeen one commit later, because the commit that gave each tool call its own id inserted
 * five lines inside the body and twelve more at the tool call push. The signature at 177 did not
 * move, and the sentence here said every one had, which is the same kind of overreach as a count
 * nobody measured. A citation with no commit beside it cannot be told from one that has gone stale,
 * and this file's own subject is claims with no mechanism keeping them true. When a future change
 * moves them again, re-derive them and move the anchor, or drop the numbers.
 *
 * THE RULES ARE BUILT FROM WHAT THE LOOP EMITS, ENUMERATED BY READING IT, not from the failures that
 * came to mind. `runAgentTurn` has THREE return sites, counted with a match-only grep for a return
 * inside its body at lines 177 to 311: the round cap at `:207`, the permitted answer at `:232` and
 * the second refusal at `:254`. This said FOUR and listed the round cap reached with an empty tool
 * list as the fourth, which is the SAME statement at `:207` arrived at by another route.
 * A miscount inside a paragraph whose claim is that the sites were enumerated is that claim failing
 * on itself. What the enumeration turns up is a set of asymmetries a guard written from intuition
 * gets backwards:
 *
 *   - `toolCallCount` IS NOT the number of `tool_call` turns. Every call is announced BEFORE the
 *     budget check and only calls under budget increment the counter, deliberately, so the honest
 *     invariant is that the count never EXCEEDS the announcements.
 *   - A `refusal` turn does NOT imply `refusedAnAbsenceClaim`. The round cap pushes one and never
 *     sets the flag. The implication holds one way only.
 *   - `coverage` IS NOT the fold over `recalls`. A recall that THREW contributes UNKNOWN and leaves
 *     no recall event behind, on purpose, because there is no receipt to show for a search that did
 *     not finish. So `coverage` may be WORSE than the fold and may never be BETTER.
 *   - `text` IS NOT always the last thing in the transcript. On a second refusal the transcript ends
 *     with the sentence written TO THE MODEL and `text` is the different sentence written to the
 *     operator, which is the whole reason both exist.
 *
 * A guard asserting the tidy version of any of those four would fail on correct output, and three of
 * them would have to be loosened until they checked nothing.
 */

import type { AgentTurnResponse, RecallEventView, TurnView } from '@throughline/contract';
import type { Coverage } from '@throughline/memory';
import { refusalForTheUser, worseOf, type AgentAnswer, type RecallEvent } from '../src/agent/loop.ts';
import { claimsAbsence } from '../src/agent/tools.ts';

/**
 * Every rule, by id, with the sentence it reports.
 *
 * A NAMED SET RATHER THAN A COUNT, so a test can assert that every one of them FIRES somewhere. A
 * rule nobody can trigger is a guard that reads as coverage and provides none, and this repository
 * has shipped that shape more than once. The completeness test in the sibling file compares the ids
 * fired across the negative cases against `Object.keys` here, so adding a rule without a case that
 * drives it turns the suite red.
 */
export const RULES = {
  transcriptEmpty: 'the transcript is empty',
  transcriptDoesNotOpenWithTheUser: 'the transcript does not open with the message that started it',
  toolCountAboveAnnouncements: 'it counts more tool calls than it announced',
  toolCountNotACount: 'its tool call count is not a count',
  resultBeforeItsCall: 'a tool result arrives before anything announced its id',
  callWithoutResult: 'a tool call is announced and never answered',
  callAnnouncedTwice: 'two tool calls are announced under one id',
  recallNeverAnnounced: 'a recall receipt is keyed to a call nothing announced',
  recallAnnouncedAsAnotherTool: 'a recall receipt is keyed to a call for a different tool',
  recallIdsRepeated: 'two recall receipts share one call id',
  coverageBetterThanARecall: 'its verdict is better than a recall it carries',
  coverageMissingWithRecalls: 'it carries recalls and reports no verdict at all',
  coverageWithoutARecall: 'it reports a verdict with no receipt behind it',
  returnedNotACount: 'a recall receipt reports a row count that is not a count',
  returnedDisagreesWithMemories: 'a recall receipt counts rows that did not arrive with it',
  refusalFlagWithoutARefusal: 'it reports refusing an answer and shows no refusal',
  answerIsNotOnTheRecord: 'the answer it returns appears nowhere in the record of the turn',
  loopSentenceClaimsAbsence: 'a sentence the loop wrote is one the loop would refuse',
  modelIdBlank: 'it names no model as having produced the answer',
  budgetSpentAboveItsLimit: 'it reports spending more than its own ceiling allows',
  budgetNotACount: 'its budget is not a count',
  budgetDayNotADay: 'its budget names no day',
} as const;

export type RuleId = keyof typeof RULES;

export interface Contradiction {
  readonly rule: RuleId;
  readonly says: string;
}

const raise = (rule: RuleId, detail: string): Contradiction => ({
  rule,
  says: `${RULES[rule]}: ${detail}`,
});

/**
 * The facts a recall carries, from either side of the wire.
 *
 * The loop holds a `RecallResult` and the wire holds a `RecallEventView`, and they are the same
 * three facts wearing different shapes. Normalising once is what lets ONE rule set read both, rather
 * than a copy per shape that drifts the first time a rule is corrected on one of them.
 */
interface RecallFacts {
  readonly callId: string;
  readonly coverage: Coverage;
  readonly returned: number;
  readonly memoryCount: number;
}

interface TurnFacts {
  readonly text: string;
  readonly coverage: Coverage | null;
  readonly refusedAnAbsenceClaim: boolean;
  readonly toolCallCount: number;
  readonly modelId: string;
  readonly transcript: readonly TurnView[];
  readonly recalls: readonly RecallFacts[];
}

// COPIES OF `contradiction.ts`'s TWO PREDICATES, AND THE REASON IS A BOUNDARY RATHER THAN AN
// OVERSIGHT. That module is `apps/web/src`, which nothing under `apps/api` may import: they are two
// applications and the dependency would make the API build depend on the console's source. The
// alternative is hoisting both into `packages/contract`, which is a change to a published surface
// for the sake of two one-line predicates. Recorded here because `contradiction.ts` says in its own
// docblock that a predicate copied into a second file is what this repository settles with one
// module, and a copy that contradicts that sentence has to say why it is one.
const isBlank = (value: string): boolean => value.trim() === '';
const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

const calls = (transcript: readonly TurnView[]): readonly Extract<TurnView, { role: 'tool_call' }>[] =>
  transcript.filter((turn): turn is Extract<TurnView, { role: 'tool_call' }> => turn.role === 'tool_call');

/**
 * The transcript's own shape: what was announced, what was answered, and in which order.
 *
 * ORDER IS CHECKED, and that is the half the two existing assertions in `agent-loop.test.ts` do not
 * cover. Both of them build a `Set` of every announced id from the WHOLE transcript and then ask
 * whether each result's id is in it, so a `tool_result` appearing BEFORE its own `tool_call` passes
 * either one. The providers this shape exists for read the transcript in order.
 */
function transcriptRules(facts: TurnFacts): readonly Contradiction[] {
  const found: Contradiction[] = [];
  const { transcript } = facts;

  if (transcript.length === 0) return [raise('transcriptEmpty', 'no turn was recorded at all')];
  if (transcript[0]?.role !== 'user') {
    found.push(raise('transcriptDoesNotOpenWithTheUser', `it opens with a ${transcript[0]?.role} turn`));
  }

  const announced = new Set<string>();
  const answered = new Set<string>();
  for (const turn of transcript) {
    if (turn.role === 'tool_call') {
      // THIS RULE WAS DELIBERATELY ABSENT UNTIL THE LOOP COULD PASS IT, and the reason is recorded
      // here rather than lost. The loop used to echo the model's own id into this field, so a model
      // reusing one id produced two announcements under it, and a rule the loop's real output fails
      // is not a rule anybody can ship. The loop now mints the id itself and keeps what the model
      // sent as `given`, which is what makes this checkable at all.
      if (announced.has(turn.id)) {
        found.push(raise('callAnnouncedTwice', `the id ${JSON.stringify(turn.id)}`));
      }
      announced.add(turn.id);
    }
    if (turn.role === 'tool_result') {
      if (!announced.has(turn.id)) {
        found.push(raise('resultBeforeItsCall', `the result for ${JSON.stringify(turn.id)}`));
      }
      answered.add(turn.id);
    }
  }
  for (const id of announced) {
    if (!answered.has(id)) {
      found.push(raise('callWithoutResult', `the call ${JSON.stringify(id)}`));
    }
  }

  if (!isCount(facts.toolCallCount)) {
    found.push(raise('toolCountNotACount', `it reports ${facts.toolCallCount}`));
  } else if (facts.toolCallCount > calls(transcript).length) {
    found.push(
      raise(
        'toolCountAboveAnnouncements',
        `it counts ${facts.toolCallCount} and announced ${calls(transcript).length}`,
      ),
    );
  }
  return found;
}

/** Every recall receipt against the call that asked for it, and against the rows beside it. */
function recallRules(facts: TurnFacts): readonly Contradiction[] {
  const found: Contradiction[] = [];
  const byId = new Map(calls(facts.transcript).map((turn) => [turn.id, turn.name]));
  const seen = new Set<string>();

  for (const recall of facts.recalls) {
    const named = byId.get(recall.callId);
    if (named === undefined) {
      found.push(raise('recallNeverAnnounced', `the receipt for ${JSON.stringify(recall.callId)}`));
    } else if (named !== 'recall') {
      found.push(
        raise('recallAnnouncedAsAnotherTool', `${JSON.stringify(recall.callId)} asked for ${named}`),
      );
    }
    if (seen.has(recall.callId)) {
      found.push(raise('recallIdsRepeated', `both are keyed to ${JSON.stringify(recall.callId)}`));
    }
    seen.add(recall.callId);

    // TWO RULES AND NOT ONE, which is the same split the sibling counts already have as
    // `toolCountNotACount` and `budgetNotACount`. Fused, a `returned` of minus one reported as a
    // MISMATCH with the rows, which names the wrong fault: nothing is being compared yet, because
    // the field is not a count at all. That is the ordering correction `status-state.ts` records
    // making for the same reason, a comparison against a value that is not a value being meaningless
    // rather than false.
    if (!isCount(recall.returned)) {
      found.push(raise('returnedNotACount', `it reports ${recall.returned}`));
    } else if (recall.returned !== recall.memoryCount) {
      found.push(
        raise(
          'returnedDisagreesWithMemories',
          `it counts ${recall.returned} and ${recall.memoryCount} arrived with it`,
        ),
      );
    }
  }
  return found;
}

/**
 * The turn's verdict against the receipts it carries.
 *
 * `worseOf` IS THE PRODUCTION FUNCTION, imported rather than reimplemented, so this cannot disagree
 * with the loop about which of two verdicts is worse or about how an unrecognised one is treated. A
 * second ordering written here would be the copied-predicate shape this repository keeps paying for.
 * The cost is stated rather than hidden: a defect INSIDE `worseOf` is invisible to this rule, and it
 * is `worseOf`'s own unit tests that cover that, not this one.
 */
function coverageRules(facts: TurnFacts): readonly Contradiction[] {
  const found: Contradiction[] = [];
  if (facts.recalls.length === 0) {
    // THE EARLY RETURN USED TO BE UNCONDITIONAL AND THAT WAS A HOLE, found by Codex on the open PR
    // and verified here against the loop rather than taken on report. A verdict and a receipt are
    // set in the SAME return: `loop.ts:413` hands back `coverage` and `recall` together for a recall
    // that completed, and `:304` and `:307` read them off one outcome. The ONLY path that produces a
    // verdict with no receipt is the catch at `:390`, and it always produces UNKNOWN, because there
    // is no receipt to show for a search that did not finish. So an empty `recalls` is coherent with
    // `null`, which means nothing was recalled, and with `UNKNOWN`, which means a recall threw. Any
    // other verdict there is a receipt that went missing between the loop and the reader, and
    // `server.ts` maps every receipt through `toRecallEvent`, which is where one could.
    //
    // WRITTEN AS AN ALLOWLIST, not as `=== 'COVERED' || === 'PARTIAL'`. Naming the two bad values
    // needs a new sibling the day a fourth verdict exists, and this file already carries the lesson
    // from the timestamp rule that closed a category by validating the form instead of enumerating
    // the ways to break it. It therefore also fires on a verdict this file has never heard of, which
    // no recall can produce either, and that is why the rule's sentence promises no completed recall.
    if (facts.coverage !== null && facts.coverage !== 'UNKNOWN') {
      return [
        raise('coverageWithoutARecall', `it reports ${facts.coverage} and carries no receipt at all`),
      ];
    }
    // THE SECOND ARM, AND IT IS THE NARROWER TWIN OF THE ARM ABOVE. The exemption for UNKNOWN was
    // unconditional, which is the early-return shape this rule was written to close, one reading
    // further in. UNKNOWN with no receipt means a recall THREW, and a recall that threw was
    // ANNOUNCED first: `loop.ts:288` pushes the `tool_call` before `runTool` can reach the catch at
    // `:390`. So UNKNOWN with no receipt AND no recall ever announced is a verdict from nowhere, and
    // the transcript already carries what is needed to say so. Two arms means two fault cases, one
    // per arm, which is the lesson the budget day rule paid for two commits ago.
    if (facts.coverage === 'UNKNOWN' && !calls(facts.transcript).some((turn) => turn.name === 'recall')) {
      return [raise('coverageWithoutARecall', 'it reports UNKNOWN and announced no recall at all')];
    }
    return found;
  }

  if (facts.coverage === null) {
    return [raise('coverageMissingWithRecalls', `it carries ${facts.recalls.length}`)];
  }
  for (const recall of facts.recalls) {
    // The turn's verdict must ALREADY be at least as bad as this receipt's. If folding the receipt
    // in would change the verdict, the turn is reporting better coverage than something it carries.
    if (worseOf(facts.coverage, recall.coverage) !== worseOf(facts.coverage, facts.coverage)) {
      found.push(
        raise(
          'coverageBetterThanARecall',
          `it reports ${facts.coverage} over a receipt reading ${recall.coverage}`,
        ),
      );
    }
  }
  return found;
}

/**
 * What the turn says, against what the record shows.
 *
 * THE ANSWER IS ALLOWED NOT TO BE THE LAST TURN, and that arm is the point of this rule rather than
 * an exception to it. `loop.ts` returns `refusalForTheUser` on a second refusal because the last
 * transcript turn is written in the second person TO THE MODEL, and returning that put instructions
 * for the model on the operator's screen. So the rule admits exactly two forms and no third.
 *
 * THE SECOND FORM IS GATED ON `refusedAnAbsenceClaim`, AND UNGATED IT WAS AN EXEMPTION NOBODY HAD
 * READ AS A CLAIM. It said that a turn carrying the operator-facing sentence is on the record
 * whatever else it shows, so a turn with that text, the flag false and no refusal turn anywhere was
 * declared coherent. The loop returns that sentence at ONE site, `:255`, inside
 * `if (refusedAnAbsenceClaim)` at `:245` and one statement after the refusal is pushed at `:243`, so
 * the flag is true wherever the sentence is. The gate cannot over-refuse a real turn either: a model
 * whose own answer happened to equal that sentence is still the last transcript turn, so it passes
 * as `said` without reaching the second form at all.
 *
 * A LOOP SENTENCE THAT CLAIMS ABSENCE IS THE PRODUCT'S HEADLINE FAILURE IN THE PRODUCT'S OWN VOICE.
 * The rule scans EVERY TURN PUSHED UNDER THE `refusal` ROLE, and there are exactly TWO push sites
 * for that role, counted with a match-only grep for `transcript.push` in `loop.ts`, which returns
 * SIX: `:206` the round cap notice, `:229` the model's own words, `:243` the refusal from
 * `judgeAnswer`, `:288` a tool call, `:291` the over budget notice and `:308` a tool result. Of the
 * six, `:206` and `:243` carry the refusal role and are what this rule reads.
 *
 * WHAT IT DOES NOT READ, named rather than counted, because the count that stood here was a number
 * nobody could derive from the method the same sentence gave. The over budget notice at `:291` is a
 * `tool_result`. So are the tool failure sentences at `:366` and `:368` and every sentence `dispatch`
 * writes. `refusalForTheUser` at `:514` is authored by the loop and pushed NOWHERE: it is returned
 * as `text`, so no transcript scan can reach it. A blanket scan of `tool_result` content would be
 * wrong anyway, because a recall's rendered text carries memory content from the database, so it
 * would refuse a stored memory for quoting an absence rather than refusing the loop for asserting
 * one.
 *
 * It still matters, because the two it does read are checked nowhere else. A grep of
 * `apps/api/test` for `claimsAbsence` at `f572c95` returns TWENTY hits, one per line, and exactly
 * ONE applies it to a sentence the loop wrote. That one is `refusalForTheUser`, which is not either
 * of these two, so the sentences this rule scans had no check at all.
 */
function answerRules(facts: TurnFacts): readonly Contradiction[] {
  const found: Contradiction[] = [];
  const last = facts.transcript[facts.transcript.length - 1];
  // A `tool_call` carries `args` and no `content`, so it can never BE the answer. The loop never
  // ends a turn on one, and a turn that did would be reporting an answer nobody uttered, which is
  // what the rule below then says.
  const said = last === undefined || last.role === 'tool_call' ? null : last.content;

  const operatorRefusal =
    facts.refusedAnAbsenceClaim && facts.text === refusalForTheUser(facts.coverage);
  if (facts.text !== said && !operatorRefusal) {
    found.push(raise('answerIsNotOnTheRecord', `it returns ${JSON.stringify(facts.text.slice(0, 60))}`));
  }
  if (facts.refusedAnAbsenceClaim && !facts.transcript.some((turn) => turn.role === 'refusal')) {
    found.push(raise('refusalFlagWithoutARefusal', 'no turn carries the refusal role'));
  }
  for (const turn of facts.transcript) {
    if (turn.role === 'refusal' && claimsAbsence(turn.content)) {
      found.push(raise('loopSentenceClaimsAbsence', JSON.stringify(turn.content.slice(0, 60))));
    }
  }
  if (isBlank(facts.modelId)) {
    found.push(raise('modelIdBlank', `it reports ${JSON.stringify(facts.modelId)}`));
  }
  return found;
}

/** Every way a turn can argue with itself, for the shape the loop returns. */
export function turnContradictions(facts: TurnFacts): readonly Contradiction[] {
  return [
    ...transcriptRules(facts),
    ...recallRules(facts),
    ...coverageRules(facts),
    ...answerRules(facts),
  ];
}

const fromResult = (event: RecallEvent): RecallFacts => ({
  callId: event.callId,
  coverage: event.result.receipt.coverage,
  returned: event.result.receipt.returned,
  memoryCount: event.result.memories.length,
});

const fromView = (event: RecallEventView): RecallFacts => ({
  callId: event.callId,
  coverage: event.receipt.coverage,
  returned: event.receipt.returned,
  memoryCount: event.memories.length,
});

/** What `runAgentTurn` returns, judged against itself. */
export function answerContradictions(answer: AgentAnswer): readonly Contradiction[] {
  return turnContradictions({ ...answer, recalls: answer.recalls.map(fromResult) });
}

/**
 * The 200 from `POST /agent/turn`, judged against itself.
 *
 * The budget rules live ONLY here, because `AgentAnswer` has no budget: `server.ts` attaches it from
 * the demo ceiling after the turn returns. Splitting them out rather than passing a nullable budget
 * into the shared rules is deliberate. A rule that skips itself when a field is absent is a rule
 * that silently stops running, and a `null` standing for "not applicable" is the falsy sentinel that
 * has already made assertions vacuous elsewhere in this repository.
 */
export function responseContradictions(response: AgentTurnResponse): readonly Contradiction[] {
  const { budget } = response;
  const found: Contradiction[] = [
    ...turnContradictions({ ...response, recalls: response.recalls.map(fromView) }),
  ];

  if (!isCount(budget.limit) || (budget.used !== null && !isCount(budget.used))) {
    found.push(raise('budgetNotACount', `it reports ${budget.used} of ${budget.limit}`));
  } else if (budget.used !== null && budget.used > budget.limit) {
    found.push(raise('budgetSpentAboveItsLimit', `it reports ${budget.used} of ${budget.limit}`));
  }
  // The day a count is counted IN, so a ceiling that resets daily can be read. Anything that is not
  // a written calendar day makes the count unattributable to a period.
  //
  // A ROUND TRIP AND NOT A SHAPE, which is the same correction the web guard made one commit before
  // this one and for the same reason. This was `/^\d{4}-\d{2}-\d{2}$/` alone, which passes
  // `2026-13-45` and `0000-00-00`, so it was a shape rule sitting in a file whose sibling had just
  // deleted a shape rule for needing a new sibling every time somebody found another form the engine
  // accepts. The producer is `demo-budget.ts`, which writes `toISOString().slice(0, 10)`, so the
  // identity refuses nothing real. The shape test stays in front of it because `Date.parse` accepts
  // forms this field never uses, and slicing an expanded year would compare ten characters of a
  // longer string against themselves.
  // THE NaN CHECK IS LOAD BEARING AND IS NOT A THIRD OPINION ABOUT THE SHAPE. `new Date(NaN)
  // .toISOString()` throws a RangeError, and `2026-13-45` PASSES the shape test above while parsing
  // to NaN, so without this the guard would throw on exactly the value it exists to report. The web
  // sibling does not need one because its parse check is a separate earlier rule that returns first.
  const asDay = `${budget.day}T00:00:00.000Z`;
  const parsedDay = Date.parse(asDay);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(budget.day) ||
    Number.isNaN(parsedDay) ||
    new Date(parsedDay).toISOString() !== asDay
  ) {
    found.push(raise('budgetDayNotADay', `it reports ${JSON.stringify(budget.day)}`));
  }
  return found;
}
