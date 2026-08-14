/**
 * The `AGENT_PROVIDER=bedrock` chat model, over the Converse API.
 *
 * Converse rather than InvokeModel, and that is a decision rather than a default. InvokeModel takes
 * a different request body per vendor, which is the problem `inferRequestShape` exists to solve on
 * the embedding side and which is worth not having twice. Converse takes one shape for every model
 * it supports, so this adapter has no family table to keep current and no way to send Anthropic a
 * body shaped for Cohere.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO BE. The local model's header states the rule both implementations
 * share: neither may be KINDER than the other. This one is the hosted side of that pair, and the
 * loop's three controls are what judge its answers. Nothing here inspects, softens, or retries an
 * answer on the model's behalf, because a provider adapter that quietly improved replies would make
 * the controls untestable against the model that actually ships.
 */

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { describeProviderError } from '../bedrock-embedder.ts';
import { joinWithinBudget, printableName, TOP_LEVEL_KEY_BUDGET } from '../printable-name.ts';
import {
  ProviderRejectionError,
  type ProviderErrorMetadata,
} from '../provider-rejection.ts';
import {
  ChatResponseError,
  ChatUnreadableError,
  type ChatModel,
  type ChatReply,
  type ChatToolCall,
  type Turn,
} from './loop.ts';
import type { ToolDefinition } from './tools.ts';

/**
 * Declared with the PORT and re-exported here, because the LOOP is what has to catch it: an
 * unusable reply ends a turn there rather than escaping as a 500. Re-exported rather than moved
 * silently, so the callers and tests that have always imported it from the adapter still can.
 */
export { ChatResponseError, ChatUnreadableError } from './loop.ts';

/** Thrown when the model did not answer inside the turn's wall-clock budget. */
export class ChatTimeoutError extends Error {
  readonly modelId: string;
  constructor(modelId: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(
      `Model "${modelId}" did not answer within ${timeoutMs}ms. The turn is abandoned rather than ` +
        'left open, because a demo that hangs is worse than one that says it gave up.',
      options,
    );
    this.name = 'ChatTimeoutError';
    this.modelId = modelId;
  }
}

/**
 * Thrown when the provider rejected the call.
 *
 * Carries the provider's error IDENTITY and not its prose, for the reason `loop.ts` records at
 * length: a tool result is a response body, and a provider message can carry an account id or a
 * role ARN. The original stays on `cause` for the operator's log.
 *
 * THE WHOLE OF IT IS IN THE BASE CLASS, which is the finding rather than a tidy-up. This class and
 * the embedder's twin were the same twenty lines in two files, and they had already diverged: one
 * guard read `=== undefined` and the other read as truthiness, so an empty request id printed here
 * and vanished there. `provider-rejection.ts` says why at length. Only the word "chat" differs.
 */
export class ChatProviderError extends ProviderRejectionError {
  constructor(
    modelId: string,
    providerErrorName: string,
    metadata: ProviderErrorMetadata,
    cause: unknown,
  ) {
    super('chat', modelId, providerErrorName, metadata, cause);
    this.name = 'ChatProviderError';
  }
}

/** One block of a Converse message. Only the three kinds this adapter sends are modelled. */
export type ConverseBlock =
  | { readonly text: string }
  | { readonly toolUse: { readonly toolUseId: string; readonly name: string; readonly input: unknown } }
  | {
      readonly toolResult: {
        readonly toolUseId: string;
        readonly content: readonly [{ readonly text: string }];
      };
    };

export interface ConverseMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly ConverseBlock[];
}

/**
 * The slice of the Bedrock client this adapter uses, so a test can supply a double without standing
 * up the SDK or reaching the network. Returns `unknown` on purpose: the response is parsed by
 * `parseConverseReply`, which a test can drive directly with a hand-written body.
 */
export interface ConverseCapableClient {
  send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface BedrockChatModelOptions {
  /** Read from the account, never guessed. An id that is merely LISTED may not be invocable. */
  readonly modelId: string;
  readonly region: string;
  /** The wall-clock budget for one model call. */
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly client?: ConverseCapableClient;
  /** Injection seam for the real client, so a test can prove the region is actually passed. */
  readonly createClient?: (region: string) => ConverseCapableClient;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Raised from 1024 when `parseConverseReply` began REFUSING a truncated reply instead of passing it
 * on. Refusing is the right call, and it would be a poor trade if it turned a merely long answer
 * into a failed turn, so the ceiling moved. Output tokens are billed as they are generated, so a
 * ceiling nothing reaches costs nothing.
 *
 * IT IS HEADROOM AND NOT A MEASUREMENT. Nothing here counted the tokens a real incident answer
 * takes, and the live run the README records timed a turn rather than sizing it. So this is a guess
 * with room in it, and what makes a guess safe is that somebody can change it without a build:
 * `AGENT_MAX_TOKENS`, which is what the refusal message names.
 */
const DEFAULT_MAX_TOKENS = 2_048;

/**
 * The stop reasons that mean the reply is COMPLETE. Everything else is refused, including a reason
 * this set has never heard of and a response that carries none at all.
 *
 * An allowlist rather than a list of bad reasons, and that is the whole point of it. The failure
 * being guarded against is a reply that LOOKS finished, so a denylist would let any stop reason
 * added to Bedrock after this was written pass silently, which is the same bug again in a year.
 */
const COMPLETE_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'tool_use',
  'stop_sequence',
]);

/**
 * Zero by default, and that is about auditability rather than about answer quality.
 *
 * The console shows a transcript and argues it is the record of what happened. Re-running the same
 * incident question and getting a differently worded absence claim would make that record harder to
 * reason about, and would make a failed control look like bad luck.
 */
const DEFAULT_TEMPERATURE = 0;

/** How a loop-authored refusal is introduced to the model, since Converse has no role for one. */
const REFUSAL_PREFIX =
  'Your previous answer was refused by the system that runs this turn. This is not the user ' +
  'speaking:\n\n';

