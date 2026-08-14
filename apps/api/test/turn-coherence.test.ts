/**
 * The agent turn judged against itself, on every exit the loop has that produces a turn to judge.
 *
 * WHAT THIS FILE IS FOR, and it is not more coverage of the loop. `agent-loop.test.ts` already
 * drives the loop well, and it pins the controls, the budgets and the dispatch. What it does not
 * have is a guard that reads a WHOLE turn and asks whether its fields agree with each other, driven
 * over every way the loop can return. Its assertions are per scenario and per property, so each one
 * sees the path it was written for and nothing else, which is the exact failure mode `loop.ts`
 * records three times in its own comments: a property asserted from a test that could not see the
 * second instance. (No test count for that file is given here. This paragraph carried one and the
 * table below carried a different one twenty lines apart. The table's is measured and stated with
 * what it was measured on, so it is the only one.)
 *
 * TWO HALVES, and the second is what stops the first rotting. The positive half runs the real loop
 * over every arrangement in `EXITS` and asserts that `answerContradictions` finds nothing. No count
 * is written here: the one that was said twelve, went to thirteen the moment an exit was added, and
 * was not the kind of number a reader could check without counting the list anyway. The negative half
 * hands the guard a turn that is wrong in exactly one way and asserts the rule that names that fault
 * fires. The last test compares the rules the negative half drove against the whole rule set, so a
 * rule with no case that triggers it turns this suite red rather than sitting there reading as
 * coverage.
 *
 * The builders come from `agent-fixtures.ts` for the reason that file gives, and `recallCall`,
 * `answer` and `run` are call wrappers rather than shapes, so a copy of them cannot drift into
 * passing against a record production never emits. The negative half DOES hand-build record shapes,
 * `coherent()` and the four turns above it, and that is what the control test guards: it asserts the
 * base is clean, so every fault below differs from a turn already known to be coherent.
 *
 * WHAT IT IS WORTH, MEASURED RATHER THAN ASSERTED, and the measurement says it is COMPLEMENTARY and
 * not a superset. Six defects were planted in `loop.ts`, four of them ones the file's own comments
 * record as having really shipped once, and both suites were run against each. Measured at `6c8162d`
 * on node v22.22.0, `agent-loop.test.ts` holding 47 tests and this file 34:
 *
 *   | planted in `loop.ts`                                  | agent-loop | this file |
 *   | a receipt keyed to an id nothing announced            |    0 of 47 |    7 of 34 |
 *   | over budget calls answered without being announced    |    1 of 47 |    2 of 34 |
 *   | the tool count inflated past the announcements        |    4 of 47 |    8 of 34 |
 *   | a thrown recall no longer degrading the verdict       |    2 of 47 |    0 of 34 |
 *   | the model facing refusal returned to the operator     |    3 of 47 |    0 of 34 |
 *   | the round cap notice put under the assistant role     |    1 of 47 |    0 of 34 |
 *
 * THE FIRST ROW IS WHY THIS FILE EXISTS. Nothing in `apps/api/test` compared a recall receipt to the
 * call that asked for it: a grep for `callId` there returned two lines AT `f572c95`, before this file
 * was written, both in `server.test.ts`, of which one is a type annotation inside a cast and the
 * other is the single assertion, comparing the id against a LITERAL rather than against the
 * transcript. So a receipt keyed to an id no `tool_call` announced was invisible to 47 tests, and it
 * is the thing the console reads to line a receipt up with its request. The grep returns more than
 * that today, in more files, and the reason is this file and the ones it made necessary, so the
 * measurement is anchored where it was taken rather than rewritten to a number that would say
 * nothing about why the file exists.
 *
 * THE LAST THREE ROWS ARE THE HONEST HALF AND ARE NOT A GAP TO CLOSE HERE. Each is a defect this
 * guard cannot see BY CONSTRUCTION, and saying so is the point of measuring:
 *
 *   - A thrown recall that stops degrading the verdict leaves NO receipt behind, so there is nothing
 *     for the verdict to be compared against. The rule is deliberately one directional, because
 *     `coverage` is allowed to be worse than the fold over `recalls` and never better.
 *   - Returning the model facing refusal to the operator puts a sentence that IS in the transcript
 *     into `text`, so it satisfies a structural rule. Which of two recorded sentences belongs to the
 *     operator is a judgement about audience, not about coherence.
 *   - The round cap notice under the assistant role leaves `text` matching the last turn and the
 *     refusal flag false, so nothing structural disagrees. `agent-loop.test.ts` catches it with a
 *     list of the loop's own phrases, and copying that list here would be the duplicated predicate
 *     this repository keeps paying for.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentTurnResponse, TurnView } from '@throughline/contract';
import type { ChatModel, ChatReply } from '../src/agent/loop.ts';
import type { MemoryRepository, RecallResult } from '@throughline/memory';
import { ChatResponseError, refusalForTheUser, runAgentTurn, type AgentAnswer } from '../src/agent/loop.ts';
import { createScriptedChatModel } from '../src/agent/local-model.ts';
import { toRecallEvent } from '../src/http/contract.ts';
import { answerContradictions, responseContradictions, RULES, type RuleId } from './turn-coherence.ts';
import {
  fakeRepository,
  MEMORY_ID_A,
  memoryRecord,
  recallResult,
  repositoryReturning,
  scoredMemory,
} from './agent-fixtures.ts';

const recallCall = (id = 'call-1', query = 'checkout latency'): ChatReply => ({
  kind: 'tools',
  calls: [{ id, name: 'recall', args: { query } }],
});

const answer = (text: string): ChatReply => ({ kind: 'answer', text });

const ABSENCE = 'There are no prior incidents like this.';

const NOW = new Date('2026-08-10T09:00:00.000Z');

function run(
  model: ChatModel,
  repository: MemoryRepository,
  maxToolCalls?: number,
  turnBudgetMs?: number,
): Promise<AgentAnswer> {
  return runAgentTurn(
    {
      model,
      repository,
      workspaceId: 'demo',
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
      ...(turnBudgetMs === undefined ? {} : { turnBudgetMs }),
    },
    'has checkout been slow before?',
  );
}

/**
 * Real elapsed time rather than a fake clock, for the two arrangements that need the budget spent.
 *
 * `agent-loop.test.ts` fakes the clock because it asserts an exact call count against the sixty
 * second default, and a real sixty second turn is not a test. Here the budget is chosen small and
 * the delay is longer than it, and `it.each` running sixteen thunks around a fake clock would have
 * to keep it consistent across all of them.
 *
 * SO THE ARRANGEMENT ASKS THE MACHINE FOR TWO THINGS, NOT ONE. That `setTimeout` does not fire
 * EARLY, which is free. And that everything before the delayed recall - a model call, a tool
 * dispatch, the loop's own bookkeeping - fits inside the budget, which is NOT free. The word that
 * stood where this paragraph is was "only", naming the first and omitting the second, four lines
 * above the paragraph that exists to correct exactly that omission.
 *
 * THE SENTENCE THAT STOOD HERE SAID A SLOW MACHINE MAKES THESE TURNS LATER, NEVER DIFFERENT, AND
 * THAT WAS FALSE. It is the same mistake as the enumeration below, in a different costume: a claim
 * about a mechanism, written from the mechanism the author had in mind. The delay is not the only
 * thing that can spend a forty millisecond budget. Everything before it can too, and the model call
 * comes first. A reviewer put fifty milliseconds into the first model reply and the arrangement
 * named for the exit BETWEEN rounds silently took the exit WITHIN a round instead, ending the turn
 * before announcing anything, and stayed green: the only thing asserted was that the answer did not
 * contradict itself, and a turn that did nothing at all contradicts itself least of all.
 *
 * SO THE ARRANGEMENTS ARE FACTORIES AND EACH IS ASSERTED TWICE. `EXITS` asks whether the turn is
 * coherent. The pair of tests further down asks which exit it actually reached, and each is pinned
 * by a transcript shape no other exit of that same arrangement can produce. If one of them ever goes
 * red on a slow machine, that is this guard doing its job and the answer is to raise the budget and
 * the delay together, never to drop the assertion and go back to trusting the label.
 */
