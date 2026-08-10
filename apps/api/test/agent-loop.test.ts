import { describe, expect, it } from 'vitest';
import type { Coverage, MemoryRepository, RememberInput } from '@throughline/memory';
import {
  judgeAnswer,
  refusalForTheUser,
  runAgentTurn,
  SYSTEM_PROMPT,
  worseOf,
  type ChatModel,
  type ChatReply,
  type Turn,
} from '../src/agent/loop.ts';
import { claimsAbsence } from '../src/agent/tools.ts';
import { createScriptedChatModel } from '../src/agent/local-model.ts';
import {
  fakeRepository,
  MEMORY_ID_A,
  MEMORY_ID_B,
  MEMORY_ID_C,
  memoryRecord,
  recallResult,
  repositoryReturning,
  scoredMemory,
} from './agent-fixtures.ts';

const recallCall = (query = 'checkout latency', id = 'call-1'): ChatReply => ({
  kind: 'tools',
  calls: [{ id, name: 'recall', args: { query } }],
});

const answer = (text: string): ChatReply => ({ kind: 'answer', text });

const ABSENCE = 'There are no prior incidents like this.';

function run(
  model: ChatModel,
  repository: MemoryRepository,
  maxToolCalls?: number,
): ReturnType<typeof runAgentTurn> {
  return runAgentTurn(
    { model, repository, workspaceId: 'demo', ...(maxToolCalls === undefined ? {} : { maxToolCalls }) },
    'has checkout been slow before?',
  );
}

describe('a straightforward turn', () => {
  it('recalls, answers, and reports what the recall established', async () => {
    const model = createScriptedChatModel([
      recallCall(),
      answer(`Memory ${MEMORY_ID_A} says restarting the checkout pods fixed it.`),
    ]);
    const result = await run(
      model,
      repositoryReturning(recallResult({ coverage: 'COVERED', memories: [scoredMemory()] })),
    );

    expect(result.text).toContain(MEMORY_ID_A);
    expect(result.coverage).toBe('COVERED');
    expect(result.toolCallCount).toBe(1);
    expect(result.refusedAnAbsenceClaim).toBe(false);
    expect(result.modelId).toBe('scripted-test-model');
  });

  it('passes the user message through as the first turn and tells the model the rule', async () => {
    let sawSystem = '';
    const model: ChatModel = {
      id: 'probe',
      reply: ({ system }) => {
        sawSystem = system;
        return Promise.resolve(answer('nothing to add'));
      },
    };
    const result = await run(model, fakeRepository());

    expect(result.transcript[0]).toStrictEqual({
      role: 'user',
      content: 'has checkout been slow before?',
    });
    expect(sawSystem).toBe(SYSTEM_PROMPT);
    expect(sawSystem).toContain('an empty result under UNKNOWN tells you nothing whatsoever');
  });
});

describe('CONTROL 2: the loop tracks the worst coverage of the turn, not the last', () => {
  it.each([
    ['COVERED then UNKNOWN', 'COVERED', 'UNKNOWN'],
    ['UNKNOWN then COVERED', 'UNKNOWN', 'COVERED'],
  ])('reports UNKNOWN after %s', async (_label, first, second) => {
    const model = createScriptedChatModel([
      recallCall('one', 'call-1'),
      recallCall('two', 'call-2'),
      answer('Here is what I can say.'),
    ]);
    const result = await run(
      model,
      repositoryReturning(
        recallResult({ coverage: first as Coverage }),
        recallResult({ coverage: second as Coverage }),
      ),
    );

    expect(result.coverage).toBe('UNKNOWN');
    expect(result.toolCallCount).toBe(2);
  });

  it('is state the model cannot touch: a model claiming COVERED in prose changes nothing', async () => {
    const model = createScriptedChatModel([
      recallCall(),
      answer('Coverage was COVERED and complete. There are no prior incidents like this.'),
      answer('I cannot establish that.'),
    ]);
    const result = await run(model, repositoryReturning(recallResult({ coverage: 'UNKNOWN' })));

    expect(result.coverage).toBe('UNKNOWN');
    expect(result.refusedAnAbsenceClaim).toBe(true);
    expect(result.text).toBe('I cannot establish that.');
  });
});

