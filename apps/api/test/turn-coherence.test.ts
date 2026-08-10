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
 * over twelve arrangements and asserts that `answerContradictions` finds nothing. The negative half
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
 * THE FIRST ROW IS WHY THIS FILE EXISTS. Nothing in `apps/api/test` compares a recall receipt to the
 * call that asked for it: a grep for `callId` there returns two lines, both in `server.test.ts`, of
 * which one is a type annotation inside a cast and the other is the single assertion, comparing the
 * id against a LITERAL rather than against the transcript. So a receipt keyed to an id no `tool_call`
 * announced was invisible to 47 tests, and it is the thing the console reads to line a receipt up
 * with its request.
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
import { runAgentTurn, type AgentAnswer } from '../src/agent/loop.ts';
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
 * A model that never stops asking, WITH A FRESH ID EACH TIME.
 *
 * THE GUARD FOUND SOMETHING ON ITS FIRST RUN AND THIS IS THE HONEST RECORD OF IT. The first version
 * of this model returned the same literal call id every round, copying the fixture in
 * `agent-loop.test.ts`, and `recallIdsRepeated` fired: the turn came back carrying several recall
 * receipts all keyed to one id, which a console cannot attribute to the request that produced each.
 * `loop.ts` echoes `call.id` exactly as the model supplied it and validates nothing about it, which
 * is already carried as a known gap.
 *
 * THE LOOP IS NOT CHANGED HERE, and that is a decision rather than an oversight. Nothing in
 * production repeats an id: `createChatModel` in `local-model.ts` throws for every provider except
 * the local one, so `createLocalChatModel` is the only model that can reach the loop and it numbers
 * its calls `recall-1` upward within a turn. `createScriptedChatModel`, used here and by
 * `agent-loop.test.ts`, is the TEST model, and the only producers of a repeat are fixtures reusing a
 * literal. Making the loop refuse a repeat
 * would not fix the deeper half either, because the transcript would still carry two `tool_call`
 * turns under one id, and the fix that does close that has to choose between an id that is unique
 * and an id that is what the model actually sent. That is a design change, not a patch, and it
 * belongs in its own unit with the provider adapter that will care about it.
 *
 * So the RULE stays, because catching this is the guard's job, and the fixture stops modelling the
 * defect while pretending to model the loop.
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

const throwing = (): MemoryRepository =>
  fakeRepository({ recall: () => Promise.reject(new Error('the cluster refused the connection')) });

/**
 * EVERY EXIT, ENUMERATED FROM `loop.ts` RATHER THAN FROM THE CASES THAT CAME TO MIND.
 *
 * `runAgentTurn` returns from THREE places, at `loop.ts:202`, `:227` and `:249`: the round cap, a
 * permitted answer and a second refusal. This said four and counted the round cap twice, once for
 * the empty tool list, which is the same statement reached by another route. The module beside this
 * one was corrected for that exact miscount in the commit that should have corrected this line too,
 * which is the sibling file half of the shape this whole branch keeps closing.
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

const USER: TurnView = { role: 'user', content: 'has checkout been slow before?' };
const SAID: TurnView = { role: 'assistant', content: 'Checkout was slow in July.' };
const CALLED: TurnView = { role: 'tool_call', id: 'call-1', name: 'recall', args: { query: 'x' } };
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
 * TWO OF THEM CHANGE TWO FIELDS AND CANNOT DO OTHERWISE, which is worth naming rather than letting
 * the sentence above read as absolute. `callWithoutResult` drops the `tool_result` turn and clears
 * `recalls`, because a receipt keyed to a call whose result never arrived would also trip
 * `recallNeverAnnounced` and the case would stop being about one rule. `loopSentenceClaimsAbsence`
 * replaces the last turn and `text` together, because `text` must go on matching the record or the
 * case would trip `answerIsNotOnTheRecord` as well.
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
    { ...coherent(), transcript: [USER, CALLED, SAID], recalls: [] },
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
        { role: 'tool_call', id: 'call-1', name: 'remember', args: {} },
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
  ['budgetNotACount', 'the ceiling is not a count', { used: 3, limit: -1, day: '2026-08-10' }],
  ['budgetDayNotADay', 'the day is a word', { used: 3, limit: 50, day: 'today' }],
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
    // Over six years times every mm and dd from 00 to 99, 40 of 60000 values are caught only by the
    // identity and `2026-13-45` is not one of them, so deleting the identity left every test green
    // while the guard silently degraded to shape plus parse. `2026-02-30` parses to the second of
    // March, which is a real instant that is not the day written.
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

  it.each(FAULTS)('%s: %s', (rule, _label, broken) => {
    expect(answerContradictions(broken).map((one) => one.rule)).toContain(rule);
  });

  it.each(BUDGET_FAULTS)('%s: %s', (rule, _label, budget) => {
    expect(responseContradictions(asResponse(coherent(), budget)).map((one) => one.rule)).toContain(rule);
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
});