/**
 * Turn our transcript into Converse messages.
 *
 * THE TOOL ID IS THE LOOP'S `id`, NOT THE MODEL'S `given`, and that is a deliberate divergence from
 * the note in `loop.ts` saying an adapter hands `given` back. Converse is stateless: the whole
 * conversation is sent on every call, so a `toolUseId` only has to be consistent WITHIN what we
 * send, and nothing checks it against an id the provider issued earlier. `given` cannot offer that
 * consistency, because a model reusing one id for every call is a real observed failure this
 * repository already documents, and duplicated ids here are a 400 rather than a subtle bug. The
 * loop's `tc-N` is unique by construction. `given` stays in the transcript, which is where the
 * audit record wants it.
 *
 * Adjacent turns of the same role are MERGED into one message, because Converse requires strict
 * user/assistant alternation and two user messages in a row are rejected outright.
 */
export function toConverseMessages(history: readonly Turn[]): ConverseMessage[] {
  const messages: { role: 'user' | 'assistant'; content: ConverseBlock[] }[] = [];

  const push = (role: 'user' | 'assistant', block: ConverseBlock): void => {
    const last = messages[messages.length - 1];
    if (last?.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };

  for (const turn of history) {
    if (turn.role === 'user') push('user', { text: turn.content });
    else if (turn.role === 'assistant') push('assistant', { text: turn.content });
    else if (turn.role === 'refusal') push('user', { text: `${REFUSAL_PREFIX}${turn.content}` });
    else if (turn.role === 'tool_call') {
      push('assistant', {
        toolUse: { toolUseId: turn.id, name: turn.name, input: turn.args ?? {} },
      });
    } else {
      push('user', { toolResult: { toolUseId: turn.id, content: [{ text: turn.content }] } });
    }
  }

  // Tool results must lead the message that carries them. Not reachable through today's loop, which
  // never puts plain text and a tool result in the same user message, and done anyway because the
  // cost is one stable sort and the failure it prevents is a 400 in front of whoever is watching.
  return messages.map((message) => ({
    role: message.role,
    content: [...message.content].sort(
      (left, right) => Number('toolResult' in right) - Number('toolResult' in left),
    ),
  }));
}

/**
 * Describe our tools in Converse's vocabulary.
 *
 * The schema is generated from the SAME Zod object the loop validates arguments against, rather
 * than hand-written beside it. Two descriptions of one schema is the drift this repository already
 * refuses elsewhere: the model would be told about a field the validator rejects, and the symptom
 * would be a model that "keeps getting the arguments wrong".
 */
export function toToolConfig(tools: readonly ToolDefinition[]): {
  tools: { toolSpec: { name: string; description: string; inputSchema: { json: unknown } } }[];
} {
  return {
    tools: tools.map((tool) => {
      // `$schema` is a document-level annotation about the schema dialect, not part of the shape
      // being described, and Bedrock has no use for it.
      const { $schema: _dialect, ...json } = z.toJSONSchema(tool.schema, { io: 'input' }) as Record<
        string,
        unknown
      >;
      return {
        toolSpec: { name: tool.name, description: tool.description, inputSchema: { json } },
      };
    }),
  };
}

/** What one pass over a response's content blocks found. */
interface BlocksRead {
  /** Blocks this adapter READ, which is what the two throws at the bottom are told apart by. */
  readonly recognised: number;
  /**
   * Blocks carrying ANYTHING under `toolUse` that this adapter could not turn into a call. Counted
   * apart from `recognised` because it answers a different question: not "did anything get through"
   * but "was a tool call requested and dropped". Nothing else can see that, since a dropped call
   * leaves no trace in `calls` and a text block beside it keeps `recognised` above zero.
   *
   * This said OBJECT for one round and the code agreed with it, which left a `toolUse` holding a
   * primitive skipped in silence. The key being present is the request. Whether the thing under it
   * is readable is the failure, not the exemption.
   */
  readonly undeclaredToolUse: number;
  /**
   * Blocks carrying ANYTHING under `text` that is not a string. The exact twin of the field above,
   * and it went uncounted for six rounds while that one was widened three separate times.
   *
   * WHY IT NEEDS ITS OWN COUNTER RATHER THAN `recognised`. `recognised` answers "did anything get
   * through", so one good sentence beside a broken one holds it above zero and the broken one is
   * skipped without a word. That is not a refusal, it is an ANSWER with a hole in it: the reply
   * `[{ text: 'Cause: ' }, { text: 7 }, { text: ' the pool.' }]` came back as "Cause: \n the pool."
   * with a 200 and nothing raised. A cut-off reply is already refused at the stop-reason check, and
   * this is worse than a cut-off reply, because the hole is in the MIDDLE and nothing marks it.
   */
  readonly undeclaredText: number;
  readonly calls: readonly ChatToolCall[];
  readonly said: readonly string[];
}

/**
 * Read every content block once, counting what was read and collecting what was usable.
 *
 * A TOP-LEVEL FUNCTION RATHER THAN A LOOP INSIDE `parseConverseReply`, because reading blocks and
 * deciding what a reply MEANS are two jobs and only one of them has to know about `ChatReply`. It
 * also keeps `parseConverseReply` under `gate:complexity`, which refused the version where this was
 * written inline at 29 against a limit of 25.
 *
 * WHERE THE LINE IS, AND IT IS THE SDK'S DECLARATION RATHER THAN OUR CONVENIENCE. A block is read
 * when it carries a kind this adapter knows, shaped the way the SDK declares that kind. For `text`
 * that is a string. For `toolUse` it is an object whose `name` and `toolUseId` are both strings:
 * `ToolUseBlock` writes those two, and `input`, with NO `?` and only `type?` with one, so all three
 * are REQUIRED members whose declared type happens to include `undefined`. That is how smithy writes
 * every required field. Reading `string | undefined` as "optional" is the mistake that put the
 * previous version of this function on the wrong side of the line for a whole round: presence and
 * type are two different facts, and that version used the second to conclude the first.
 *
 * `input` IS DELIBERATELY NOT CHECKED, so that this comment is not wider than the code. It is
 * declared `__DocumentType`, free-form JSON, which has no shape to disagree with, and an absent one
 * is answerable as `{}`. The two fields that ARE checked are the two whose absence or wrong type
 * makes the call unusable: no name is nothing to call, and a non-string id is a call whose result
 * cannot be correlated back to it.
 *
 * FOR `toolUse`, READ AND CALLABLE COINCIDE, AND THAT IS A CONSEQUENCE RATHER THAN THE RULE. Being
 * shaped as declared is exactly what makes a call issuable, so every `toolUse` counted here also
 * produces one. For `text` they do not coincide: an empty string is read and yields nothing.
 *
 * TWO ROUNDS WERE SPENT ON THE OPPOSITE ERROR IN EACH DIRECTION, WHICH IS WHY THE RULE IS WRITTEN
 * OUT RATHER THAN IMPLIED. First this counted usable payloads while six comments said it counted
 * known kinds, and `{ toolUse: { toolUseId: 'x' } }` left as a 500 carrying none of the turn's
 * recalls. The fix for that counted ANY object under `toolUse`, and then
 * `{ toolUse: { toolUseId: 'x', toolName: 'recall' } }` - one renamed field, the archetypal breaking
 * change - was read, so a model emitting it answered EVERY question with a refusal while the error
 * rate stayed flat. The second failure is the one this split exists to prevent and the first is one
 * turn's receipts, so where they conflict the shape check wins and a nameless `toolUse` is loud.
 *
 * A THIRD ROUND THEN WENT ON THE ENFORCEMENT RATHER THAN THE RULE, WHICH IS WHY THIS RETURNS TWO
 * COUNTS AND NOT ONE. The rule above was already right while the only thing standing behind it was
 * `recognised === 0` at the bottom of `parseConverseReply`, which asks whether EVERY block went
 * unread. One `text` block satisfies `recognised` on its own. So a renamed `toolUse` arriving beside
 * a single sentence of narration was dropped and the narration came back as the answer, and the
 * sentence directly above, that a nameless `toolUse` is loud, was true only of one arriving ALONE.
 * `undeclaredToolUse` is what makes it true in every position. A rule is only ever as wide as the
 * thing enforcing it, and a count of what got through cannot answer a question about what did not.
 *
 * A FOURTH ROUND THEN WENT ON THE TYPE TEST INSIDE THAT ENFORCEMENT, WHICH IS WHY THE CHECK IS NOW
 * PRESENCE RATHER THAN TYPE. `undeclaredToolUse` counted only blocks holding an OBJECT under
 * `toolUse`, so a primitive there fell through the reader and the counter alike without a word.
 * Driving the real client with a canned body shows that shape arriving intact: `"toolUse": 7`
 * deserialises to the number 7, because `_read` enters its struct branch only for a value that is
 * already an object and hands anything else back untouched. Beside a sentence of narration that is
 * the same silent drop the third round closed, reached through a door the third round did not
 * check. Three rounds running, the rule was right and the thing standing behind it was narrower
 * than the rule, in a different place each time.
 *
 * AND THEN A SIXTH ROUND FOUND THE SAME HOLE IN `text`, WHICH EVERY PARAGRAPH ABOVE WALKED PAST.
 * All of that history is about `toolUse`. The `text` branch had no `else` at all, so a block whose
 * `text` was not a string incremented neither counter and was skipped in silence, and one good
 * sentence beside it kept `recognised` above zero. Five rounds of widening one member while its
 * declared twin sat unguarded, in a file whose own sentence is that a rule is only as wide as the
 * thing enforcing it. The lesson the earlier paragraphs drew was too specific: the question is not
 * whether THIS rule is enforced everywhere, it is which DECLARED MEMBERS have a rule at all.
 */
function readContentBlocks(content: readonly unknown[]): BlocksRead {
  const calls: ChatToolCall[] = [];
  const said: string[] = [];
  let recognised = 0;
  let undeclaredToolUse = 0;
  let undeclaredText = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const shaped = block as { text?: unknown; toolUse?: unknown; $unknown?: unknown };
    if (typeof shaped.text === 'string') {
      recognised += 1;
      if (shaped.text.length > 0) said.push(shaped.text);
    } else if ('text' in shaped) {
      // PRESENCE, FOR THE SAME REASON AS `toolUse` BELOW, and this branch is the one that was
      // missing entirely. The key being there is the model saying this block is narration. Whether
      // it holds a string is the failure, never the exemption. Measured by driving the real client:
      // `"text": 7` arrives as the number 7 and an object or an array arrives intact, because a
      // declared string member is copied through without coercion. Only `"text": null` is dropped
      // before it gets here, the same `!= null` rule that keeps a null `toolUse` off the object, so
      // nothing a conforming reply carries can land on this branch.
      undeclaredText += 1;
    }
    const use = shaped.toolUse;
    // PRESENT AT ALL, not present AND an object. The object test skipped a `toolUse` holding a
    // primitive in silence, and a wire `"toolUse": 7` really does arrive here as the number 7,
    // because `_read` enters its struct branch only for a value that is already an object and
    // returns anything else untouched. Absent is the only quiet case, and absent is what every
    // ordinary text block carries.
    //
    // AND THE TEST HAD TO SAY `in` TO MEAN THAT. `use !== undefined` read the VALUE, so a block
    // carrying `toolUse: undefined` was present and silent while `text: undefined` three lines up
    // was present and loud: two declared members of one union, the same question, two answers. The
    // paragraph above already said `Absent is the only quiet case` and the line below it enforced
    // something strictly narrower, which is this file's recurring defect and the reason the `text`
    // branch exists at all. Whether the deserializer can build that object is not the point. The
    // guard states a rule about THIS adapter, and reasoning about what the SDK will deliver instead
    // is the argument that has now been wrong three times.
    if ('toolUse' in shaped) {
      const requested = use as { toolUseId?: unknown; name?: unknown; input?: unknown } | null;
      // The declared shape, one level in. An object under `toolUse` is NOT enough: that read a
      // renamed field as a tool call this build simply had nothing to do with, and stayed quiet.
      if (typeof requested?.name === 'string' && typeof requested?.toolUseId === 'string') {
        recognised += 1;
        calls.push({ id: requested.toolUseId, name: requested.name, args: requested.input ?? {} });
      } else {
        // A tool call was asked for and this adapter is about to drop it. Counted rather than
        // ignored, because dropping it quietly is the whole failure. See `undeclaredToolUse`.
        undeclaredToolUse += 1;
      }
    }
    // A CALL UNDER A KIND NEWER THAN THE SDK, WHICH NEITHER CHECK ABOVE CAN SEE. The deserializer
    // files a member it cannot name as `$unknown: [wireKey, value]`, so the block has no `toolUse`
    // key to find. The name inside that tuple is NOT read, and nothing is dispatched: what is read
    // is the structural fact this function already uses one line up, that the held value carries
    // `toolUseId` and `name` as strings, which is what the SDK declares a tool call to be. See the
    // guard in `parseConverseReply` for why refusing beats answering around it.
    const filedUnderUnknown = shaped.$unknown;
    if (Array.isArray(filedUnderUnknown) && filedUnderUnknown.length === 2) {
      const held = filedUnderUnknown[1] as { toolUseId?: unknown; name?: unknown } | null;
      if (typeof held?.toolUseId === 'string' && typeof held?.name === 'string') undeclaredToolUse += 1;
    }
  }
  return { recognised, undeclaredToolUse, undeclaredText, calls, said };
}