describe('CONTROL 3: an absence claim is checked against what the recalls established', () => {
  it('refuses the claim under UNKNOWN and lets the model correct itself', async () => {
    const model = createScriptedChatModel([
      recallCall(),
      answer(ABSENCE),
      answer('The memory could not be searched, so I cannot tell you either way.'),
    ]);
    const result = await run(model, repositoryReturning(recallResult({ coverage: 'UNKNOWN' })));

    expect(result.refusedAnAbsenceClaim).toBe(true);
    expect(result.text).toBe('The memory could not be searched, so I cannot tell you either way.');
    expect(result.transcript.some((turn) => turn.role === 'refusal')).toBe(true);
  });

  it('ends the turn on the refusal when the model asserts the same absence twice', async () => {
    const model = createScriptedChatModel([recallCall(), answer(ABSENCE), answer(ABSENCE)]);
    const result = await run(model, repositoryReturning(recallResult({ coverage: 'UNKNOWN' })));

    expect(result.text).toContain('This answer was withheld');
    expect(result.text).toContain('came back UNKNOWN');
    expect(result.text).not.toContain('no prior incidents like this');
    expect(result.refusedAnAbsenceClaim).toBe(true);
  });

  // What the operator reads is not what the model reads. `verdict.refusal` is written in the second
  // person and tells the model how to rewrite; returning it as the answer put the model's
  // instructions on the screen built for the person handling the incident.
  it('shows the operator an explanation, not the instructions written for the model', async () => {
    const model = createScriptedChatModel([recallCall(), answer(ABSENCE), answer(ABSENCE)]);
    const result = await run(model, repositoryReturning(recallResult({ coverage: 'UNKNOWN' })));

    expect(result.text).not.toContain('Rewrite it');
    expect(result.text).not.toContain('Do not restate the absence');
    expect(result.text).toBe(refusalForTheUser('UNKNOWN'));
    // The model-facing wording is still on the record, so the exchange stays auditable.
    const refusal = result.transcript.find((turn) => turn.role === 'refusal');
    expect(refusal?.role === 'refusal' && refusal.content).toContain('Rewrite it');
  });

  // EVERY exit from `runAgentTurn`, not one of them. Three separate rounds of review found this
  // same defect on three different paths, and each time the test that asserted the property drove
  // only the path that had just been fixed, so the next instance was invisible. A test claiming
  // "on any path" has to enumerate the paths.
  // Five scenarios across the three exits `runAgentTurn` has (two pairs share a return statement).
  it('never puts its own words under the assistant role, on any exit', async () => {
    const insatiable: ChatModel = {
      id: 'insatiable',
      reply: () =>
        Promise.resolve({ kind: 'tools', calls: [{ id: 'c', name: 'recall', args: { query: 'x' } }] }),
    };
    const empty: ChatModel = {
      id: 'empty',
      reply: () => Promise.resolve({ kind: 'tools', calls: [] }),
    };
    const covered = recallResult({ coverage: 'COVERED', memories: [] });

    const runs = await Promise.all([
      // permitted answer
      run(createScriptedChatModel([recallCall(), answer('All clear.')]), repositoryReturning(covered)),
      // one refusal then a correction
      run(
        createScriptedChatModel([recallCall(), answer(ABSENCE), answer('I cannot say.')]),
        repositoryReturning(recallResult({ coverage: 'UNKNOWN' })),
      ),
      // two refusals, turn ends on the refusal
      run(
        createScriptedChatModel([recallCall(), answer(ABSENCE), answer(ABSENCE)]),
        repositoryReturning(recallResult({ coverage: 'UNKNOWN' })),
      ),
      // round cap reached while asking for tools
      run(insatiable, repositoryReturning(covered), 2),
      // round cap reached while asking for nothing
      run(empty, repositoryReturning(covered), 2),
    ]);

    // Sentences only this file writes. If one turns up under `assistant`, the loop is speaking as
    // the model.
    const loopAuthored = [
      'This answer was withheld',
      'ran out of room before reaching an answer',
      'That answer says something does not exist',
      'has already used its',
    ];
    for (const result of runs) {
      for (const turn of result.transcript) {
        if (turn.role !== 'assistant') continue;
        for (const phrase of loopAuthored) {
          expect(turn.content, `assistant turn carried loop text: ${turn.content}`).not.toContain(
            phrase,
          );
        }
      }
    }
  });

  // The transcript must never put the loop's words under the model's role, on ANY path. The first
  // version of this fix got the single-refusal path right and left the double-refusal path pushing
  // `refusalForTheUser` as an `assistant` turn, which both misattributed the loop and DROPPED what
  // the model actually said. Every existing test looked at the first refusal turn, so none could
  // see it.
  it('records what the model really said on the second refusal, and claims none of it', async () => {
    const secondAnswer = 'Still: there are no prior incidents like this. MARKER-42';
    const model = createScriptedChatModel([recallCall(), answer(ABSENCE), answer(secondAnswer)]);
    const result = await run(model, repositoryReturning(recallResult({ coverage: 'UNKNOWN' })));

    const assistantTurns = result.transcript
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => (turn.role === 'assistant' ? turn.content : ''));

    expect(assistantTurns).toStrictEqual([ABSENCE, secondAnswer]);
    for (const said of assistantTurns) {
      expect(said).not.toContain('This answer was withheld');
    }
    // Both refusals are on the record, each in the loop's own role.
    expect(result.transcript.filter((turn) => turn.role === 'refusal')).toHaveLength(2);
    // And the operator still gets the explanation rather than either model answer.
    expect(result.text).toBe(refusalForTheUser('UNKNOWN'));
  });

  it('says which verdict withheld the answer, including when nothing was recalled', () => {
    expect(refusalForTheUser(null)).toContain('no search of the incident memory ran');
    expect(refusalForTheUser('PARTIAL')).toContain('came back PARTIAL');
    // It must not trip the very check that produced it, or a later reader of the transcript that
    // re-judges the text would refuse the explanation for the refusal.
    expect(claimsAbsence(refusalForTheUser('UNKNOWN'))).toBe(false);
  });

  it('permits the same sentence when a COVERED recall actually established it', async () => {
    const model = createScriptedChatModel([recallCall(), answer(ABSENCE)]);
    const result = await run(
      model,
      repositoryReturning(recallResult({ coverage: 'COVERED', memories: [] })),
    );

    expect(result.text).toBe(ABSENCE);
    expect(result.refusedAnAbsenceClaim).toBe(false);
  });

  it('refuses an absence claim from a turn that never recalled at all', async () => {
    const model = createScriptedChatModel([answer(ABSENCE), answer('I have not looked.')]);
    const result = await run(model, fakeRepository());

    expect(result.coverage).toBeNull();
    expect(result.refusedAnAbsenceClaim).toBe(true);
    expect(result.transcript.some((turn) =>
      turn.role === 'refusal' && turn.content.includes('you did not recall anything at all'),
    )).toBe(true);
  });

  // The refusal is the LOOP speaking. It used to be pushed as a `tool_result` carrying an id no
  // `tool_call` had announced, which both the Bedrock Converse API and the Anthropic Messages API
  // reject outright, so the shape would have passed every test here and failed on first contact
  // with a real provider.
  it('never emits a tool result for an id no tool call announced', async () => {
    const model = createScriptedChatModel([recallCall(), answer(ABSENCE), answer('I cannot say.')]);
    const result = await run(model, repositoryReturning(recallResult({ coverage: 'UNKNOWN' })));

    const announced = new Set(
      result.transcript.filter((turn): turn is Extract<Turn, { role: 'tool_call' }> =>
        turn.role === 'tool_call',
      ).map((turn) => turn.id),
    );
    for (const turn of result.transcript) {
      if (turn.role === 'tool_result') {
        expect(announced.has(turn.id), `tool_result ${turn.id} was never announced`).toBe(true);
      }
    }
    expect(result.transcript.filter((turn) => turn.role === 'refusal')).toHaveLength(1);
  });
});