const slower = <T,>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });

/** The budget both clock arrangements run against, and the delay each uses to outlast it. */
const CLOCK_BUDGET_MS = 40;
const LONGER_THAN_THE_BUDGET_MS = 60;

/**
 * A model that never stops asking, which is how the round cap gets driven with tools in hand.
 *
 * THE GUARD FOUND SOMETHING ON ITS FIRST RUN AND THIS IS THE HONEST RECORD OF IT, IN THE PAST TENSE
 * BECAUSE IT IS OVER. The first version of this model returned the same literal call id every round,
 * copying the fixture in `agent-loop.test.ts`, and `recallIdsRepeated` fired: the turn came back
 * carrying several recall receipts all keyed to one id, which a console could not attribute to the
 * request that produced each. `loop.ts` echoed `call.id` exactly as the model supplied it, and the
 * decision recorded here was that the loop would not be changed for it, because refusing a repeat
 * closes only the receipt half and the choice between a unique id and the id the model sent is a
 * design change rather than a patch.
 *
 * THAT DECISION WAS REVERSED IN `f185b4b` AND EVERY SENTENCE ABOVE IS HISTORY. The loop mints its
 * own `tc-N` and keeps what the model sent in `given`, so `forgetful` below models a repeating model
 * on purpose and the turn it produces is coherent. This paragraph exists because the version of this
 * docblock that said THE LOOP IS NOT CHANGED HERE survived the commit that changed it, sitting just
 * above a new docblock saying the opposite, and a reader would have believed whichever they reached
 * first. A note explaining why something was not done has to be deleted by the change that does it.
 * (No line distance is quoted. The sentence here said twenty and it was thirty, which is the trap
 * the sibling file records as the reason it stopped quoting distances at all.)
 *
 * The per-round id this model still hands out no longer reaches any rule: rules read `id`, which the
 * loop now owns, so these land in `given` and nothing compares them. It is kept because a model that
 * varies its ids is the ordinary case and this fixture should not quietly become the odd one.
 */
const insatiable: ChatModel = {
  id: 'insatiable',
  reply: (() => {
    let asked = 0;
    return (): Promise<ChatReply> => {
      asked += 1;
      return Promise.resolve(recallCall(`call-${asked}`));
    };
  })(),
};

const asksForNothing: ChatModel = {
  id: 'empty-handed',
  reply: () => Promise.resolve({ kind: 'tools', calls: [] }),
};

/**
 * A model that reuses ONE call id for every call it makes.
 *
 * THIS IS THE FIXTURE THE GUARD CAUGHT ON ITS FIRST RUN, RESTORED AS A CASE THE LOOP NOW HANDLES.
 * It used to be what `insatiable` did by accident, copied from another file's literal, and the turn
 * came back carrying several receipts keyed to one id. The note beside it recorded that the loop was
 * not being changed, because refusing a repeat closes only the receipt half and leaves two
 * `tool_call` turns sharing an id, and choosing between an id that is unique and the id the model
 * actually sent is a design change rather than a patch.
 *
 * That choice is made now and it is BOTH. The loop mints the id it joins on and keeps what the model
 * sent as `given`, so this model is no longer a fixture modelling a defect: it is an ordinary
 * provider being sloppy, which is a thing a provider is free to be.
 *
 * A FACTORY AND NOT A CONSTANT, the way `throwing()` beside it already is, because the count lives
 * in a closure. Written as a constant it was shared between the two tests that use it, and the first
 * one exhausted it: the second received a model that answered on its first call and asked for no
 * tool at all. The test that found that was the one written to prove this fixture repeats an id.
 */
const forgetful = (): ChatModel => ({
  id: 'forgetful',
  reply: (() => {
    let asked = 0;
    return (): Promise<ChatReply> => {
      asked += 1;
      return Promise.resolve(
        asked > 2 ? answer('Checkout was slow in July.') : recallCall('call-1', `look ${asked}`),
      );
    };
  })(),
});

const throwing = (): MemoryRepository =>
  fakeRepository({ recall: () => Promise.reject(new Error('the cluster refused the connection')) });

/**
 * THE TWO CLOCK ARRANGEMENTS, WRITTEN ONCE AND USED TWICE, for the reason `slower` above records.
 *
 * Each reaches a DIFFERENT `endTurn(RAN_OUT_OF_TIME)`: one at the top of a round and one between two
 * calls of a single reply. Both hand back the same fields, so no assertion on the answer can say
 * which statement produced it. What separates them is what the transcript shows, and for each
 * arrangement that shape is reachable by exactly one of its own exits. Asserted below.
 */
const clockSpentBetweenRounds = (): Promise<AgentAnswer> =>
  run(
    createScriptedChatModel([recallCall(), answer('unreachable, the clock ends the turn first')]),
    fakeRepository({
      recall: () =>
        slower(
          LONGER_THAN_THE_BUDGET_MS,
          recallResult({ coverage: 'COVERED', memories: [scoredMemory()] }),
        ),
    }),
    undefined,
    CLOCK_BUDGET_MS,
  );

/** ONE reply asking for TWO recalls, which is the only way the clock can be read mid-reply. */
const clockSpentWithinARound = (): Promise<AgentAnswer> =>
  run(
    {
      id: 'two-at-once',
      reply: () =>
        Promise.resolve({
          kind: 'tools',
          calls: [
            { id: 'first', name: 'recall', args: { query: 'one' } },
            { id: 'second', name: 'recall', args: { query: 'two' } },
          ],
        }),
    },
    fakeRepository({
      recall: () => slower(LONGER_THAN_THE_BUDGET_MS, recallResult({ coverage: 'COVERED' })),
    }),
    undefined,
    CLOCK_BUDGET_MS,
  );

