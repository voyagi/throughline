import { describe, expect, it } from 'vitest';
import type { Coverage, MemoryRepository, RememberInput } from '@throughline/memory';
import {
  judgeAnswer,
  runAgentTurn,
  SYSTEM_PROMPT,
  worseOf,
  type ChatModel,
  type ChatReply,
  type Turn,
} from '../src/agent/loop.ts';
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

    expect(result.text).toContain('That answer says something does not exist');
    expect(result.text).not.toContain('no prior incidents like this');
    expect(result.refusedAnAbsenceClaim).toBe(true);
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

  it('tells the model the failure is not a result', async () => {
    const repository = fakeRepository({
      recall: () => Promise.reject(new Error('statement timeout')),
    });
    const model = createScriptedChatModel([recallCall(), answer('I could not search.')]);
    const result = await run(model, repository);

    const toolResult = result.transcript.find((turn) => turn.role === 'tool_result');
    expect(toolResult?.role === 'tool_result' && toolResult.content).toContain('statement timeout');
    expect(toolResult?.role === 'tool_result' && toolResult.content).toContain(
      'Do not treat this as a result',
    );
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