describe('a recall that FAILS cannot leave the turn looking covered', () => {
  // The regression this file exists for. A recall that THREW used to return no coverage at all, so
  // a turn that recalled once COVERED and then hit a database error kept COVERED as its verdict,
  // and the absence claim was permitted on the strength of a search that had broken.
  it('degrades the turn to UNKNOWN when a later recall throws', async () => {
    let calls = 0;
    const repository = fakeRepository({
      recall: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(recallResult({ coverage: 'COVERED', memories: [scoredMemory()] }))
          : Promise.reject(new Error('connection terminated unexpectedly'));
      },
    });
    const model = createScriptedChatModel([
      recallCall('one', 'call-1'),
      recallCall('two', 'call-2'),
      answer(ABSENCE),
      answer('The second search failed, so I cannot tell you.'),
    ]);
    const result = await run(model, repository);

    expect(result.coverage).toBe('UNKNOWN');
    expect(result.refusedAnAbsenceClaim).toBe(true);
    expect(result.text).toBe('The second search failed, so I cannot tell you.');
  });

  // This test used to assert the OPPOSITE of its second half: that the thrown message reached the
  // model, so a failing recall put "statement timeout" in the transcript. That was deliberate and it
  // was wrong, for a reason nothing in this file could see. The HTTP surface returns the whole
  // transcript on a 200, so a tool_result is a response body, and a review proved a role ARN
  // reaching a caller through exactly this line by rejecting a recall with an AccessDeniedException.
  //
  // The trade is stated rather than assumed: the model loses detail it could not act on anyway,
  // because "the search could not run" is the entire operable content of a provider failure. The
  // detail goes to the operator's log instead, which is the reader who can do something with it.
  it('tells the model the failure is not a result, without quoting what threw', async () => {
    const repository = fakeRepository({
      recall: () => Promise.reject(new Error('statement timeout at arn:aws:sts::123456789012:role/x')),
    });
    const model = createScriptedChatModel([recallCall(), answer('I could not search.')]);
    const result = await run(model, repository);

    const toolResult = result.transcript.find((turn) => turn.role === 'tool_result');
    const content = toolResult?.role === 'tool_result' ? toolResult.content : '';
    expect(content).toContain('Do not treat this as a result');
    expect(content).not.toContain('statement timeout');
    expect(content).not.toContain('arn:aws');
    expect(result.coverage).toBe('UNKNOWN');
  });

  // Scoped to recall on purpose. A failed write says nothing about what a completed search found,
  // and degrading the verdict there would refuse answers the recall genuinely established.
  it('leaves coverage alone when a tool that is not recall fails', async () => {
    const repository = fakeRepository({
      recall: () => Promise.resolve(recallResult({ coverage: 'COVERED', memories: [] })),
      remember: () => Promise.reject(new Error('the insert returned no row')),
    });
    const model = createScriptedChatModel([
      recallCall(),
      {
        kind: 'tools',
        calls: [
          {
            id: 'call-2',
            name: 'remember',
            args: { kind: 'observation', content: 'x', assertedBy: 'human:ana' },
          },
        ],
      },
      answer(ABSENCE),
    ]);
    const result = await run(model, repository);

    expect(result.coverage).toBe('COVERED');
    expect(result.text).toBe(ABSENCE);
    expect(result.refusedAnAbsenceClaim).toBe(false);
  });
});