/**
 * EVERY EXIT, ENUMERATED FROM `loop.ts` RATHER THAN FROM THE CASES THAT CAME TO MIND.
 *
 * `runAgentTurn` ends in EIGHT ways, from SIX statements, named here by what they return rather than
 * by where they sit:
 *
 *   - `endTurn(timeUp ? RAN_OUT_OF_TIME : RAN_OUT_OF_ROOM)`, at the top of a round. TWO ways from
 *     one statement: the clock spent BETWEEN rounds, and the round cap.
 *   - `endTurn(unusableReply(error, options.log))`, when the model throws a `ChatResponseError`.
 *   - `answerFrom(settled)`, a permitted answer.
 *   - `endTurn(RAN_OUT_OF_TIME)`, the clock spent WITHIN a round, between two calls of one reply.
 *   - a THROW rather than a return, out of `unusableReply`, for any error that is not a
 *     `ChatResponseError`.
 *   - a THROW out of `requireBudget`, before round zero and therefore before anything at all. TWO
 *     ways from one statement, one for each budget it is called on, and `agent-loop.test.ts` drives
 *     both. It is not called INSIDE this function and that is exactly why it was missed twice.
 *
 * THE LAST TWO PRODUCE NO `AgentAnswer`, so this file cannot judge them and `agent-loop.test.ts`
 * owns both. Counting them anyway is the point: an exit with no coherence case should be visibly
 * absent rather than quietly missing.
 *
 * NO LINE NUMBERS AND NO COMMIT ANCHOR, AND THAT IS THE FIX RATHER THAN AN OMISSION. Three earlier
 * versions of this paragraph cited line numbers and every one was wrong when read: it said FOUR
 * returns while counting the round cap twice, then carried three numbers anchored to a mid-branch
 * sha a fresh clone cannot resolve, then carried three re-derived numbers that rotted again inside
 * the branch that re-derived them. Round three of the review caught a fourth instance, where the
 * numbers had moved and the count was short by two exits.
 *
 * ROUND FOUR CAUGHT A FIFTH, INSIDE THE PARAGRAPH REWRITTEN TO END THE FOURTH, and it is worth
 * saying plainly what kind of error it was, because deleting the line numbers did not prevent it and
 * was never going to. The count said six and the derivation had been done by reading the body of
 * `runAgentTurn` top to bottom. `requireBudget` throws from a helper, on the two lines that open the
 * function, so reading the body finds the CALLS and not the exit. Every version of this has been the
 * same error: measure one mechanism, write the number down against another. Names do not rot, but a
 * derivation can still be short, so the test below counts what the source contains rather than what
 * a reader noticed, and it now counts inside the function body too.
 *
 * Reaching each of the six is not the same as covering the loop, so the arrangements below also
 * drive the paths that BUILD the fields the rules read: an over budget call, which is announced
 * without being counted, a recall that throws, which moves the verdict and leaves no receipt, a tool
 * that is not a recall, and several calls in one round, which is the only way two receipts land in
 * one turn.
 */
const EXITS: readonly (readonly [string, () => Promise<AgentAnswer>])[] = [
  [
    'a permitted answer with no tool call at all',
    () => run(createScriptedChatModel([answer('I have not looked yet.')]), fakeRepository()),
  ],
  [
    'a permitted answer after a covered recall',
    () =>
      run(
        createScriptedChatModel([recallCall(), answer('Checkout was slow in July.')]),
        repositoryReturning(recallResult({ coverage: 'COVERED', memories: [scoredMemory()] })),
      ),
  ],
  [
    'a refusal the model then corrects',
    () =>
      run(
        createScriptedChatModel([recallCall(), answer(ABSENCE), answer('I could not search.')]),
        repositoryReturning(recallResult({ coverage: 'UNKNOWN' })),
      ),
  ],
  [
    'two refusals, where the turn ends on the refusal and the answer is not the last turn',
    () =>
      run(
        createScriptedChatModel([recallCall(), answer(ABSENCE), answer(ABSENCE)]),
        repositoryReturning(recallResult({ coverage: 'UNKNOWN' })),
      ),
  ],
  [
    'an absence claim refused with no recall in the turn at all',
    () => run(createScriptedChatModel([answer(ABSENCE), answer('I have not looked.')]), fakeRepository()),
  ],
  [
    'the round cap reached while the model keeps asking for tools',
    () => run(insatiable, repositoryReturning(recallResult()), 2),
  ],
  ['the round cap reached while the model asks for nothing', () => run(asksForNothing, fakeRepository(), 2)],
  [
    'a model that sends one call id twice, which the loop must not echo into two receipts',
    () =>
      run(
        forgetful(),
        repositoryReturning(recallResult({ coverage: 'COVERED', memories: [scoredMemory()] })),
      ),
  ],
  [
    'a recall that throws, which moves the verdict and leaves no receipt behind',
    () =>
      run(
        createScriptedChatModel([recallCall('call-1'), recallCall('call-2'), answer('I cannot say.')]),
        fakeRepository({
          recall: (() => {
            let asked = 0;
            return (): Promise<RecallResult> => {
              asked += 1;
              return asked === 1
                ? Promise.resolve(recallResult({ coverage: 'COVERED' }))
                : Promise.reject(new Error('the cluster refused the connection'));
            };
          })(),
        }),
      ),
  ],
  ['a recall that throws on the only call of the turn', () => run(createScriptedChatModel([recallCall(), answer('I cannot say.')]), throwing())],
  [
    'a tool that is not a recall, which carries no receipt and no verdict',
    () =>
      run(
        createScriptedChatModel([
          {
            kind: 'tools',
            calls: [
              {
                id: 'call-r',
                name: 'remember',
                args: { kind: 'resolution', content: 'Restarting the pods cleared it.', assertedBy: 'human:ana' },
              },
            ],
          },
          answer('Stored.'),
        ]),
        fakeRepository({ remember: () => Promise.resolve(memoryRecord({ id: MEMORY_ID_A })) }),
      ),
  ],
  [
    'three calls in one round against a budget of two, so one is announced and never counted',
    () =>
      run(
        {
          id: 'greedy',
          reply: () =>
            Promise.resolve({
              kind: 'tools',
              calls: [
                { id: 'a', name: 'recall', args: { query: 'one' } },
                { id: 'b', name: 'recall', args: { query: 'two' } },
                { id: 'c', name: 'recall', args: { query: 'three' } },
              ],
            }),
        },
        repositoryReturning(recallResult()),
        2,
      ),
  ],
  [
    'a tool call the schema refuses and a tool that does not exist',
    () =>
      run(
        createScriptedChatModel([
          { kind: 'tools', calls: [{ id: 'bad', name: 'recall', args: { query: '' } }] },
          { kind: 'tools', calls: [{ id: 'gone', name: 'delete_everything', args: {} }] },
          answer('Understood.'),
        ]),
        fakeRepository(),
        4,
      ),
  ],
  ['the clock spent BETWEEN rounds, after a recall that took longer than the budget', clockSpentBetweenRounds],
  ['the clock spent WITHIN a round, so the second call of one reply is never announced', clockSpentWithinARound],
  [
    'a reply the adapter read and could not use, arriving after a recall has already landed',
    () =>
      run(
        {
          id: 'truncating',
          reply: (() => {
            let asked = 0;
            return (): Promise<ChatReply> => {
              asked += 1;
              return asked === 1
                ? Promise.resolve(recallCall())
                : Promise.reject(new ChatResponseError('stopReason was max_tokens'));
            };
          })(),
        },
        repositoryReturning(recallResult({ coverage: 'COVERED', memories: [scoredMemory()] })),
      ),
  ],
];

