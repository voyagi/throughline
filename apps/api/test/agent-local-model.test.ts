import { describe, expect, it } from 'vitest';
import { claimsAbsence, TOOLS } from '../src/agent/tools.ts';
import { runAgentTurn, SYSTEM_PROMPT, type ChatReply, type Turn } from '../src/agent/loop.ts';
import type { ConverseCapableClient } from '../src/agent/bedrock-model.ts';
import {
  createChatModel,
  createLocalChatModel,
  createScriptedChatModel,
  loadChatConfig,
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

  it('builds the hosted model when bedrock is fully configured', () => {
    const model = createChatModel({
      AGENT_PROVIDER: 'bedrock',
      AGENT_MODEL_ID: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      AWS_REGION: 'eu-central-1',
    });
    expect(model.id).toBe('bedrock:eu.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  // THE PROPERTY, and it outlived the message that used to carry it. This assertion used to pin
  // "the adapter has not been built yet", which stopped being true the moment the adapter existed.
  // What must never change is that a bedrock setting nobody can honour THROWS: an offline model
  // answering as though it were the hosted one is the canned-mode dishonesty the design notes rule
  // out, and the way that ships is a fallback added to make a misconfiguration less annoying.
  it('refuses a half-configured bedrock rather than falling back to the local model', () => {
    expect(() => createChatModel({ AGENT_PROVIDER: 'bedrock' })).toThrow(/AGENT_MODEL_ID is empty/);
    expect(() =>
      createChatModel({ AGENT_PROVIDER: 'bedrock', AGENT_MODEL_ID: 'x', AWS_REGION: '  ' }),
    ).toThrow(/AWS_REGION is empty/);
  });

  // Whitespace is not configuration. Without the trim these produce a client pointed at " ", which
  // fails at the far end of the network with nothing pointing back here.
  it('treats a blank model id as unset rather than as a model called space', () => {
    expect(() =>
      createChatModel({ AGENT_PROVIDER: 'bedrock', AGENT_MODEL_ID: '   ', AWS_REGION: 'eu-central-1' }),
    ).toThrow(/AGENT_MODEL_ID is empty/);
  });

  it('refuses a provider it does not have', () => {
    expect(() => createChatModel({ AGENT_PROVIDER: 'openai' })).toThrow(
      /"openai", which is not a provider this build has/,
    );
  });
});

// THE SETTING THE ADAPTER'S OWN REFUSAL POINTS AT. When a reply is cut off at the ceiling the
// adapter refuses it and tells the operator that raising AGENT_MAX_TOKENS is a setting rather than
// a code change. That sentence was false until this was read: the variable existed in the message
// and nowhere else. It is asserted here, on the pure half, because the only way to ask a built
// hosted model what ceiling it holds is to make a billed call.
describe('loadChatConfig reads the hosted chat settings', () => {
  const BASE = { AGENT_MODEL_ID: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', AWS_REGION: 'eu-central-1' };

  it('carries the ceiling through as a number the adapter can use', () => {
    expect(loadChatConfig({ ...BASE, AGENT_MAX_TOKENS: '512' }).maxTokens).toBe(512);
  });

  // ABSENT, not present-and-undefined. `exactOptionalPropertyTypes` makes those different types,
  // and the adapter defaults on the key being missing.
  it('leaves the ceiling out entirely when it is unset or blank, so the default stands', () => {
    expect('maxTokens' in loadChatConfig(BASE)).toBe(false);
    expect('maxTokens' in loadChatConfig({ ...BASE, AGENT_MAX_TOKENS: '   ' })).toBe(false);
  });

  // A ceiling read as NaN is not a smaller ceiling. It is a request Bedrock rejects on every turn,
  // and it would do so from inside the adapter, on the far side of a network call, for a setting
  // that was wrong before the process finished starting.
  it('refuses a ceiling that is not a positive whole number of tokens', () => {
    for (const value of ['0', '-1', '2.5', 'lots', '1e3ish']) {
      expect(() => loadChatConfig({ ...BASE, AGENT_MAX_TOKENS: value })).toThrow(
        /AGENT_MAX_TOKENS is "/,
      );
    }
  });

  it('still refuses the settings that have no default, before it looks at the ceiling', () => {
    expect(() => loadChatConfig({ AGENT_MAX_TOKENS: '512' })).toThrow(/AGENT_MODEL_ID is empty/);
    expect(() => loadChatConfig({ AGENT_MODEL_ID: 'x', AGENT_MAX_TOKENS: '512' })).toThrow(
      /AWS_REGION is empty/,
    );
  });

  it('refuses a ceiling so large it is a unit mistake rather than a ceiling', () => {
    expect(() => loadChatConfig({ ...BASE, AGENT_MAX_TOKENS: '10000000' })).toThrow(
      /no greater than 1000000/,
    );
    // The bound itself is accepted, so the message names a value that works.
    expect(loadChatConfig({ ...BASE, AGENT_MAX_TOKENS: '1000000' }).maxTokens).toBe(1_000_000);
  });

  /**
   * THE JOIN, WHICH IS THE ONE LINK IN THIS CHAIN NOTHING USED TO HOLD.
   *
   * The two ends are each pinned against their own mechanism: the tests above prove
   * `loadChatConfig` PRODUCES the ceiling, and `agent-bedrock-model.test.ts` proves the adapter
   * SENDS the ceiling it is handed. Neither can see a `createChatModel` that reads the setting and
   * then hands the adapter a hand-copied `{ modelId, region }`. That version was planted by a
   * reviewer and passed all 1484 tests, because the test standing here asserted `model.id`, which
   * is `bedrock:${modelId}` for every possible ceiling: a tautology with respect to the property it
   * was named for.
   *
   * So this drives the REAL adapter through the REAL factory and reads the ceiling off the request,
   * which is the only place the whole chain is observable without a billed call. Asserting the
   * options object instead would still pass for an adapter that accepted the ceiling and ignored it.
   *
   * AND THE FIRST VERSION OF THIS BLOCK DID NOT HOLD IT EITHER, WHICH IS THE POINT OF THE SENTENCE
   * ABOVE. It injected a `buildHosted` builder, so `createChatModel` grew a DEFAULT argument that
   * only production ever used. The next reviewer re-listed the fields inside that default and all
   * 1494 tests passed. What is injected now is the CLIENT, a key the adapter already declares, so
   * this test and `main.ts` run the same expression and the only difference between them is the
   * socket at the end of it.
   */
  describe('the ceiling survives the trip from the environment to the request', () => {
    // A recorder rather than a copy of the fuller double in `agent-bedrock-model.test.ts`: one
    // field is read here, because one question is being asked.
    const recording = (seen: { maxTokens?: number }): ConverseCapableClient => ({
      send(command) {
        const { input } = command as unknown as { input: { inferenceConfig: { maxTokens: number } } };
        seen.maxTokens = input.inferenceConfig.maxTokens;
        return Promise.resolve({
          output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
          stopReason: 'end_turn',
        });
      },
    });

    const wireCeiling = async (env: Record<string, string | undefined>): Promise<number | undefined> => {
      const seen: { maxTokens?: number } = {};
      const model = createChatModel({ ...BASE, AGENT_PROVIDER: 'bedrock', ...env }, () =>
        recording(seen),
      );
      await model.reply({ system: 'system', history: [], tools: TOOLS });
      return seen.maxTokens;
    };

    it('sends what AGENT_MAX_TOKENS was set to', async () => {
      await expect(wireCeiling({ AGENT_MAX_TOKENS: '512' })).resolves.toBe(512);
    });

    // The absence half, end to end. The key is LEFT OUT when the variable is blank rather than set
    // to undefined, and what that buys is exactly this: the adapter's own default stands.
    it('sends the adapter default when the variable is blank, because the key never arrives', async () => {
      await expect(wireCeiling({ AGENT_MAX_TOKENS: '  ' })).resolves.toBe(2048);
    });
  });
});
