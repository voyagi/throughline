/**
 * The `AGENT_PROVIDER=local` chat model: deterministic, offline, and deliberately not careful.
 *
 * Two implementations of the same port, and one rule shared between them: neither may be KINDER
 * than a hosted model. That trap has already been paid for once in this repository, where the MCP
 * client passed 107 tests against a double that answered a notification the real server answers
 * with 202 and no body, over a client that could not complete a handshake.
 *
 * So `createLocalChatModel` is written as a careless model rather than a careful one. When a recall
 * comes back with no memories it says "there are no prior incidents", flatly, WITHOUT looking at
 * the coverage verdict first. That is the exact sentence this product exists to prevent, and it is
 * the point: under COVERED the sentence is true and the loop lets it stand, and under any other
 * verdict the loop refuses it and makes the model try again. A polite local model would leave all
 * three controls untested end to end while every unit test still passed.
 */

import type { ChatModel, ChatReply, Turn } from './loop.ts';

/** The prefix `renderRecall` leads every result with. Read, not assumed: this is its first line. */
const COVERAGE_PREFIX = 'COVERAGE: ';

/** The shape `renderMemory` writes an id in. A hosted model reads these the same way: as text. */
const MEMORY_ID_LINE = /^ {2}id (\S+)$/gm;

export interface LocalChatModelOptions {
  readonly id?: string;
  /**
   * How many recalls it will ask for before it commits to an answer.
   *
   * Its own bound, deliberately separate from the loop's `maxToolCalls`. A model that never stops
   * asking is a real failure mode, and a local model that could only be stopped by the loop's cap
   * would make every offline run end in "this turn ran out of room" rather than in an answer.
   */
  readonly maxRecalls?: number;
}

/**
 * A rule-based responder that drives the whole loop with no network and no AWS.
 *
 * Deterministic: the same transcript always produces the same reply, so the offline demo and the
 * tests agree, and a failure is reproducible rather than resampled away.
 */
export function createLocalChatModel(options: LocalChatModelOptions = {}): ChatModel {
  const maxRecalls = options.maxRecalls ?? 1;
  return {
    id: options.id ?? 'local-scripted-v1',
    reply({ history }): Promise<ChatReply> {
      return Promise.resolve(decideReply(history, maxRecalls));
    },
  };
}

function decideReply(history: readonly Turn[], maxRecalls: number): ChatReply {
  // A refusal is the loop telling this model its last answer was not supported. Answering the same
  // way again would end the turn on the refusal, so this is where the model corrects itself, which
  // is the branch that proves control 3 does more than log.
  //
  // NOTE, because the two files can drift apart silently. The `refusal` role in `loop.ts` was
  // widened to mean any sentence the loop authored, which now includes the round-cap notice, and
  // this reader still treats a trailing refusal as "my last answer was rejected". Not reachable
  // today: the loop pushes the round-cap notice and returns on the same statement, so `reply` is
  // never called again after it. If a future change lets any other loop-authored turn be followed
  // by another model call, this branch starts apologising for an answer it never gave, and the
  // fix is to distinguish the KIND of loop turn rather than to read the role alone.
  const last = history[history.length - 1];
  if (last?.role === 'refusal') return { kind: 'answer', text: correctedAnswer(history) };

  const recalls = history.filter(
    (turn) => turn.role === 'tool_call' && turn.name === 'recall',
  ).length;
  if (recalls < maxRecalls) {
    return {
      kind: 'tools',
      calls: [{ id: `recall-${recalls + 1}`, name: 'recall', args: { query: firstQuestion(history) } }],
    };
  }

  return { kind: 'answer', text: naiveAnswer(history) };
}

function firstQuestion(history: readonly Turn[]): string {
  for (const turn of history) {
    if (turn.role === 'user') return turn.content;
  }
  // Unreachable through `runAgentTurn`, which seeds the transcript with the user's message before
  // the first call. Stated rather than assumed, because the port allows any history.
  return 'recent incidents';
}

/** The most recent rendered recall result, or null when nothing has been recalled yet. */
function lastRecallResult(history: readonly Turn[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn?.role === 'tool_result' && turn.name === 'recall') return turn.content;
  }
  return null;
}