describe('a turn the loop really produced never argues with itself', () => {
  it.each(EXITS)('%s', async (_label, exercise) => {
    const result = await exercise();

    expect(answerContradictions(result)).toEqual([]);
  });

  it('is still coherent once the HTTP layer has attached a budget and mapped the receipts', async () => {
    // THE SHAPE THE BROWSER ACTUALLY RECEIVES, which is not the shape the loop returns:
    // `server.ts` maps every `RecallResult` through `toRecallEvent` and attaches a budget the loop
    // knows nothing about. A guard that only ever read `AgentAnswer` would leave the mapping and
    // the budget unchecked, and the mapping is where `returned` and the rows stop being one object.
    const result = await run(
      createScriptedChatModel([recallCall(), answer('Checkout was slow in July.')]),
      repositoryReturning(recallResult({ coverage: 'COVERED', memories: [scoredMemory()] })),
    );
    const response: AgentTurnResponse = {
      text: result.text,
      coverage: result.coverage,
      refusedAnAbsenceClaim: result.refusedAnAbsenceClaim,
      toolCallCount: result.toolCallCount,
      modelId: result.modelId,
      transcript: result.transcript,
      recalls: result.recalls.map((event) => toRecallEvent(event.callId, event.result, NOW)),
      budget: { used: 3, limit: 50, day: '2026-08-10' },
    };

    expect(responseContradictions(response)).toEqual([]);
  });
});

/**
 * THE TRIPWIRE, BECAUSE THE ENUMERATION ABOVE HAS ROTTED FIVE TIMES AND A COMMENT CANNOT NOTICE.
 *
 * This is the only test in `apps/api/test` that reads source text, and that is a real cost: it is
 * coupled to how `loop.ts` is FORMATTED, not only to what it does, so a reflow that wraps one of
 * these calls across two lines turns it red without anything being wrong. That is accepted, and the
 * message says so, because the failure it is here to catch is the one nothing else can catch: an
 * exit added to the loop while this file's list, its docblock and its arrangements stay as they
 * were, reading as complete. Every previous instance was found by a human re-deriving the numbers
 * by hand, and four of those humans got it wrong.
 *
 * THE FIRST VERSION COUNTED CALLS TO TWO HELPERS AND WAS DESCRIBED AS CATCHING AN EXIT ADDED TO THE
 * LOOP, WHICH IS MORE THAN IT DID. A reviewer added an exit returning an `AgentAnswer` literal
 * instead of calling either helper and all 1494 tests stayed green, which is the same defect this
 * whole file keeps finding: a guard measured against one mechanism, written up as covering another.
 * So the counts below now come in two kinds and both are needed.
 *
 * THE FILE-WIDE COUNTS SAY WHICH HELPER EACH EXIT GOES THROUGH. `endTurn` is reached three times and
 * `answerFrom` twice, once from inside `endTurn` itself, which is why they do not add up to the
 * eight ways the docblock names. Kept as two numbers rather than a total so that moving an exit from
 * one helper to the other cannot cancel out.
 *
 * THE BODY COUNTS SAY NOTHING ELSE IS WRITTEN BETWEEN THOSE BRACES, which is narrower than saying
 * there is nothing else. Every `return` and every `throw` between the signature of `runAgentTurn`
 * and its closing brace is counted, so an exit that builds its own literal is a return the
 * arithmetic cannot account for. Five returns, of which three go through `endTurn` and two through
 * `answerFrom`, leaves nothing over.
 *
 * WHAT THAT MISSES IS AN EXIT WRITTEN IN A HELPER THIS FUNCTION CALLS, and it was missed. The
 * sentence above once said "there is nothing else", which was wrong. THE EXAMPLE THAT STOOD HERE TO
 * PROVE IT WAS WRONG TOO, AND IT IS CORRECTED RATHER THAN DELETED BECAUSE A NUMBER THAT ONCE READ AS
 * EVIDENCE SHOULD NOT SIMPLY VANISH. It said a reviewer put a `throw` at the top of `settleAnswer`
 * and all 1499 tests stayed green with `gate:types` clean. That does not reproduce. `settleAnswer`
 * has exactly one call site, `loop.ts:414`, taken on every answer reply and sitting outside the only
 * `try` in the loop, so a throw at its top escapes `runAgentTurn` on the most ordinary path there is.
 * Planted as `throw new Error(...)` it fails 50 tests across 4 files, and the counter below catches
 * it as well, because a `throw new ` written anywhere in `loop.ts` moves the file-wide needle from
 * one to two. Whatever was once run, that example demonstrates the opposite of what it was cited for.
 * The gap it pointed at is still real and the two plants further down are what show it, since what
 * escapes a file-wide needle is an exit that never writes the word `throw` in this file at all.
 * Naming one more helper was still the wrong fix, and that part stands: this is the third round in
 * which this docblock's scope has run ahead of its mechanism, and
 * the previous two were closed by naming one more helper - `requireBudget`, counted by its call
 * sites because its throw is written elsewhere and reading the body top to bottom is precisely how
 * it went uncounted twice. Naming helpers one at a time is how a list stays permanently one behind.
 *
 * SO THE THROWS ARE COUNTED FILE-WIDE INSTEAD, WHICH IS WIDER THAN NAMING HELPERS ONE AT A TIME AND
 * IS STILL NOT THE WHOLE CLASS. Two needles do it, both shaped like code rather than like prose:
 * `throw new ` appears once in the whole file and `throw error;` once, while a bare `throw ` appears
 * five more times inside comments, which would couple this test to English and teach the next reader
 * to bump the number.
 *
 * WHAT IT COVERS, EXACTLY: every `throw` WRITTEN IN `loop.ts`, including inside helpers this test
 * has never heard of. That is the sentence, and the previous one ran past it - it said counting
 * throws here "accounts for every exit any helper could add, whether or not this file has heard of
 * it", and both halves of that are false. WHAT IT DOES NOT COVER, each one planted and watched
 * rather than reasoned about:
 *   - A REJECTED PROMISE RETURNED RATHER THAN THROWN. `runAgentTurn` is async and awaits its
 *     helpers, so `return Promise.reject(...)` at the top of `runTool` leaves this function exactly
 *     as a throw would. Planted in `loop.ts` itself, in a helper this test already knows by name,
 *     and not one of the seven numbers below moved, because the body count is scoped to
 *     `runAgentTurn`'s own braces and the file-wide needles only look for `throw`.
 *   - A THROW WRITTEN IN A MODULE `loop.ts` IMPORTS. The counter reads `../src/agent/loop.ts` and
 *     nothing else, so a helper in any other file is invisible BY CONSTRUCTION, which is the exact
 *     opposite of what the old sentence claimed. Planted at the top of `parseToolCall` in
 *     `tools.ts`, reached from `runTool` OUTSIDE the try below that call, and again the seven
 *     numbers held still.
 *   - A throw of an already-built value under any other name.
 * Source counting cannot be made to cover that class, because the class is "code this test does not
 * read", and one more needle would be one behind again next round.
 *
 * BLIND HERE IS NOT SILENT IN THE SUITE, AND IT WAS MEASURED RATHER THAN ASSUMED. Neither plant got
 * out of the run. The first failed 59 tests across 5 files and the second 75 across 6, out of 1503,
 * seventeen of them in THIS file both times, in the arrangements above rather than in the counter
 * below. Every total in this docblock is the suite AS IT STOOD WHEN THAT PLANT WAS RUN, which is why
 * 1503 will not match a run made after anything adds a case. The failure counts are the finding. The
 * total is only there so the reader can see what fraction of the run went red.
 *
 * WHAT THAT PROVES IS NARROWER THAN "A NEW EXIT WOULD BE CAUGHT", AND THE SENTENCE HERE CLAIMED THE
 * WIDER THING FOR ONE ROUND. Both plants break tool dispatch UNCONDITIONALLY, on every call of every
 * arrangement, so those numbers establish that tool dispatch is heavily covered and nothing beyond
 * it. A new exit is a CONDITIONAL one, reached on an arrangement nothing drives yet, and the
 * refutation is sixty lines above in this same docblock: a reviewer added an exit returning an
 * `AgentAnswer` literal and 1494 tests stayed green. Behavioural coverage caught the unconditional
 * break and missed the conditional exit. Those are two different questions, and only the counter
 * below is aimed at the second one, which is the entire reason it is worth its cost.
 *
 * What is still not written is the assertion that names the property: drive a tool dispatch that
 * REJECTS, and assert the turn comes back as an `AgentAnswer` instead of escaping. That is
 * deliberately not done, because it is a change to what the loop CATCHES rather than to what this
 * test measures.
 */