/**
 * `printableName` and `joinWithinBudget` are imported from `../printable-name.ts` rather than living
 * here, and that is the finding rather than a tidy-up. The rule they carry was enforced in this file
 * and dropped in the embedder, which supplies `describeProviderError` to BOTH of them, so the same
 * two provider-chosen strings were escaped on one path and printed raw on the other. Two copies of a
 * decision drift, and this one had already drifted before anybody looked. There is one copy now.
 *
 * HOW MUCH OF A LINE THE WIRE GETS TO DECIDE. A name is capped inside `printableName`. Everything
 * below assembles names into lists, and a list is as long as the body says, so each join has its own
 * budget and each stops on a whole item. `describeBlocks` is the sink an operator actually reads.
 */
// EXPORTED SO A TEST CAN NAME THEM, WHICH IS THE ONLY THING THAT MAKES THEM REAL. The two rows that
// exercise these used to assert `(\d+ of 200 shown)`, and a digit sequence declines to pin a count:
// measured, every budget from 9 to roughly 390 produced a passing line for the inner one. So the
// numbers were decoration, which is exactly the complaint that produced the shape below them, at a
// site the fix for it did not sweep. Both rows now name the constant and the exact count, 19 for the
// inner join and 37 for the entry one, and assert the ordering between them as an inequality rather
// than leaving it implied by three numbers that happen to be sorted today. `BLOCK_LIST_BUDGET` is
// pinned by two block shapes whose boundaries fall either side of 800, and that remains the stronger
// pin because it proves the join USES the value. These two are pinned by value plus an exact shown
// count, because the arithmetic to straddle them exactly needs 59-character keys and reads as a
// puzzle rather than as a rule.
export const INNER_KEY_BUDGET = 200;
export const BLOCK_ENTRY_BUDGET = 400;
const BLOCK_LIST_BUDGET = 800;

