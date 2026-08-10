/**
 * The agent turn judged against itself, on every exit the loop has.
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

import { describe, expect, it } from 'vitest';
import type { AgentTurnResponse, TurnView } from '@throughline/contract';
import type { ChatModel, ChatReply } from '../src/agent/loop.ts';
import type { MemoryRepository, RecallResult } from '@throughline/memory';
import { refusalForTheUser, runAgentTurn, type AgentAnswer } from '../src/agent/loop.ts';
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
): Promise<AgentAnswer> {
  return runAgentTurn(
    { model, repository, workspaceId: 'demo', ...(maxToolCalls === undefined ? {} : { maxToolCalls }) },
    'has checkout been slow before?',
  );
}

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
 * THAT DECISION WAS REVERSED IN `de773d8` AND EVERY SENTENCE ABOVE IS HISTORY. The loop mints its
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
 * EVERY EXIT, ENUMERATED FROM `loop.ts` RATHER THAN FROM THE CASES THAT CAME TO MIND.
 *
 * `runAgentTurn` returns from THREE places, read at `de773d8`: `loop.ts:207`, `:232` and `:254`, the
 * round cap, a permitted answer and a second refusal. This said four and counted the round cap
 * twice, once for the empty tool list, which is the same statement reached by another route. The
 * module beside this one was corrected for that exact miscount in the commit that should have
 * corrected this line too, which is the sibling file half of the shape this whole branch keeps
 * closing.
 *
 * AND THEN IT HAPPENED AGAIN, TO THESE THREE NUMBERS, IN THE PARAGRAPH SAYING SO. They read 202, 227
 * and 249 until round nine, because the commit that re-derived every citation in the module beside
 * this one walked past the sibling file whose whole subject is that sibling files get walked past.
 * The numbers carry the anchor now for the reason that module gives.
 *
 * Reaching each of the three is not the same as covering the loop, so the arrangements below also
 * drive the paths that BUILD the fields the rules
 * read: an over budget call, which is announced without being counted, a recall that throws, which
 * moves the verdict and leaves no receipt, a tool that is not a recall, and several calls in one
 * round, which is the only way two receipts land in one turn.
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
  // day shape clause, twenty lines up, in the same function, found in the round that fixed that one.
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
    // the assertion three lines up was converted, which is this file's own subject happening to it.
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