describe('the tool budget and the round budget are different limits', () => {
  const alwaysAsksForTools: ChatModel = {
    id: 'insatiable',
    reply: () =>
      Promise.resolve({ kind: 'tools', calls: [{ id: 'c', name: 'recall', args: { query: 'x' } }] }),
  };

  it('stops a model that never stops asking, instead of spinning forever', async () => {
    const result = await run(
      alwaysAsksForTools,
      repositoryReturning(recallResult({ coverage: 'COVERED' })),
      2,
    );

    expect(result.toolCallCount).toBe(2);
    expect(result.text).toContain('ran out of room');
    expect(result.text).toContain('nothing here says that anything is absent from memory');
  });

  // The budget path used to push a `tool_result` and skip the `tool_call` push entirely, so it
  // emitted results for ids nothing had announced: the same defect the `refusal` role was added to
  // remove, left standing on the one path the invariant test above did not drive. Fixing the first
  // instance and asserting the property from a test that could not see the second is exactly how a
  // fix ends up worse than the bug.
  it('announces every tool call it answers, including the ones it refuses for budget', async () => {
    const threeAtOnce: ChatModel = {
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
    };
    const result = await run(threeAtOnce, repositoryReturning(recallResult()), 2);

    const calls = result.transcript.filter(
      (turn): turn is Extract<Turn, { role: 'tool_call' }> => turn.role === 'tool_call',
    );
    const announced = new Set(calls.map((turn) => turn.id));
    for (const turn of result.transcript) {
      if (turn.role === 'tool_result') {
        expect(announced.has(turn.id), `tool_result ${turn.id} was never announced`).toBe(true);
      }
    }

    // EIGHTEEN ANNOUNCEMENTS, AND THIS TEST USED TO SEE THREE. The model asks for the same three
    // calls every round and the loop runs six rounds against a budget of two, so eighteen calls
    // really are announced. Every one of them used to be announced under one of THREE ids, because
    // the loop echoed the id the model sent, so six announcements and six results shared each id and
    // nothing keyed on it could attribute any of them. The assertion here read the SET and found
    // three, which is exactly how a turn with six collisions per id read as correct.
    expect(calls).toHaveLength(18);
    expect(announced.size).toBe(calls.length);
    // The model's own ids are still on the record, and they are the three it kept reusing. Its
    // third call, the one refused for budget, is among them, which is what this test is named for.
    expect(new Set(calls.map((turn) => turn.given))).toEqual(new Set(['a', 'b', 'c']));
    expect(result.toolCallCount).toBe(2);
  });

  it('tells the model its budget is spent rather than silently dropping the call', async () => {
    const result = await run(
      alwaysAsksForTools,
      repositoryReturning(recallResult({ coverage: 'COVERED' })),
      1,
    );

    const spent = result.transcript.filter(
      (turn) => turn.role === 'tool_result' && turn.content.includes('already used its 1 tool calls'),
    );
    expect(spent.length).toBeGreaterThan(0);
  });

  it('terminates when the model asks for no tools at all, rather than looping on an empty list', async () => {
    const asksForNothing: ChatModel = {
      id: 'empty',
      reply: () => Promise.resolve({ kind: 'tools', calls: [] }),
    };
    const result = await run(asksForNothing, fakeRepository(), 2);

    expect(result.toolCallCount).toBe(0);
    expect(result.text).toContain('ran out of room');
  });

  it('charges a malformed tool call to the budget, so garbage cannot buy extra turns', async () => {
    const model = createScriptedChatModel([
      { kind: 'tools', calls: [{ id: 'bad', name: 'recall', args: { query: '' } }] },
      answer('I will stop.'),
    ]);
    const result = await run(model, fakeRepository(), 4);

    expect(result.toolCallCount).toBe(1);
    const refusal = result.transcript.find((turn) => turn.role === 'tool_result');
    expect(refusal?.role === 'tool_result' && refusal.content).toContain('do not fit recall');
  });

  it('refuses an invented tool by name without ending the turn', async () => {
    const model = createScriptedChatModel([
      { kind: 'tools', calls: [{ id: 'x', name: 'delete_everything', args: {} }] },
      answer('Understood.'),
    ]);
    const result = await run(model, fakeRepository(), 4);

    const refusal = result.transcript.find((turn) => turn.role === 'tool_result');
    expect(refusal?.role === 'tool_result' && refusal.content).toContain(
      'There is no tool called "delete_everything"',
    );
    expect(result.text).toBe('Understood.');
  });
});

