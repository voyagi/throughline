import { describe, expect, it } from 'vitest';
import { claimsAbsence, TOOLS } from '../src/agent/tools.ts';
import { runAgentTurn, SYSTEM_PROMPT, type ChatReply, type Turn } from '../src/agent/loop.ts';
import {
  createChatModel,
  createLocalChatModel,
  createScriptedChatModel,
} from '../src/agent/local-model.ts';
import {
  MEMORY_ID_A,
  recallResult,
  repositoryReturning,
  scoredMemory,
} from './agent-fixtures.ts';

const QUESTION = 'has checkout been slow before?';

function ask(history: readonly Turn[]): Promise<ChatReply> {
  return createLocalChatModel().reply({ system: SYSTEM_PROMPT, history, tools: TOOLS });
}

const userTurn: Turn = { role: 'user', content: QUESTION };

// THE TWO IDS DIFFER ON PURPOSE, because this is what the loop really writes. `id` is the loop's
// own and `given` is what this model asked under, and the model reads NEITHER: it counts the recall
// calls in the history and numbers its next one from that.
const recalled = (content: string): readonly Turn[] => [
  userTurn,
  { role: 'tool_call', id: 'tc-1', given: 'recall-1', name: 'recall', args: { query: QUESTION } },
  { role: 'tool_result', id: 'tc-1', name: 'recall', content },
];

describe('createLocalChatModel', () => {
  it('recalls first, using the question it was asked as the query', async () => {
    const reply = await ask([userTurn]);

    expect(reply.kind).toBe('tools');
    if (reply.kind !== 'tools') expect.unreachable('the first move must be a recall');
    expect(reply.calls).toStrictEqual([
      { id: 'recall-1', name: 'recall', args: { query: QUESTION } },
    ]);
  });

  it('stops asking once it has had its recalls, so an offline turn ends in an answer', async () => {
    const reply = await ask(recalled('COVERAGE: COVERED. it ran\nNo memory matched.'));
    expect(reply.kind).toBe('answer');
  });

  it('cites the ids it was given when the recall returned memories', async () => {
    const rendered = [
      'COVERAGE: COVERED. the search compared every live row',
      'The search ran over 3 candidate memories by an exact scan and returned 1.',
      '',
      '[resolution] Restarting the checkout pods cleared it.',
      `  id ${MEMORY_ID_A}`,
      '  asserted by human:oncall-ana',
    ].join('\n');
    const reply = await ask(recalled(rendered));

    expect(reply.kind).toBe('answer');
    if (reply.kind !== 'answer') expect.unreachable('it must answer here');
    expect(reply.text).toContain(MEMORY_ID_A);
    expect(reply.text).toContain('under coverage COVERED');
    expect(claimsAbsence(reply.text)).toBe(false);
  });

  // THE POINT OF THIS MODEL. It is written careless on purpose: it asserts the absence without
  // looking at the verdict. A polite local model would leave the loop's controls with nothing to
  // catch, and every test would still pass.
  it('asserts an absence without checking coverage, which is the failure being demonstrated', async () => {
    const unknown = await ask(recalled('COVERAGE: UNKNOWN. the embedding provider failed'));

    expect(unknown.kind).toBe('answer');
    if (unknown.kind !== 'answer') expect.unreachable('it must answer here');
    expect(claimsAbsence(unknown.text)).toBe(true);
  });

  it('says the same thing under COVERED, where the sentence is actually true', async () => {
    const covered = await ask(recalled('COVERAGE: COVERED. it ran\nNo memory matched.'));

    expect(covered.kind).toBe('answer');
    if (covered.kind !== 'answer') expect.unreachable('it must answer here');
    expect(claimsAbsence(covered.text)).toBe(true);
  });

  it('rewrites into something that does not claim an absence once the loop refuses it', async () => {
    const history: readonly Turn[] = [
      ...recalled('COVERAGE: UNKNOWN. the embedding provider failed'),
      { role: 'assistant', content: 'There are no prior incidents like this.' },
      { role: 'refusal', content: 'That answer says something does not exist.' },
    ];
    const reply = await ask(history);

    expect(reply.kind).toBe('answer');
    if (reply.kind !== 'answer') expect.unreachable('it must answer after a refusal');
    // If the rewrite tripped the same check, every offline turn would end on the refusal and the
    // loop would look broken rather than careful.
    expect(claimsAbsence(reply.text)).toBe(false);
    expect(reply.text).toContain('came back UNKNOWN');
    expect(reply.text).toContain('not going to describe a failed search as an empty one');
  });

  it('is deterministic: the same transcript gives the same reply every time', async () => {
    const history = recalled(
      `COVERAGE: COVERED. it ran\n\n[resolution] x\n  id ${MEMORY_ID_A}`,
    );
    const first = await ask(history);
    const second = await ask(history);
    // Also guards the shared /g regex used to read ids: an `exec` loop over a module level global
    // regex keeps `lastIndex` between calls, so the second read of the same string silently
    // returns fewer ids than the first.
    expect(second).toStrictEqual(first);
  });

  it('says it has not established anything when asked to answer with no recall at all', async () => {
    const reply = await createLocalChatModel({ maxRecalls: 0 }).reply({
      system: SYSTEM_PROMPT,
      history: [userTurn],
      tools: TOOLS,
    });

    expect(reply.kind).toBe('answer');
    if (reply.kind !== 'answer') expect.unreachable('maxRecalls 0 must answer immediately');
    expect(reply.text).toContain('I have not searched the incident memory');
    expect(claimsAbsence(reply.text)).toBe(false);
  });
});

