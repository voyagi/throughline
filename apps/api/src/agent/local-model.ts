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

import {
  createBedrockChatModel,
  type BedrockChatModelOptions,
  type ConverseCapableClient,
} from './bedrock-model.ts';
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
 * `bedrock` is never DEFAULTED to local, and a misconfigured `bedrock` is refused rather than
 * quietly downgraded. Falling back to an offline scripted model when the real provider is
 * unavailable is the canned-mode dishonesty the design notes rule out: it would present
 * deterministic local text as a hosted model's answer.
 *
 * Both settings below are required explicitly rather than inferred, which is the same rule
 * `loadEmbeddingConfig` applies to `EMBEDDING_MODEL_ID` and for the same reason. A guessed model id
 * fails on the far side of the network, and a guessed region answers correctly from the wrong
 * continent, which is the failure that does not announce itself at all.
 *
 * `createClient` IS THE SEAM, AND IT IS THE SECOND ONE TRIED HERE. What has to be held is the one
 * expression below: the whole config object, spread into the adapter as one thing. Re-listing its
 * fields is not a style choice, it is how `AGENT_MAX_TOKENS` came to be read, validated and then
 * dropped while the adapter's own refusal told the operator to set the value they had just set. A
 * built hosted model will only say what ceiling it holds by making a billed network call, so the
 * re-listed version once passed the entire suite.
 *
 * THE FIRST SEAM WAS A `buildHosted` PARAMETER DEFAULTING TO `createBedrockChatModel`, AND IT WAS
 * WORSE THAN NOTHING, because it read as a fix. `main.ts` calls `createChatModel(env)` with ONE
 * argument, so that default WAS the production path, and a test that hands in its own builder never
 * touches it. A reviewer re-listed the fields inside the default and 1494 tests stayed green: the
 * untested line had moved one line up rather than become tested. A seam only helps when the
 * production path and the test path are the SAME expression.
 *
 * This one is. `createClient` is a key the adapter already declares for exactly this purpose, so
 * both paths run `createBedrockChatModel({ ...loadChatConfig(env), ... })` and the test's only
 * difference is one extra key carrying a capturing client. There is no second copy of the wiring to
 * corrupt, and a test reads the ceiling off the wire.
 */
export function createChatModel(
  env: Record<string, string | undefined> = process.env,
  createClient?: (region: string) => ConverseCapableClient,
): ChatModel {
  const provider = env['AGENT_PROVIDER'] ?? 'local';
  if (provider === 'local') return createLocalChatModel();
  if (provider === 'bedrock') {
    // Spread and never re-listed. `exactOptionalPropertyTypes` is why the seam is spread in rather
    // than written `createClient`: an explicit `undefined` is not the same as an absent key here.
    return createBedrockChatModel({
      ...loadChatConfig(env),
      ...(createClient === undefined ? {} : { createClient }),
    });
  }
  throw new Error(
    `AGENT_PROVIDER is "${provider}", which is not a provider this build has. Use local or bedrock.`,
  );
}

/**
 * The point above which a ceiling is a UNIT MISTAKE rather than a ceiling.
 *
 * A SANITY BOUND AND EXPLICITLY NOT A PER-MODEL MAXIMUM. The validation below used to catch only
 * the low end, and its own message says why the check exists: a ceiling read as NaN is a request
 * the provider rejects on every turn. A ceiling of ten million fails in exactly that way and used to
 * pass, because it is a positive integer. The real maximum is the model's, it is far smaller than
 * this, and Bedrock is the authority on it.
 *
 * SO WHY NOT A TIGHTER NUMBER. This file does not know which model is in use, per-model output
 * ceilings differ by more than an order of magnitude, and a bound tight enough to be interesting
 * would refuse configurations that work. Refusing a working setting at start-up is a worse failure
 * than the loud one this catches, so the bound is set where no ceiling is a ceiling: 500 times the
 * default, past which the value is a byte count, a millisecond count, or a slipped keypress.
 */
const IMPLAUSIBLE_MAX_TOKENS = 1_000_000;

/**
 * The hosted chat settings, read from the environment and checked before anything is built.
 *
 * SEPARATED FROM THE BUILDING for the reason `loadEmbeddingConfig` is separate, and for one more.
 * A setting read inside a factory can only be tested through the thing the factory returns, and a
 * hosted chat model will only say what ceiling it was given by making a billed network call. So
 * this half is pure and directly testable, and `createChatModel` hands the whole object to the
 * adapter rather than re-listing its fields: a setting that is read here cannot then be dropped on
 * the way through, which is precisely how AGENT_MAX_TOKENS came to be read nowhere at all while
 * the adapter's own refusal told the operator to set it.
 */
export function loadChatConfig(
  env: Record<string, string | undefined>,
): BedrockChatModelOptions {
  const modelId = env['AGENT_MODEL_ID']?.trim();
  if (!modelId) {
    throw new Error(
      'AGENT_PROVIDER=bedrock but AGENT_MODEL_ID is empty. Read the real value off the account ' +
        'rather than guessing it: an id that merely APPEARS in list-foundation-models may still ' +
        'refuse on-demand invocation and demand an inference profile id instead, and this ' +
        'account has models in exactly that state.',
    );
  }
  const region = env['AWS_REGION']?.trim();
  if (!region) {
    throw new Error(
      'AGENT_PROVIDER=bedrock but AWS_REGION is empty. It is read here rather than left to the ' +
        "SDK's default chain because the chain resolves silently: an unset region becomes " +
        'whatever the machine happens to be configured for, and a turn answered from the wrong ' +
        'continent is a data residency problem that reports itself as a working demo.',
    );
  }

  // THE OUTPUT CEILING IS AN OPERATOR SETTING because the adapter now REFUSES a reply that hit
  // it, rather than returning the truncated half and letting the turn end on something that
  // reads finished. That makes the ceiling load-bearing: a question whose honest answer runs
  // longer than the default fails the turn, and the person reading that failure needs a way out
  // that is not a code change. Optional, because the default is right for an incident answer and
  // nobody should have to set it. An empty value is unset, not zero, for the same reason the two
  // settings above treat blank as absent.
  //
  // The key is LEFT OUT rather than set to undefined when it is unset. `exactOptionalPropertyTypes`
  // is on, so those are different types here, and the difference is not cosmetic: an explicit
  // undefined would have to be defaulted again by the adapter.
  const rawMaxTokens = env['AGENT_MAX_TOKENS']?.trim();
  if (rawMaxTokens === undefined || rawMaxTokens === '') return { modelId, region };

  const maxTokens = Number(rawMaxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > IMPLAUSIBLE_MAX_TOKENS) {
    throw new Error(
      `AGENT_MAX_TOKENS is "${rawMaxTokens}", which is not a plausible whole number of output ` +
        `tokens. It must be a positive integer no greater than ${IMPLAUSIBLE_MAX_TOKENS}. Unset it ` +
        'to take the default rather than leaving a value the adapter would have to interpret: a ' +
        'ceiling read as NaN is not a smaller ceiling, it is a request Bedrock rejects on every ' +
        'turn, and so is one that is too large.',
    );
  }
  return { modelId, region, maxTokens };
}