describe('the loop has not grown an exit this file does not know about', () => {
  it('still ends in the same six statements the enumeration above was derived from', () => {
    const source = readFileSync(new URL('../src/agent/loop.ts', import.meta.url), 'utf8');
    const occurrences = (needle: string, within = source): number => within.split(needle).length - 1;
    const advice =
      'If this is a reflow, restore the single-line call. If an exit was added, moved or removed, ' +
      're-derive the EXITS docblock in this file and add the arrangement that reaches it.';

    const signature = 'export async function runAgentTurn(';
    const opens = source.indexOf(signature);
    // A guard on the guard. If the signature or the closing brace ever stops being findable, this
    // test would go on measuring an empty string and passing, which is the failure mode it exists
    // to remove rather than to demonstrate.
    expect(opens, `${signature} is not in loop.ts, so this tripwire is measuring nothing.`).toBeGreaterThan(-1);
    const closes = source.indexOf('\n}\n', opens);
    expect(closes, 'The end of runAgentTurn is not where this expects it.').toBeGreaterThan(opens);
    const body = source.slice(opens, closes);

    expect(occurrences('return endTurn('), advice).toBe(3);
    expect(occurrences('return answerFrom('), advice).toBe(2);
    // Nothing leaves this function by any other route. An exit that returns its own object literal
    // rather than calling a helper is a sixth return with nowhere to be accounted for.
    expect(occurrences('return ', body), advice).toBe(5);
    expect(occurrences('throw ', body), advice).toBe(0);
    // The two exits that produce no `AgentAnswer`, so neither has an arrangement in EXITS. Counted
    // across the WHOLE file rather than the body, because a helper is where the last one was hidden
    // and a throw is the only way OUT OF THIS FILE'S TEXT that a source count can see. The docblock
    // above names what that leaves uncovered; it is narrower than "every exit a helper could add".
    expect(occurrences('throw new '), advice).toBe(1);
    expect(occurrences('throw error;'), advice).toBe(1);
    expect(occurrences('requireBudget(', body), advice).toBe(2);
  });
});

/**
 * WHICH EXIT EACH CLOCK ARRANGEMENT ACTUALLY REACHED, which the label alone does not establish.
 *
 * `slower` records what happened without this: the arrangement named for the exit BETWEEN rounds
 * took the exit WITHIN a round under a fifty millisecond model reply, and passed, because the only
 * thing asked of it was that the turn not contradict itself. Both exits return the same fields, so
 * the assertion has to be on the transcript, and for each arrangement the shape below is reachable
 * by exactly one of its OWN exits. That is what makes these two tests worth their runtime.
 */
describe('the two clock arrangements reach the two exits they are named for', () => {
  const roles = (result: AgentAnswer): string[] => result.transcript.map((turn) => turn.role);

  // BETWEEN rounds: the model asked for one recall, it ran, and the turn ended at the top of the
  // next round. Taking the WITHIN-round exit instead means running out of time before announcing
  // the only call there was, which leaves `['user', 'refusal']` and no receipt at all.
  it('spends the budget between rounds, after a recall has landed', async () => {
    const result = await clockSpentBetweenRounds();

    expect(roles(result)).toEqual(['user', 'tool_call', 'tool_result', 'refusal']);
    expect(result.text).toContain('ran out of time');
    expect(result.recalls).toHaveLength(1);
    expect(result.coverage).toBe('COVERED');
  });

  // WITHIN a round: one reply asked for two recalls and only the first was ever announced. Reaching
  // the top-of-round exit instead requires the whole list to have been worked through, which is two
  // announcements and two results, so one pair is the fingerprint of this exit and only this one.
  it('spends the budget inside one reply, so the second call is never announced', async () => {
    const result = await clockSpentWithinARound();

    expect(roles(result)).toEqual(['user', 'tool_call', 'tool_result', 'refusal']);
    expect(result.text).toContain('ran out of time');
    expect(result.toolCallCount).toBe(1);
    // The model's own ids, kept in `given`. The second call left no trace anywhere in the turn.
    expect(JSON.stringify(result.transcript)).toContain('"given":"first"');
    expect(JSON.stringify(result.transcript)).not.toContain('second');
  });
});

describe('two calls get two ids, whatever the model called them', () => {
  it('does not echo one model id into two announcements and two receipts', async () => {
    const result = await run(
      forgetful(),
      repositoryReturning(recallResult({ coverage: 'COVERED', memories: [scoredMemory()] })),
    );

    const announced = result.transcript
      .filter((turn): turn is Extract<TurnView, { role: 'tool_call' }> => turn.role === 'tool_call')
      .map((turn) => turn.id);

    expect(announced).toHaveLength(2);
    expect(new Set(announced).size).toBe(2);
    expect(result.recalls).toHaveLength(2);
    expect(new Set(result.recalls.map((event) => event.callId)).size).toBe(2);
  });
});

const USER: TurnView = { role: 'user', content: 'has checkout been slow before?' };
const SAID: TurnView = { role: 'assistant', content: 'Checkout was slow in July.' };
// `id` AND `given` ARE THE SAME STRING IN THE HAND-BUILT FIXTURES BELOW, and that is a convenience
// rather than a claim about the loop, which mints `tc-1` and records what the model sent. These
// cases exist to drive the RULES, which read `id` and never `given`. What the loop really writes is
// covered by the exits above, which run it.
const CALLED: TurnView = { role: 'tool_call', id: 'call-1', given: 'call-1', name: 'recall', args: { query: 'x' } };
const RESULT: TurnView = { role: 'tool_result', id: 'call-1', name: 'recall', content: 'one row' };

const coherent = (): AgentAnswer => ({
  text: 'Checkout was slow in July.',
  transcript: [USER, CALLED, RESULT, SAID],
  recalls: [{ callId: 'call-1', result: recallResult({ coverage: 'COVERED', memories: [scoredMemory()] }) }],
  coverage: 'COVERED',
  refusedAnAbsenceClaim: false,
  toolCallCount: 1,
  modelId: 'scripted',
});

const withReturned = (returned: number): RecallResult => {
  const real = recallResult({ coverage: 'COVERED', memories: [scoredMemory()] });
  return { ...real, receipt: { ...real.receipt, returned } };
};