describe('dispatch', () => {
  it('writes a memory with the provenance the model supplied and nothing invented', async () => {
    let captured: RememberInput | null = null;
    const repository = fakeRepository({
      remember: (input) => {
        captured = input;
        return Promise.resolve(memoryRecord({ id: MEMORY_ID_B }));
      },
    });
    const model = createScriptedChatModel([
      {
        kind: 'tools',
        calls: [
          {
            id: 'w',
            name: 'remember',
            args: {
              kind: 'rejected_hypothesis',
              content: 'Scaling the pods did NOT help.',
              assertedBy: 'human:oncall-ana',
              incidentId: 'INC-42',
            },
          },
        ],
      },
      answer('Recorded.'),
    ]);
    await run(model, repository);

    expect(captured).not.toBeNull();
    expect(captured!).toMatchObject({
      workspaceId: 'demo',
      kind: 'rejected_hypothesis',
      provenance: { assertedBy: 'human:oncall-ana', incidentId: 'INC-42', sourceRef: null },
    });
  });

  it('says a stored memory is not yet semantically recallable, because it is not', async () => {
    const repository = fakeRepository({
      remember: () => Promise.resolve(memoryRecord({ id: MEMORY_ID_B })),
    });
    const model = createScriptedChatModel([
      {
        kind: 'tools',
        calls: [
          {
            id: 'w',
            name: 'remember',
            args: { kind: 'observation', content: 'x', assertedBy: 'agent' },
          },
        ],
      },
      answer('done'),
    ]);
    const result = await run(model, repository);

    const stored = result.transcript.find(
      (turn) => turn.role === 'tool_result' && turn.content.startsWith('Stored as'),
    );
    expect(stored?.role === 'tool_result' && stored.content).toContain(
      'unembedded, so it will not be found by semantic recall',
    );
  });

  it('reports a supersede as a closed window rather than a deletion', async () => {
    const closedAt = new Date('2026-08-05T14:00:00.000Z');
    const repository = fakeRepository({
      supersede: () =>
        Promise.resolve({
          previous: memoryRecord({ id: MEMORY_ID_A, validUntil: closedAt }),
          replacement: memoryRecord({ id: MEMORY_ID_B }),
        }),
    });
    const model = createScriptedChatModel([
      {
        kind: 'tools',
        calls: [
          {
            id: 's',
            name: 'supersede',
            args: {
              previousId: MEMORY_ID_A,
              kind: 'runbook_fact',
              content: 'The runbook moved to the new dashboard.',
              assertedBy: 'human:ana',
            },
          },
        ],
      },
      answer('Superseded.'),
    ]);
    const result = await run(model, repository);

    const outcome = result.transcript.find(
      (turn) => turn.role === 'tool_result' && turn.content.includes('supersedes'),
    );
    expect(outcome?.role === 'tool_result' && outcome.content).toContain(
      `${MEMORY_ID_B} now supersedes ${MEMORY_ID_A}`,
    );
    expect(outcome?.role === 'tool_result' && outcome.content).toContain(closedAt.toISOString());
    expect(outcome?.role === 'tool_result' && outcome.content).toContain('is not deleted');
  });

  it('calls a missing memory a real absence, because a lookup by id is not a search', async () => {
    const repository = fakeRepository({ getById: () => Promise.resolve(null) });
    const model = createScriptedChatModel([
      { kind: 'tools', calls: [{ id: 'i', name: 'inspect', args: { memoryId: MEMORY_ID_C } }] },
      answer('Not there.'),
    ]);
    const result = await run(model, repository);

    const outcome = result.transcript.find((turn) => turn.role === 'tool_result');
    expect(outcome?.role === 'tool_result' && outcome.content).toContain(
      'This is a real absence: it was a direct lookup by primary key, not a search.',
    );
    // A lookup miss is not a recall, so it must not set a coverage verdict either way.
    expect(result.coverage).toBeNull();
  });

  it('renders an inspected memory with its provenance', async () => {
    const repository = fakeRepository({ getById: () => Promise.resolve(memoryRecord()) });
    const model = createScriptedChatModel([
      { kind: 'tools', calls: [{ id: 'i', name: 'inspect', args: { memoryId: MEMORY_ID_A } }] },
      answer('Read it.'),
    ]);
    const result = await run(model, repository);

    const outcome = result.transcript.find((turn) => turn.role === 'tool_result');
    expect(outcome?.role === 'tool_result' && outcome.content).toContain('asserted by human:oncall-ana');
  });

  it('admits that forget changes nothing, rather than implying a removal', async () => {
    const model = createScriptedChatModel([
      {
        kind: 'tools',
        calls: [{ id: 'f', name: 'forget', args: { memoryId: MEMORY_ID_A, reason: 'it was wrong' } }],
      },
      answer('Nothing changed.'),
    ]);
    const result = await run(model, fakeRepository());

    const outcome = result.transcript.find((turn) => turn.role === 'tool_result');
    expect(outcome?.role === 'tool_result' && outcome.content).toContain('forget is not wired up yet');
    expect(outcome?.role === 'tool_result' && outcome.content).toContain(MEMORY_ID_A);
  });
});