describe('the whole loop, offline, with no cloud and no AWS', () => {
  it('answers from a covered recall, citing what it used', async () => {
    const result = await runAgentTurn(
      {
        model: createLocalChatModel(),
        repository: repositoryReturning(
          recallResult({ coverage: 'COVERED', memories: [scoredMemory()] }),
        ),
        workspaceId: 'demo',
      },
      QUESTION,
    );

    expect(result.text).toContain(MEMORY_ID_A);
    expect(result.coverage).toBe('COVERED');
    expect(result.refusedAnAbsenceClaim).toBe(false);
    expect(result.modelId).toBe('local-scripted-v1');
  });

  it('lets a true absence stand when the search really covered the workspace', async () => {
    const result = await runAgentTurn(
      {
        model: createLocalChatModel(),
        repository: repositoryReturning(recallResult({ coverage: 'COVERED', memories: [] })),
        workspaceId: 'demo',
      },
      QUESTION,
    );

    expect(claimsAbsence(result.text)).toBe(true);
    expect(result.refusedAnAbsenceClaim).toBe(false);
  });

  // The end to end proof that the three controls are not decoration: a careless model tries the
  // sentence, the loop refuses it, and the turn ends on a corrected answer instead.
  it('catches the careless absence claim when the search did not run, and recovers', async () => {
    const result = await runAgentTurn(
      {
        model: createLocalChatModel(),
        repository: repositoryReturning(
          recallResult({ coverage: 'UNKNOWN', coverageReason: 'the embedding provider failed' }),
        ),
        workspaceId: 'demo',
      },
      QUESTION,
    );

    expect(result.coverage).toBe('UNKNOWN');
    expect(result.refusedAnAbsenceClaim).toBe(true);
    expect(claimsAbsence(result.text)).toBe(false);
    expect(result.text).toContain('came back UNKNOWN');
    expect(result.transcript.filter((turn) => turn.role === 'refusal')).toHaveLength(1);
  });
});

describe('createScriptedChatModel', () => {
  it('replays its replies in order', async () => {
    const model = createScriptedChatModel([
      { kind: 'answer', text: 'first' },
      { kind: 'answer', text: 'second' },
    ]);
    const input = { system: SYSTEM_PROMPT, history: [userTurn], tools: TOOLS };

    expect(await model.reply(input)).toStrictEqual({ kind: 'answer', text: 'first' });
    expect(await model.reply(input)).toStrictEqual({ kind: 'answer', text: 'second' });
  });

  it('refuses to invent a reply when the script runs out, and says which call it was', async () => {
    const model = createScriptedChatModel([{ kind: 'answer', text: 'only one' }]);
    const input = { system: SYSTEM_PROMPT, history: [userTurn], tools: TOOLS };
    await model.reply(input);

    await expect(model.reply(input)).rejects.toThrow(
      /ran out after 1 replies: the loop asked for reply 2/,
    );
  });
});

describe('createChatModel reads AGENT_PROVIDER', () => {
  it('defaults to the offline model when nothing is set', () => {
    expect(createChatModel({}).id).toBe('local-scripted-v1');
  });

  it('returns the offline model for local', () => {
    expect(createChatModel({ AGENT_PROVIDER: 'local' }).id).toBe('local-scripted-v1');
  });

  // Never a silent fallback. An offline model answering as though it were the hosted one is the
  // canned-mode dishonesty the design notes rule out.
  it('refuses bedrock rather than quietly answering with the local model', () => {
    expect(() => createChatModel({ AGENT_PROVIDER: 'bedrock' })).toThrow(
      /has not been built yet/,
    );
    expect(() => createChatModel({ AGENT_PROVIDER: 'bedrock' })).toThrow(
      /does not fall back to local on purpose/,
    );
  });

  it('refuses a provider it does not have', () => {
    expect(() => createChatModel({ AGENT_PROVIDER: 'openai' })).toThrow(
      /"openai", which is not a provider this build has/,
    );
  });
});