// EACH BUDGET MUST EXCEED THE ONE IT CONTAINS. `joinWithinBudget` stops BEFORE the item that would
// cross the line, so if one block can render wider than the whole listing is allowed to be, the outer
// join breaks on its first item and prints a count with nothing counted. That trades a line the wire
// made too long for a line carrying no finding at all, which is the worse of the two. Pinned by test
// rather than by a constant here, because a constant nothing reads is not a check.

/** Name what one key held: a type, or an object's own keys against the types they held. */
function describeHeld(held: unknown): string {
  if (held === null) return 'null';
  if (Array.isArray(held)) return 'array';
  if (typeof held !== 'object') return typeof held;
  const inner = Object.entries(held).map(
    ([key, nested]) => `${printableName(key)}:${nested === null ? 'null' : typeof nested}`,
  );
  return `{${joinWithinBudget(inner, '+', INNER_KEY_BUDGET)}}`;
}

/**
 * Name one key of a block, unwrapping the SDK's marker for a member newer than its own schema.
 *
 * A BLOCK KIND WRITTEN AFTER THE INSTALLED SDK DOES NOT ARRIVE UNDER ITS OWN NAME, which is exactly
 * the case the loud path exists for. The union deserializer files it as `$unknown: [wireKey, value]`
 * instead, and since `describeHeld` collapses every array to the word `array`, the sentence read
 * `Blocks were: $unknown:array` and discarded the one fact an operator needed. The fixture that was
 * supposed to cover this used `reasoningContent`, a kind the SDK knows and only this adapter
 * ignores, so the harder case went untested while looking tested. Measured against the real client.
 *
 * WIRE-CONTROLLED NAMES REACH THE LOG BY TWO PATHS, AND THREE VERSIONS OF THIS PARAGRAPH HAVE NOW
 * BEEN WRONG ABOUT THEM. The first said every other key printed here is wire-controlled too, so this
 * added nothing. They are not: a conforming block is named by its SCHEMA member. The second called
 * the deserializer's `__type` fallback a second, conditional path and this file's one unverified
 * premise. The third, which shipped, said it was verified AND unreachable, so the tuple key below was
 * the whole exposure. That was wrong twice over, and both errors were mine rather than a reviewer's.
 *
 * The citation named the wrong function. `_readStruct` belongs to codec-v2, and this client never
 * USES codec-v2. It does LOAD it: the protocols barrel re-exports codec-v2 unconditionally, so the
 * module is in memory while nothing here calls it. An earlier version of this sentence said "never
 * loads". e162d54's message named USES as the wanted word, and the correction reached that message
 * while missing this paragraph; the independent clear pass caught the miss. What rules codec-v2 out
 * is selection: `runtimeConfig.shared.js` selects `AwsRestJsonProtocol`, which builds its codec
 * from `codec-v1/JsonCodec`, whose `JsonShapeDeserializer` has no `_readStruct` in it at all. The
 * live copy is `codec-v1/JsonShapeDeserializer.js:57-65`, on the `else if (typeof record.__type ===
 * "string")` branch. I had reported that file absent from this tree after searching one package
 * subtree and generalising from an empty result, and used the absence to discount the reviewer who
 * cited it correctly. An empty search says nothing about the paths it did not walk.
 *
 * The reachability conclusion then held for the wrong reason. The branch really is the NON-union one,
 * so `ContentBlock$` being a union does keep it off a BLOCK key. But the copy is per-struct and
 * `ToolUseBlock$` is declared a STRUCT, so an unrecognised key inside a `toolUse` VALUE is copied
 * through and `describeHeld` prints it one level down. The tuple key below is therefore one of two
 * paths, not the whole of it. What makes printing either acceptable is the channel, since the body is
 * AWS over TLS and the sink was traced rather than assumed: `failures.ts` is structural and never
 * interpolates a message into a response body, so this reaches an operator log and stops. `describeHeld`
 * and the tuple key both go through `printableName` so a name cannot reshape the line. The VALUE is
 * still only ever described and never printed, because that one really could carry model text.
 *
 * WHAT ARRIVES WHEN THE SDK CANNOT FILE IT AT ALL. `$unknown` is written only when exactly one
 * unmarked key is left AND nothing else on the block was recognised. So two unrecognised keys land
 * as `{}`, and an unrecognised key sharing a block with a known one is dropped leaving no trace,
 * not even the `{}`. An earlier version of this paragraph promised the `{}` in both cases and had
 * measured neither. Nothing here can recover a name the deserializer never kept.
 */