// These two pin LIMITS, not protections. Both are cases where an absence claim is permitted that a
// stricter reading would refuse, both are consequences of decisions taken deliberately, and both
// are written down here so that the next person meets them as a documented boundary rather than as
// a surprise in production. If either behaviour is ever tightened, these tests are where the change
// announces itself.
describe('what the controls deliberately do NOT bind', () => {
  it('permits an absence claim about a subject the turn never searched for', async () => {
    const model = createScriptedChatModel([
      recallCall('checkout latency'),
      answer('There are no prior incidents involving the payments database.'),
    ]);
    const result = await run(
      model,
      repositoryReturning(recallResult({ coverage: 'COVERED', memories: [] })),
    );

    // The guarantee is per TURN: some recall completed, so the claim stands. Binding it to the
    // SUBJECT would need the sentence matched against the queries actually run, which is a
    // semantic judgement this loop refuses to make.
    expect(result.refusedAnAbsenceClaim).toBe(false);
    expect(result.text).toContain('payments database');
  });

  it('leaves the verdict alone when a recall is refused by the schema rather than attempted', async () => {
    const model = createScriptedChatModel([
      recallCall('checkout latency', 'call-1'),
      { kind: 'tools', calls: [{ id: 'call-2', name: 'recall', args: { query: '' } }] },
      answer(ABSENCE),
    ]);
    const result = await run(
      model,
      repositoryReturning(recallResult({ coverage: 'COVERED', memories: [] })),
    );

    // A malformed argument list never reached the repository, so nothing about the store changed.
    // Degrading here would be permanent, because `worseOf` only moves downwards: one bad argument
    // would pin the turn at UNKNOWN even after a clean retry.
    expect(result.coverage).toBe('COVERED');
    expect(result.refusedAnAbsenceClaim).toBe(false);
  });
});