/**
 * One fault per case, and the rule that names it.
 *
 * BUILT FROM THE COHERENT TURN AND BROKEN AS NARROWLY AS THE FAULT ALLOWS, so a case cannot pass by
 * being wrong in some other way that happens to trip the same rule. The base is asserted coherent by
 * its own test below, which is what makes every difference here attributable.
 *
 * ONE FAULT PER CASE IS ENFORCED RATHER THAN PROMISED, which it was not until round seven found a
 * case quietly firing two. The assertion compares the WHOLE set of rules a case fires against the
 * one it names plus anything `ALSO_FIRES` records as unavoidable for it, so a case that starts
 * breaking a second thing turns red instead of going on reading as a proof about the first.
 *
 * THREE OF THEM CHANGE MORE THAN ONE FIELD AND CANNOT DO OTHERWISE, which is worth naming rather
 * than letting the sentence above read as absolute. `loopSentenceClaimsAbsence` replaces the last
 * turn and `text` together, because `text` must go on matching the record or the case would trip
 * `answerIsNotOnTheRecord` as well. The SECOND arm of `coverageWithoutARecall` changes three: the
 * announced call has to stop being a recall, the receipts have to go with it, and the verdict has to
 * be UNKNOWN, because the arm is about exactly that combination and no smaller break reaches it. The
 * second `answerIsNotOnTheRecord` case changes three for the same kind of reason: it has to set the
 * refusal flag, carry a refusal turn so `refusalFlagWithoutARefusal` stays quiet, and return a text
 * that is neither of the two forms the rule admits.
 *
 * `callWithoutResult` USED TO BE ONE OF THEM AND IS NOT ANY MORE, and the reason it gave was false.
 * It cleared `recalls` as well, on the stated grounds that a receipt left standing would also trip
 * `recallNeverAnnounced`. That rule keys on the tool CALL, built from the transcript, and this case
 * keeps the call and drops the RESULT, so the receipt stays announced and that rule never fires.
 * What clearing `recalls` actually did was leave `coverage` at COVERED with no receipt, which trips
 * the newer `coverageWithoutARecall` too, so the case reported two rules in the file that promises
 * one. It was invisible while the rule that caught it did not exist yet.
 */
const FAULTS: readonly (readonly [RuleId, string, AgentAnswer])[] = [
  ['transcriptEmpty', 'nothing was recorded', { ...coherent(), transcript: [] }],
  [
    'transcriptDoesNotOpenWithTheUser',
    'the message that started it is missing',
    { ...coherent(), transcript: [SAID] },
  ],
  [
    'toolCountAboveAnnouncements',
    'it counts a call it never announced',
    { ...coherent(), toolCallCount: 2 },
  ],
  ['toolCountNotACount', 'the count is negative', { ...coherent(), toolCallCount: -1 }],
  [
    'resultBeforeItsCall',
    'the answer arrives before the question',
    { ...coherent(), transcript: [USER, RESULT, CALLED, SAID] },
  ],
  [
    'callWithoutResult',
    'a call is announced and dropped',
    { ...coherent(), transcript: [USER, CALLED, SAID] },
  ],
  [
    // ONE FIELD, AND IT FIRES ONE RULE, which is worth saying because the obvious second change is
    // not needed: `toolCallCount` stays at 1 against two announcements, and that rule only fires
    // when the count EXCEEDS them. A turn counting fewer calls than it announced is the over-budget
    // case and is legal.
    'callAnnouncedTwice',
    'one id announces two calls',
    { ...coherent(), transcript: [USER, CALLED, CALLED, RESULT, SAID] },
  ],
  [
    'recallNeverAnnounced',
    'a receipt is keyed to nothing',
    {
      ...coherent(),
      recalls: [{ callId: 'call-9', result: recallResult({ coverage: 'COVERED', memories: [scoredMemory()] }) }],
    },
  ],
  [
    'recallAnnouncedAsAnotherTool',
    'the call that produced it asked for something else',
    {
      ...coherent(),
      transcript: [
        USER,
        { role: 'tool_call', id: 'call-1', given: 'call-1', name: 'remember', args: {} },
        RESULT,
        SAID,
      ],
    },
  ],
  [
    'recallIdsRepeated',
    'two receipts answer to one id',
    {
      ...coherent(),
      recalls: [
        { callId: 'call-1', result: recallResult({ coverage: 'COVERED', memories: [scoredMemory()] }) },
        { callId: 'call-1', result: recallResult({ coverage: 'COVERED', memories: [scoredMemory()] }) },
      ],
    },
  ],
  [
    'coverageBetterThanARecall',
    'the turn reports better coverage than a receipt it carries',
    {
      ...coherent(),
      recalls: [{ callId: 'call-1', result: recallResult({ coverage: 'UNKNOWN' }) }],
    },
  ],
  [
    'coverageMissingWithRecalls',
    'it carries a receipt and reports no verdict',
    { ...coherent(), coverage: null },
  ],
  [
    // THE MIRROR OF THE RULE ABOVE, and the guard declared this turn COHERENT until Codex read the
    // open PR. A verdict and its receipt are produced by one return in the loop, so COVERED with no
    // receipt is a receipt that went missing on the way to the reader. UNKNOWN with no receipt is
    // NOT a fault and has its own positive exit above: that is the arm where a recall threw.
    'coverageWithoutARecall',
    'a receipt went missing and left its verdict behind',
    { ...coherent(), recalls: [] },
  ],
  [
    // THE SECOND ARM OF THE SAME RULE, which the case above cannot reach: it keeps the recall in the
    // transcript and removes only the receipt, so the UNKNOWN exemption never has to decide anything.
    // Here the turn reports the verdict a THROWN recall produces while announcing no recall at all,
    // and a recall that threw was announced before it could throw. Three fields, for the reason the
    // docblock above gives.
    'coverageWithoutARecall',
    'it reports the thrown-recall verdict and never asked',
    {
      ...coherent(),
      transcript: [USER, { role: 'tool_call', id: 'call-1', given: 'call-1', name: 'remember', args: {} }, RESULT, SAID],
      recalls: [],
      coverage: 'UNKNOWN',
    },
  ],
  [
    'returnedDisagreesWithMemories',
    'the receipt counts rows that did not arrive',
    { ...coherent(), recalls: [{ callId: 'call-1', result: withReturned(4) }] },
  ],
  [
    'returnedNotACount',
    'the receipt reports minus one row',
    { ...coherent(), recalls: [{ callId: 'call-1', result: withReturned(-1) }] },
  ],
  [
    'refusalFlagWithoutARefusal',
    'it says it refused and shows no refusal',
    { ...coherent(), refusedAnAbsenceClaim: true },
  ],
  [
    'answerIsNotOnTheRecord',
    'the answer appears nowhere in the transcript',
    { ...coherent(), text: 'Something nobody said.' },
  ],
  [
    // THE SECOND FORM OF BEING ON THE RECORD, WHICH THE RULE USED TO ADMIT FROM ANY TURN AT ALL.
    // `refusalForTheUser` is the sentence the loop returns to the OPERATOR on a second refusal, and
    // it is deliberately not a transcript turn, so the rule has to admit it. Ungated, that admission
    // was an exemption nobody had read as a claim: it said a turn carrying that sentence is on the
    // record whatever else it shows. Here the flag is false and no turn carries the refusal role, so
    // the loop could not have produced this text, and until this case existed the gate that says so
    // was pinned by nothing.
    'answerIsNotOnTheRecord',
    'it returns the operator-facing refusal without having refused anything',
    { ...coherent(), text: refusalForTheUser('COVERED') },
  ],
  [
    // THE OTHER HALF OF THE SAME GATE, and with the case above alone only the FLAG half was pinned.
    // Mutating the gate to `operatorRefusal = facts.refusedAnAbsenceClaim` left every other case and
    // every exit green, so any turn that had refused once would have been exempt from this rule
    // altogether, which is a wider hole than the one the gate was added to close. Here the flag is
    // true AND a refusal turn is present, so the two rules about refusals stay quiet, and the text is
    // neither the last turn nor the operator sentence. Three fields, for the reason above.
    'answerIsNotOnTheRecord',
    'it refused once and then returned a sentence from nowhere',
    {
      ...coherent(),
      refusedAnAbsenceClaim: true,
      transcript: [
        USER,
        CALLED,
        RESULT,
        { role: 'refusal', content: 'Rewrite that to say only what the search established.' },
      ],
      text: 'Something nobody said.',
    },
  ],
  [
    'loopSentenceClaimsAbsence',
    'the loop asserts an absence in its own voice',
    {
      ...coherent(),
      transcript: [USER, CALLED, RESULT, { role: 'refusal', content: ABSENCE }],
      text: ABSENCE,
    },
  ],
  ['modelIdBlank', 'nothing is named as having answered', { ...coherent(), modelId: '   ' }],
];