function describeBlockEntry(key: string, held: unknown): string {
  if (key === '$unknown' && Array.isArray(held) && held.length === 2 && typeof held[0] === 'string') {
    return `${printableName(held[0])}:${describeHeld(held[1])}`;
  }
  return describeHeld(held);
}

/**
 * Name every block by key and by what the key held, for whoever reads the 5xx.
 *
 * ONE LEVEL IN, BECAUSE THAT IS THE LEVEL THE RULE CHECKS. The first version named keys alone and
 * told an operator "Blocks were: toolUse. Expected each to carry text or toolUse", naming the kind
 * it received as the kind it wanted. Naming the type as well fixed that for a `text` holding a
 * number and left the identical hole one level down: `toolUse:object` says nothing when what
 * disagreed is a field INSIDE the toolUse, which is now the common case, since `readContentBlocks`
 * decides on `name` and `toolUseId`. Values are never printed, only key names and `typeof`, so no
 * model text escapes through here into a log.
 *
 * A NEWER BLOCK KIND IS THE THIRD VERSION OF THAT SAME HOLE, and `describeBlockEntry` closes it: a
 * member the installed SDK has never heard of arrives wrapped, and naming it `$unknown:array` was
 * the exact failure the two paragraphs above describe, one layer further out.
 */
function describeBlocks(content: readonly unknown[]): string {
  const described = content.map((block) => {
    if (block === null || typeof block !== 'object') return typeof block;
    // The same answer `describeHeld` gives one level down, and it has to be, since the two were
    // written together and an operator reading them side by side would otherwise see an array
    // named two ways in one sentence. Naming a block by index tells nobody anything.
    if (Array.isArray(block)) return 'array';
    const named = Object.entries(block).map(
      ([key, held]) => `${printableName(key)}:${describeBlockEntry(key, held)}`,
    );
    // A block with no own keys has nothing to name, and the empty string it used to return left a
    // blank stretch mid-sentence that read as a rendering fault rather than as the finding.
    return named.length > 0 ? joinWithinBudget(named, '+', BLOCK_ENTRY_BUDGET) : '{}';
  });
  // THE PER-NAME CAP BOUNDS A NAME, NOT THIS LINE, and the first fix for that SLICED. Every block
  // adds to the line, so a reply carrying a thousand of the SHORTEST possible unreadable block,
  // `toolUse:{}`, wrote a 12,537-character log record while each individual name sat well inside its
  // 60. Cutting that with `slice` cut a BLOCK, and because a block's keys are escaped it cut an
  // ESCAPE: a listing cut at 800 ended on `\x20`, a VALID escape meaning SPACE, where the wire had
  // sent a right-to-left override. Measured, on the line above this one, in the commit that added the
  // escaping. So the wire chose what the truncation said, which is the whole problem wearing the
  // clothes of its own fix. Whole blocks now, at every level, and BOTH counts survive, because how
  // many arrived is the number an operator acts on.
  return joinWithinBudget(described, ', ', BLOCK_LIST_BUDGET);
}

/**
 * Read a Converse response into the loop's reply union.
 *
 * WHEN THE MODEL BOTH SPOKE AND ASKED FOR TOOLS, THE TOOLS WIN AND THE TEXT IS DROPPED. `ChatReply`
 * is a union precisely so "answered AND asked" is not representable, and the loop's own note says
 * providers differ on this and it should not have a branch for a state it will not act on. Anthropic
 * models frequently emit a sentence of narration before a `toolUse`. Returning that narration as an
 * ANSWER would be the serious bug: an answer is judged and can end the turn, so a model that said
 * "let me search for that" while asking to search would end turns with the narration and never run
 * the search.
 */