function coverageOf(rendered: string): string {
  const firstLine = rendered.split('\n', 1)[0] ?? '';
  if (!firstLine.startsWith(COVERAGE_PREFIX)) return 'unstated';
  return firstLine.slice(COVERAGE_PREFIX.length).split('.')[0] ?? 'unstated';
}

function memoryIdsIn(rendered: string): string[] {
  // `matchAll` rather than a stateful `exec` loop: MEMORY_ID_LINE carries the /g flag, and a shared
  // global regex advanced by exec keeps `lastIndex` between calls, so the second call on the same
  // string starts halfway through it and silently returns fewer ids.
  return [...rendered.matchAll(MEMORY_ID_LINE)].map((match) => match[1] ?? '').filter(Boolean);
}

/**
 * What a careless model says, and the reason this one is written that way.
 *
 * No coverage check before the absence claim. That is the failure being demonstrated, not an
 * oversight, and the loop is what stops it reaching a user.
 */
function naiveAnswer(history: readonly Turn[]): string {
  const rendered = lastRecallResult(history);
  if (rendered === null) {
    return 'I have not searched the incident memory, so I have not established anything either way.';
  }

  const ids = memoryIdsIn(rendered);
  if (ids.length === 0) {
    return 'There are no prior incidents like this on record: nothing was found in memory.';
  }
  const coverage = coverageOf(rendered);
  return (
    `I found ${ids.length} relevant ${ids.length === 1 ? 'memory' : 'memories'} under coverage ` +
    `${coverage}: ${ids.join(', ')}. Read the receipt above for what the search actually did.`
  );
}

/**
 * The rewrite, once the loop has refused the absence claim.
 *
 * Says what happened instead of restating the absence, which is what the refusal asked for. It has
 * to survive `claimsAbsence`, and a test asserts exactly that, because a "corrected" answer that
 * trips the same check would end every offline turn on a refusal and look like a broken loop.
 */
function correctedAnswer(history: readonly Turn[]): string {
  const rendered = lastRecallResult(history);
  const coverage = rendered === null ? 'unstated' : coverageOf(rendered);
  return (
    `I cannot answer that. The search of the incident memory came back ${coverage}, so it did not ` +
    'establish what is or is not in the archive, and I am not going to describe a failed search ' +
    'as an empty one. Re-run this once the memory layer reports COVERED.'
  );
}

/**
 * Replay a fixed sequence of replies, one per call.
 *
 * This is how a single branch of the loop is driven exactly, and it is the mechanism the canned
 * transcript mode in the design notes needs: a recorded real session is a scripted one. Running off
 * the end THROWS rather than inventing a reply, because an exhausted script means the loop took a
 * path the author did not expect, and a default reply would hide precisely that.
 */
export function createScriptedChatModel(
  replies: readonly ChatReply[],
  id = 'scripted-test-model',
): ChatModel {
  let index = 0;
  return {
    id,
    reply(): Promise<ChatReply> {
      const next = replies[index];
      index += 1;
      if (next === undefined) {
        return Promise.reject(
          new Error(
            `The scripted model ran out after ${replies.length} replies: the loop asked for reply ` +
              `${index}. The loop took a path this script does not cover.`,
          ),
        );
      }
      return Promise.resolve(next);
    },
  };
}

export type AgentProvider = 'local' | 'bedrock';

/**
 * Pick the chat model from the environment, which is what makes `AGENT_PROVIDER` mean something.
 *
 * `bedrock` is refused rather than defaulted to local. Falling back to an offline scripted model
 * when the real provider is unavailable is the canned-mode dishonesty the design notes rule out:
 * it would present deterministic local text as a hosted model's answer. An explicit refusal is the
 * only honest response until the adapter exists.
 */
export function createChatModel(
  env: Record<string, string | undefined> = process.env,
): ChatModel {
  const provider = env['AGENT_PROVIDER'] ?? 'local';
  if (provider === 'local') return createLocalChatModel();
  if (provider === 'bedrock') {
    throw new Error(
      'AGENT_PROVIDER=bedrock, but the Bedrock chat adapter has not been built yet. Set ' +
        'AGENT_PROVIDER=local to run offline, or build the adapter. This does not fall back to ' +
        'local on purpose: an offline model answering as though it were the hosted one is the ' +
        'exact dishonesty this demo argues against.',
    );
  }
  throw new Error(
    `AGENT_PROVIDER is "${provider}", which is not a provider this build has. Use local or bedrock.`,
  );
}