/**
 * The cases that CANNOT fire one rule alone, with what else they fire.
 *
 * TWO CASES, THREE RULES EACH, AND THE CONTENTS WERE READ OFF THE FAILING ASSERTION RATHER THAN
 * REASONED. The first version of this table was written from an argument about what each case ought
 * to trip, listed `recallNeverAnnounced` for both, and was wrong for both: it is the right extra for
 * neither one on its own. That is the whole reason the assertion compares the set instead of
 * containing it, and it caught its author on the commit that added it.
 *
 * Both cases take the TRANSCRIPT away, and three separate rules read the transcript for something
 * the rest of the turn still refers to. Emptying it orphans the receipt, which is keyed to a call
 * that is now gone, and leaves the answer matching no turn at all. Replacing it with the assistant
 * turn alone orphans the receipt and leaves a tool count standing over nothing announced. Neither
 * can be narrowed: clearing `recalls` to quieten the orphan would leave COVERED with no receipt,
 * which is what `coverageWithoutARecall` refuses, and that trade is the mistake `callWithoutResult`
 * was carrying.
 *
 * KEYED BY THE LABEL, WHICH IS UNIQUE PER CASE, and not by the rule, because a rule-keyed table
 * would hand one case's exemption to every other case naming the same rule. FOUR RULES HAVE MORE
 * THAN ONE CASE, and this sentence said two of them and was made wrong by the commit it was written
 * in: `answerIsNotOnTheRecord` has three, `coverageWithoutARecall` two, and on the budget list,
 * which consults the same table, `budgetDayNotADay` has four and `budgetNotACount` two. A renamed
 * label drops out of this table and turns its case RED rather than quietly widening what that case
 * is allowed to fire, which is the safe direction for a lookup that grants permission.
 */
const ALSO_FIRES: Readonly<Record<string, readonly RuleId[]>> = {
  'nothing was recorded': ['recallNeverAnnounced', 'answerIsNotOnTheRecord'],
  'the message that started it is missing': ['recallNeverAnnounced', 'toolCountAboveAnnouncements'],
};

const asResponse = (answered: AgentAnswer, budget: AgentTurnResponse['budget']): AgentTurnResponse => ({
  text: answered.text,
  coverage: answered.coverage,
  refusedAnAbsenceClaim: answered.refusedAnAbsenceClaim,
  toolCallCount: answered.toolCallCount,
  modelId: answered.modelId,
  transcript: answered.transcript,
  recalls: answered.recalls.map((event) => toRecallEvent(event.callId, event.result, NOW)),
  budget,
});

const BUDGET_FAULTS: readonly (readonly [RuleId, string, AgentTurnResponse['budget']])[] = [
  ['budgetSpentAboveItsLimit', 'it spent past its own ceiling', { used: 51, limit: 50, day: '2026-08-10' }],
  // THAT GUARD IS `!isCount(limit) || (used !== null && !isCount(used))`, WHICH IS THREE CLAUSES AND
  // NOT TWO. The sentence here said two and named a half for each of these cases, which left the
  // third unaccounted for one commit after the round that was about unaccounted clauses. The
  // null test is pinned by the positive control below rather than by a row here, because that clause
  // exists to let a legal body THROUGH and no fault case can hold a clause like that.
  //
  // The ceiling and the spend pin the two `isCount` calls. Until the second row existed the right
  // operand had nothing at all holding it: every `used` any case fed was 3 or 51, both of them
  // counts, so it could be deleted with the suite still green. That is the same defect as the budget
  // day shape clause, recorded lower in this same table by the comment headed THE CASE ONLY THE
  // SHAPE CLAUSE CATCHES, found in the round that fixed that one. (Cited as `twenty lines up` until
  // a review measured it. That case is BELOW this one, not above, so the citation was wrong in
  // direction as well as in size, and twenty lines up lands inside `asResponse`.)
  //
  // THE TWO VALUES ALSO SPLIT `isCount` ITSELF, which is two clauses wearing one name. `-1` fails
  // `value >= 0` and passes `Number.isInteger`, and `2.5` does the reverse, so between them the
  // predicate has no clause that can be deleted quietly. Every non-count in this file used to be
  // `-1`, so `Number.isInteger` was decoration and `isCount(3.5)` would have been true.
  ['budgetNotACount', 'the ceiling is not a count', { used: 3, limit: -1, day: '2026-08-10' }],
  ['budgetNotACount', 'the count spent is not a whole number', { used: 2.5, limit: 50, day: '2026-08-10' }],
  [
    // A TWO CLAUSE CASE, AND IT PINS NEITHER OF THEM ALONE. Measured on node v22.22.0 at `ae8bd70`:
    // `today` fails the shape test AND parses to NaN, so deleting either clause leaves it red. It is
    // kept because it is the value a human actually types, not because it isolates anything.
    'budgetDayNotADay',
    'the day is a word',
    { used: 3, limit: 50, day: 'today' },
  ],
  [
    // THE CASE ONLY THE SHAPE CLAUSE CATCHES, and until it was added that clause was pinned by
    // NOTHING while the three cases around it read as covering the rule. Measured on node v22.22.0
    // at `ae8bd70`: deleting the shape test reddens NONE of the other cases, because every one of
    // their values fails a later clause as well. `+012026-08-10` is the expanded year notation,
    // which `Date.parse` accepts and `toISOString` reproduces BYTE IDENTICAL, so the NaN test and
    // the identity both wave it through and only the shape refuses it. This is the same defect the
    // case below was written to fix, one clause up, and it was standing in the commit that fixed it.
    'budgetDayNotADay',
    'the day is a real instant written in a notation this field never uses',
    { used: 3, limit: 50, day: '+012026-08-10' },
  ],
  [
    // THE CASE THE SHAPE RULE LETS THROUGH AND THE PARSE CATCHES. Measured on node v22.22.0 at
    // `766e3b3`: `2026-13-45` matches the shape and `Date.parse` returns NaN for it, so this pins
    // the NaN clause. That clause is not decoration, it is what stops `toISOString` throwing on the
    // very value the rule exists to report.
    'budgetDayNotADay',
    'the day has the right shape and is not a time at all',
    { used: 3, limit: 50, day: '2026-13-45' },
  ],
  [
    // THE CASE ONLY THE ROUND TRIP CATCHES, and without it that clause was pinned by NOTHING. The
    // comment on the case above USED to claim it pinned the round trip half. Measured: it does not.
    // Over 2020 to 2025 times every mm and dd from 00 to 99, 40 of 60000 values are caught only by
    // the identity and `2026-13-45` is not one of them, so deleting the identity left every test
    // green while the guard silently degraded to shape plus parse. THE WINDOW HAS TO BE NAMED, and
    // the sentence that stood here did not name one: the same sweep over 2026 to 2031 gives 41,
    // because a leap year falls in a different place in it, so the bare figure was underivable.
    // `2026-02-30` parses to the second of March, which is a real instant that is not the day
    // written.
    'budgetDayNotADay',
    'the day parses and names a different day than it writes',
    { used: 3, limit: 50, day: '2026-02-30' },
  ],
];