export function parseConverseReply(response: unknown): ChatReply {
  if (!response || typeof response !== 'object') {
    throw new ChatUnreadableError(
      `The chat response was ${response === null ? 'null' : typeof response}, not an object.`,
    );
  }

  const output = (response as { output?: { message?: { content?: unknown } } }).output;
  const content = output?.message?.content;
  if (!Array.isArray(content)) {
    // THE SAME RULE AS THE BLOCK LISTING, AND IT WAS MISSED HERE FOR THE SAME REASON EVERY TIME: the
    // escaping went in where the reviewer had been looking. These keys came off the wire exactly as
    // the block keys did, and this is the EARLIER sink, reached before a single block is read, so a
    // body shaped to land here is the cheaper way to write the log line. Raw and uncapped until now.
    const keys =
      joinWithinBudget(
        Object.keys(response as Record<string, unknown>).map((key) => printableName(key)),
        ', ',
        TOP_LEVEL_KEY_BUDGET,
      ) || 'none';
    throw new ChatUnreadableError(
      `The chat response carried no message content this adapter recognises. Top level keys were: ` +
        `${keys}. Expected output.message.content to be an array of blocks.`,
    );
  }

  // WHY A CUT-OFF REPLY IS REFUSED RATHER THAN RETURNED. `max_tokens` and its neighbours mean the
  // model stopped for a reason that is not "I finished". What comes back is well formed prose right
  // up to the point where it stops, so it reads exactly like a finished answer, and `judgeAnswer`
  // reads prose: it cannot tell half an answer from a whole one. The turn would end on the half,
  // wearing the face of the whole, which is the failure the empty-reply refusal below already exists
  // to stop. This is the only place in the system that can see the difference.
  const stopReason = (response as { stopReason?: unknown }).stopReason;
  if (typeof stopReason !== 'string' || !COMPLETE_STOP_REASONS.has(stopReason)) {
    // Escaped for the same reason a block name is. This one is easier to miss because the value is
    // usually one of a handful of known words, so it reads like a closed set and is not one: the
    // check above rejects everything OUTSIDE that set, which means the only values that ever reach
    // this line are the ones nobody vetted.
    const named = stopReason === undefined ? 'none given' : printableName(String(stopReason));
    throw new ChatResponseError(
      `The model stopped for the reason "${named}", which is not one of ` +
        `${[...COMPLETE_STOP_REASONS].join(', ')}. The reply is cut short, filtered or otherwise not ` +
        'the whole of what was asked for, and returning it would end the turn on something that ' +
        'reads as a considered answer. If this is "max_tokens", the ceiling is AGENT_MAX_TOKENS and ' +
        'raising it is a setting rather than a code change.',
    );
  }

  const { recognised, undeclaredToolUse, undeclaredText, calls, said } = readContentBlocks(content);

  // A TOOL CALL ASKED FOR AND DROPPED IS LOUD WHATEVER ELSE THE REPLY CARRIED, and this is the one
  // check that runs before anything is returned. The counter below cannot stand in for it, in either
  // direction. A reply of `[{ text: 'Let me search the memory for that.' }, { toolUse: { toolUseId:
  // 'x', toolName: 'recall' } }]` leaves `recognised` at 1 on the strength of the narration, so the
  // count at the bottom is never reached, the dropped call leaves no trace in `calls`, and the turn
  // returns the model's own throat-clearing as the answer to an incident question with the recall
  // never run. That is a wrong answer served as a considered one, which is the exact failure the
  // whole split exists to prevent, and it is what the previous version did. Ordering matters for the
  // same reason: a malformed `toolUse` beside a VALID one would return `kind: 'tools'` and run half
  // of what the model asked for, so the check cannot sit after that return either.
  //
  // WHY THIS IS STRONG EVIDENCE WHERE AN UNREAD BLOCK IS WEAK. `toolUse` is a kind this build knows
  // and the SDK declares `toolUseId` and `name` as required members of it. An object there that
  // holds neither is the API and this build disagreeing about a shape both claim to implement.
  // An unread block of an unknown KIND, `reasoningContent` beside a text block say, is nothing of
  // the sort: it is a provider doing something a provider may do, and it stays quiet below.
  //
  // WHAT IT DELIBERATELY DOES NOT FLAG: a `toolUse` that is ABSENT, which is every text block in
  // every reply. That is the quiet case this rule is drawn around and the only one that has to be.
  //
  // A KIND NEWER THAN THE SDK IS COUNTED HERE WHEN IT ARRIVES ALONE ON ITS BLOCK, AND THE ARGUMENT
  // FOR LEAVING IT OUT ALTOGETHER WAS WRONG. Such a block is filed as `$unknown: [wireKey, value]`
  // under a name only the wire knows, so
  // `[{ text: 'narration' }, { $unknown: ['toolUseV2', { toolUseId: 'x', name: 'recall' }] }]` used
  // to come back as the narration alone. The previous version of this paragraph called reading that
  // "guessing an unfamiliar kind is a tool call from its NAME" and left it a documented limit. That
  // was the wrong description of the available evidence. The name is never read. What is read is the
  // same structural fact the paragraph above already calls strong: the held value carries `toolUseId`
  // AND `name` as strings, which is what the SDK declares a tool call to be. And the consequence is a
  // REFUSAL, not a dispatch, so nothing is ever executed on the strength of it.
  //
  // THE FALSE POSITIVE IS A FUTURE KIND CARRYING BOTH FIELDS WITHOUT BEING A CALL, and it costs one
  // turn's receipts. `toolResult` carries `toolUseId` alone and does not trip it. `$unknown` is
  // written only when exactly one unmarked key is left AND nothing else on the block was recognised,
  // so a block reaching that test carries no other content to weigh against it. Against that sits
  // the failure it closes, which is the one this entire split exists to prevent: a tool the model
  // asked for dropped in silence, with narration returned in its place.
  //
  // WHAT THIS STILL CANNOT SEE, WHICH IS THE PARAGRAPH ABOVE READ FROM THE OTHER SIDE. The condition
  // that keeps the false positives narrow is the same condition that leaves a hole, and the version
  // that shipped stated the first half as a safety argument without ever turning it around. `$unknown`
  // is written only when nothing else on the block was recognised, so an unknown kind SHARING a block
  // with a declared member is discarded by the deserializer before anything here runs. A wire block of
  // `{ text: 'narration', toolUseV2: {...} }` reaches this function as `{ text: 'narration' }` with the
  // call already gone: no key, no marker, no tuple to test, nothing to count. No rule written here can
  // close that, because the evidence never arrives. It is pinned by a test driving the real client
  // instead, so an SDK that begins keeping those keys goes red rather than quietly widening what this
  // branch is understood to cover.
  //
  // TWO EARLIER VERSIONS OF THIS PARAGRAPH BOTH ARGUED FROM SHAPES NOBODY HAD MEASURED. The first
  // said absent union members are not serialised as `null` today, but that if they ever were, every
  // text block would carry one and turning all of them loud would empty the product. That cannot
  // happen. `ContentBlock` is a union schema and `_readStruct` in @aws-sdk/core protocols copies a
  // member only when `record[fromKey] != null`, a loose comparison, so a wire `"toolUse": null`
  // leaves the key off the object entirely. The second then said the quiet branch was carrying
  // `undefined` and could stand as it was. It was carrying more than that, and the extra was a hole.
  // The test was `typeof use === 'object'`, and a canned wire body driven through the real client
  // returns `"toolUse": 7` as the number 7, `"toolUse": "recall"` as the string, and only an ARRAY
  // normalised to `{}`. Each of those was skipped without a word, so beside one sentence of
  // narration the call was dropped and the narration was returned as the answer.
  //
  // SO PRESENCE IS THE TEST AND TYPE IS NOT. The `toolUse` key being there is the model asking for a
  // tool. Whether what it holds is legible is the failure, never the exemption. That rule is wider
  // than the one it replaced and the SDK evidence is what makes the width safe: `null` cannot arrive
  // and absent members are never copied, so nothing a conforming reply carries is on the loud side.
  if (undeclaredToolUse > 0) {
    throw new ChatUnreadableError(
      `The chat response asked for ${undeclaredToolUse} tool call(s) this adapter could not read, ` +
        `and answering without them would drop what the model asked for. Blocks were: ` +
        `${describeBlocks(content as readonly unknown[])}, named by key and by what the key held, ` +
        'one level in. A toolUse must hold an object whose name and toolUseId are both strings, and ' +
        'a block the SDK could not name counts here too when it stood alone and held both of those. ' +
        'A tool call arriving in a shape the SDK does not declare is this build no longer matching ' +
        'the API, and until that is read every tool this model asks for is dropped.',
    );
  }

  // THE SAME RULE ON THE OTHER DECLARED MEMBER, AND IT WAS MISSING FOR SIX ROUNDS while the one
  // above was widened three separate times. `toolUse` is guarded in every position by its counter.
  // `text` was guarded only by `recognised === 0`, which is the exact narrow enforcement rounds
  // three, four and five each tore out of the `toolUse` side in turn. One good sentence beside a
  // broken one holds `recognised` above zero, so `[{ text: 'Cause: ' }, { text: 7 }, { text: ' the
  // pool.' }]` returned "Cause: \n the pool." with a 200 and nothing raised. That is not a refusal
  // and it is not a cut-off reply. It is an answer with a hole in the middle of a sentence, served
  // as a considered one, and it is worse than the `max_tokens` case refused above, which at least
  // stops at the END where a reader can see it stop.
  //
  // WHY IT IS UNCONDITIONAL RATHER THAN GATED ON THE ANSWER PATH. The narrow version would sit
  // after the `calls.length > 0` return, on the argument that narration beside a tool call is
  // discarded anyway so a broken one costs nothing. That argument is about THIS reply, and the
  // failure is not about this reply: a `text` arriving in an undeclared shape is systemic, it will
  // be true of every reply, and gating it would keep the build quiet until the first text-only turn
  // arrived. Loud on the first request rather than quiet on all of them is the rule the paragraph
  // below already argues for, and a guard with no ordering condition is the one that cannot be
  // narrowed by accident. The cost is one turn's receipts on a mixed reply that is already proof of
  // a broken build.
  //
  // CHECKED AFTER `toolUse` DELIBERATELY. A reply carrying both faults is a dropped ACTION and a
  // dropped SENTENCE, and the action is the more consequential of the two, so it names the failure.
  // That ordering also leaves every row that predates this guard on exactly the throw it had.
  if (undeclaredText > 0) {
    throw new ChatUnreadableError(
      `The chat response carried ${undeclaredText} text block(s) holding something other than a ` +
        'string, and answering would serve the rest as though it were the whole reply. Blocks ' +
        `were: ${describeBlocks(content as readonly unknown[])}, named by key and by what the key ` +
        'held, one level in. A text must hold a string. A kind this adapter knows arriving in a ' +
        'shape the SDK does not declare is this build no longer matching the API, and until that ' +
        'is read every reply from this model is missing whatever those blocks were carrying.',
    );
  }

  if (calls.length > 0) return { kind: 'tools', calls };
  const text = said.join('\n').trim();
  if (text.length > 0) return { kind: 'answer', text };

  // Either way an empty reply is refused rather than passed on as an empty answer. An empty string
  // reaching `judgeAnswer` is PERMITTED, because it claims no absence, so the turn would end on
  // silence that reads as a considered answer. What the two branches below decide is not whether to
  // refuse, it is who the failure belongs to and therefore what the caller is left holding.
  //
  // THIS USED TO BE ONE THROW AND IT WAS THE WRONG ONE ON THE COMMON CASE. Both outcomes raised
  // `ChatUnreadableError`, the loop deliberately does not catch that, so a model that simply went
  // quiet on round three took the transcript, the recall receipts and the coverage verdict out with
  // it as a 500 under rule `unclassified`. A reviewer drove the real adapter to show it: a silent
  // `end_turn` on round two returned 500 and zero receipts, and reverting this one site to
  // `ChatResponseError` returned a 200 refusal carrying the recall that had already run. The
  // comment that stood here argued the trade was worth it. It never was a trade, because these are
  // two different failures and one line was asking them to share an answer.
  //
  // THE LINE BETWEEN THEM IS WHETHER THIS ADAPTER READ ANYTHING, WHICH IS NEITHER WHETHER ANYTHING
  // CAME BACK NOR WHETHER ANYTHING WAS USABLE. Blocks arrived and not one of them was read: that is
  // this build disagreeing with the API, it would empty EVERY reply while the stop reason stayed
  // `end_turn`, and it has to be loud on the first request rather than quiet on all of them.
  // Anything else is a provider doing something a provider may do on one turn, and the turn keeps
  // what it had established. `content.length === 0` lands in the second: no blocks is a response
  // this adapter read perfectly and a model that said nothing, and reading it as a shape failure is
  // what produced the 500 above. So does a block that was read and turned out to hold nothing,
  // which now means an empty string, since a `toolUse` shaped as declared always yields a call.
  //
  // ONE BLOCK READ IS ENOUGH TO KEEP THE WHOLE RESPONSE QUIET, and that is deliberate rather than an
  // accident of the counter. A response mixing something this adapter read with something it did not
  // is WEAK EVIDENCE of a shape change - one block parsing normally says the disagreement is not
  // systemic - and a 500 would cost this turn its receipts to report a suspicion. It is NOT a claim
  // that the reply carried anything: a read block can be empty, and then the turn refuses like any
  // other empty reply. The sentence that stood here said "something got through, so replies are not
  // all empty", which was measurably false for the very row it was written to justify, and was the
  // same read-versus-yielded conflation this file spent two rounds taking out of the counter above.
  //
  // THAT WEAK-EVIDENCE ARGUMENT IS ABOUT AN UNREAD BLOCK OF AN UNKNOWN KIND, AND ONLY THAT. It was
  // written as though it settled every mixed reply, and a reviewer walked the case it does not
  // settle: a read block can hold NARRATION rather than nothing, and then the turn does not refuse
  // at all, it answers with the narration while a tool call the model asked for is dropped without
  // a word. Nothing about that is weak evidence. It no longer reaches this paragraph, because
  // `undeclaredToolUse` is checked above before anything is returned, and what is left here is the
  // case this argument always meant: a kind this build does not handle, sitting beside one it does.
  if (content.length > 0 && recognised === 0) {
    const kinds = describeBlocks(content as readonly unknown[]);
    throw new ChatUnreadableError(
      `The chat response carried ${content.length} content block(s) and this adapter read none of ` +
        `them. Blocks were: ${kinds}, named by key and by what the key held, one level in. This ` +
        'adapter reads a text holding a string, and a toolUse holding an object whose name and ' +
        'toolUseId are both strings. A kind it knows arriving in a shape the SDK does not declare ' +
        'is this build no longer matching the API, and until that is read every reply from this ' +
        'model is empty.',
    );
  }
  throw new ChatResponseError(
    'The model returned neither text nor a tool call. There is nothing here to answer with, and an ' +
      'empty answer would end the turn looking like a considered one. The response itself was one ' +
      'this adapter reads, so this is the model going quiet on one turn rather than a build that ' +
      'cannot read replies, and the turn keeps whatever it had already established.',
  );
}