describe('worseOf', () => {
  it.each([
    ['nothing yet and COVERED', null, 'COVERED', 'COVERED'],
    ['COVERED then PARTIAL', 'COVERED', 'PARTIAL', 'PARTIAL'],
    ['PARTIAL then COVERED', 'PARTIAL', 'COVERED', 'PARTIAL'],
    ['COVERED then UNKNOWN', 'COVERED', 'UNKNOWN', 'UNKNOWN'],
    ['UNKNOWN then COVERED', 'UNKNOWN', 'COVERED', 'UNKNOWN'],
    ['PARTIAL then UNKNOWN', 'PARTIAL', 'UNKNOWN', 'UNKNOWN'],
  ])('takes %s to %s', (_label, left, right, expected) => {
    expect(worseOf(left as Coverage | null, right as Coverage)).toBe(expected);
  });

  // The allowlist. Through `indexOf`, an unrecognised verdict scored -1 and `indexOf(left) >= -1`
  // is true for every left, so the bad value was silently DROPPED and the previous verdict
  // survived. When the previous verdict is COVERED, that is what permits an absence claim.
  it.each([
    ['an unrecognised new verdict against COVERED', 'COVERED', 'covered'],
    ['an unrecognised new verdict against nothing', null, 'sort of'],
    ['an unrecognised held verdict', 'COVERED_ISH', 'COVERED'],
  ])('treats %s as UNKNOWN', (_label, left, right) => {
    expect(worseOf(left as Coverage | null, right as Coverage)).toBe('UNKNOWN');
  });
});

describe('judgeAnswer', () => {
  it.each([
    ['an ordinary answer with no absence claim', 'The pods were restarted.', 'UNKNOWN', true],
    ['an absence claim under COVERED', ABSENCE, 'COVERED', true],
    ['an absence claim under PARTIAL', ABSENCE, 'PARTIAL', false],
    ['an absence claim under UNKNOWN', ABSENCE, 'UNKNOWN', false],
  ])('permits %s: %s', (_label, text, coverage, permitted) => {
    expect(judgeAnswer(text, coverage as Coverage).permitted).toBe(permitted);
  });

  it('refuses an absence claim when nothing was recalled, and says so in those words', () => {
    const verdict = judgeAnswer(ABSENCE, null);
    expect(verdict.permitted).toBe(false);
    expect(verdict.refusal).toContain('you did not recall anything at all this turn');
    expect(verdict.refusal).toContain('Do not restate the absence');
  });

  it('names the verdict it refused on, so the model can act on the reason', () => {
    expect(judgeAnswer(ABSENCE, 'PARTIAL').refusal).toContain('the recall came back PARTIAL');
  });

  it('leaves the refusal empty when it permits, rather than carrying dead text', () => {
    expect(judgeAnswer('All fine.', 'COVERED').refusal).toBe('');
  });
});