describe('each rule fires on the fault it names, and the guard is not vacuous', () => {
  it('finds nothing wrong with the turn every fault below is built from', () => {
    // THE CONTROL. Without it, a case could pass because the BASE was already broken, and the rule
    // would read as proven by a turn that was never coherent to begin with.
    expect(answerContradictions(coherent())).toEqual([]);
  });

  it('accepts a budget whose spend is null, which is a shape the contract allows', () => {
    // THE THIRD CLAUSE OF THE BUDGET COUNT GUARD, and no fault case can pin it, because that clause
    // exists to let a legal body THROUGH rather than to catch one. `BudgetView.used` is
    // `number | null` and `isCount(null)` is false, so rewriting `used !== null &&` to
    // `used === null ||` compiles and turns this body into a reported contradiction while every
    // fault case stays green. A positive control is the only shape of test that sees that.
    //
    // The web side already pins its own null branch, in `api-shape.test.ts`, which feeds a null
    // spend and asserts the console accepts the body. This is that assertion's missing sibling on
    // the API side, and the guard here is the one that would have to be wrong for both to matter.
    const budget = { used: null, limit: 50, day: '2026-08-10' };

    expect(responseContradictions(asResponse(coherent(), budget))).toEqual([]);
  });

  it('accepts a budget spent exactly to its ceiling, which is the last permitted turn of the day', () => {
    // THE BOUNDARY OF `used > limit`, THE BRANCH AFTER THE CLAUSE THAT JUST GOT A CONTROL, and it is
    // a let-through clause of exactly the same kind: it exists to admit a legal body, so no fault
    // case can pin it. Mutating `>` to `>=` reports a contradiction against a body this demo
    // produces every day. (This counted ONE LINE BELOW and it is two. What the argument needs is the
    // BRANCH, which survives a reformat, so it is named rather than measured.)
    //
    // FIVE FAULT CASES REACH THIS CLAUSE AND EXACTLY ONE TRIPS IT, a distinction the first version
    // of this comment collapsed into "the one fault case that reaches it". The one that TRIPS it
    // feeds 51 of 50, and 51 is above 50 under either operator, so it cannot tell them apart. The
    // four `budgetDayNotADay` cases PASS THROUGH at 3 of 50 and stay green either way. The two
    // `budgetNotACount` cases never arrive at all, because the branch above them is taken instead.
    // It does not RETURN, which the first version of this sentence said: `responseContradictions`
    // pushes and carries on into the day rule, which is why those two cases still get a day. Which
    // cases reach a clause and which cases exercise it are different questions, and only the second
    // one is worth writing down.
    //
    // IT IS REAL PRODUCED TRAFFIC RATHER THAN A HYPOTHETICAL, which is what makes it worth a test.
    // `demo-budget.ts` spends a call with `SET calls = calls + 1 WHERE day = $1 AND calls < $2`, so
    // the call made when `calls` sits one below the ceiling passes that WHERE, increments TO the
    // ceiling, and returns `allowed: true` carrying a spend equal to the limit. `server.ts` attaches
    // that to the turn. Every day's last permitted turn carries this exact body, and reporting it as
    // a turn that argues with itself would refuse the one turn a reader is most likely to inspect.
    const budget = { used: 50, limit: 50, day: '2026-08-10' };

    expect(responseContradictions(asResponse(coherent(), budget))).toEqual([]);
  });

  it.each(FAULTS)('%s: %s', (rule, label, broken) => {
    // THE WHOLE SET, NOT `toContain`, AND THE DIFFERENCE IS A DEFECT THIS FILE ALREADY SHIPPED. One
    // fault per case is a promise the docblock above makes, and until this line compared the whole
    // set nothing enforced it: `callWithoutResult` cleared `recalls` for a stated reason that was
    // false, which left COVERED standing with no receipt and fired `coverageWithoutARecall` too. A
    // containment assertion cannot see a second rule, so the case read as proving one thing while
    // proving two, and it was the arrival of the second rule that made it wrong rather than anything
    // the case itself changed. Every case that genuinely cannot fire alone declares what else it
    // fires, so the exceptions are data here rather than prose nobody checks.
    //
    // SORTED, because the order the rules come back in belongs to `turnContradictions` rather than
    // to this assertion, and pinning it here would turn a harmless reordering of the rule sets into
    // twenty red tests.
    expect([...answerContradictions(broken).map((one) => one.rule)].sort()).toEqual(
      [rule, ...(ALSO_FIRES[label] ?? [])].sort(),
    );
  });

  it.each(BUDGET_FAULTS)('%s: %s', (rule, label, budget) => {
    // THE SAME WHOLE-SET COMPARISON AS ABOVE, and it was left as `toContain` for one commit while
    // the `it.each(FAULTS)` assertion was converted, which is this file's own subject happening to
    // it. (That said `three lines up` until a review measured it at seven.)
    // A mechanism that covers one of two sibling lists is not a mechanism, it is a case that got
    // attention. Every budget case fires exactly one rule, so `ALSO_FIRES` is consulted for the same
    // reason rather than because any of them needs an entry today.
    expect(
      [...responseContradictions(asResponse(coherent(), budget)).map((one) => one.rule)].sort(),
    ).toEqual([rule, ...(ALSO_FIRES[label] ?? [])].sort());
  });

  it('drives every rule in the set, so none of them is a guard nobody can trigger', () => {
    // THE MECHANISM THAT KEEPS THIS HONEST. A rule added without a case that fires it fails here
    // rather than sitting in the set reading as coverage. A count would not do: it cannot tell a
    // rule that lost its case from one that gained a second.
    const driven = new Set<RuleId>([
      ...FAULTS.map(([rule]) => rule),
      ...BUDGET_FAULTS.map(([rule]) => rule),
    ]);

    expect([...driven].sort()).toEqual(Object.keys(RULES).sort());
  });

  it('keeps every case label unique, because the exemption table is keyed by one', () => {
    // THE MECHANISM UNDER `ALSO_FIRES`, which until now was an argument in its docblock. That table
    // grants a case permission to fire extra rules and is keyed by label, so two cases sharing a
    // label would hand one case's exemption to the other silently, and `it.each` would show it only
    // as two tests with the same name. A lookup that grants permission needs its key guarded, and
    // the docblock saying labels are unique is not a guard.
    const labels = [...FAULTS.map(([, label]) => label), ...BUDGET_FAULTS.map(([, label]) => label)];

    expect(new Set(labels).size).toBe(labels.length);
  });
});