export function createBedrockChatModel(options: BedrockChatModelOptions): ChatModel {
  const { modelId, region } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Chat timeout must be a positive number of milliseconds, received ${timeoutMs}.`);
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`Chat maxTokens must be a positive integer, received ${maxTokens}.`);
  }

  const createClient =
    options.createClient ?? ((forRegion: string) => new BedrockRuntimeClient({ region: forRegion }));
  const client = options.client ?? createClient(region);

  return {
    // The audit row records this, so an answer can be traced to the model that produced it.
    id: `bedrock:${modelId}`,

    async reply({ system, history, tools }): Promise<ChatReply> {
      // Built BEFORE the deadline starts and OUTSIDE the try below, because every line of it is our
      // own code. A throw from `toConverseMessages`, from `toToolConfig` or from the command
      // constructor is a bug in this repository, and reporting it as a ChatProviderError would put
      // an outage in the operator's log against AWS for a call AWS never saw. Building first also
      // means such a throw cannot leave the deadline timer armed behind it.
      const command = new ConverseCommand({
        modelId,
        system: [{ text: system }],
        messages: toConverseMessages(history) as ConverseCommand['input']['messages'],
        toolConfig: toToolConfig(tools) as ConverseCommand['input']['toolConfig'],
        inferenceConfig: { maxTokens, temperature },
      });

      const controller = new AbortController();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      // The deadline is enforced here rather than delegated, for the reason the embedder gives: the
      // SDK retries with sleeps that do not observe the abort signal, so a throttled call can
      // outlive the budget by seconds. The abort still fires to stop work we no longer want; the
      // race is what makes the promise settle on time.
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new ChatTimeoutError(modelId, timeoutMs));
        }, timeoutMs);
      });

      let response: unknown;
      try {
        response = await Promise.race([
          client.send(command, { abortSignal: controller.signal }),
          deadline,
        ]);
      } catch (error) {
        if (error instanceof ChatTimeoutError) throw error;
        if (timedOut) {
          // The call failed because we aborted it. Keep the original on `cause` rather than
          // discarding it: if it was a real error that merely landed late, that is worth reading.
          throw new ChatTimeoutError(modelId, timeoutMs, { cause: error });
        }
        const described = describeProviderError(error);
        throw new ChatProviderError(
          modelId,
          described.name,
          { httpStatusCode: described.httpStatusCode, requestId: described.requestId },
          error,
        );
      } finally {
        clearTimeout(timer);
      }

      return parseConverseReply(response);
    },
  };
}
