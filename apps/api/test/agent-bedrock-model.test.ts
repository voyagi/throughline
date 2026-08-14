import { describe, expect, it, vi } from 'vitest';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  BLOCK_ENTRY_BUDGET,
  ChatProviderError,
  ChatResponseError,
  ChatTimeoutError,
  ChatUnreadableError,
  createBedrockChatModel,
  INNER_KEY_BUDGET,
  parseConverseReply,
  toConverseMessages,
  toToolConfig,
  type ConverseCapableClient,
} from '../src/agent/bedrock-model.ts';
import { TOP_LEVEL_KEY_BUDGET } from '../src/printable-name.ts';
import { z } from 'zod';
import { runAgentTurn, SYSTEM_PROMPT, type Turn } from '../src/agent/loop.ts';
import { TOOLS, type ToolDefinition } from '../src/agent/tools.ts';
import { fakeRepository, recallResult, repositoryReturning, scoredMemory } from './agent-fixtures.ts';

const OPTIONS = { modelId: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', region: 'eu-central-1' };

/**
 * What a test wants to read back off the call. `options` is explicitly `| undefined` rather than
 * merely optional, because `exactOptionalPropertyTypes` is on and the client's own signature makes
 * the argument optional: an absent one arrives here as `undefined` and has to be storable.
 */
type Capture = { command?: unknown; options?: { abortSignal?: AbortSignal } | undefined };

/** A response in the shape Converse actually returns, so the double is not easier than production. */
function converseWith(content: unknown[], capture?: Capture): ConverseCapableClient {
  return {
    send(command, options) {
      if (capture) {
        capture.command = command;
        capture.options = options;
      }
      return Promise.resolve({ output: { message: { role: 'assistant', content } }, stopReason: 'end_turn' });
    },
  };
}

function inputOf(capture: Capture): {
  modelId: string;
  system: { text: string }[];
  messages: { role: string; content: Record<string, unknown>[] }[];
  toolConfig: { tools: { toolSpec: { name: string; description: string; inputSchema: { json: Record<string, unknown> } } }[] };
  inferenceConfig: { maxTokens: number; temperature: number };
} {
  return (capture.command as { input: ReturnType<typeof inputOf> }).input;
}

/**
 * Is every escape in this message a WHOLE one?
 *
 * The property the escaping exists for, asserted directly instead of by naming one expected string.
 * A cut escape is not merely unreadable: a listing cut at 800 characters ended on `\x20`, a VALID
 * escape meaning SPACE, where the wire had sent a right-to-left override, so the truncation itself
 * said something the wire chose. Both caps had a `slice` in them and both passed every assertion
 * written against a specific expected string, because those assertions only ever looked at the
 * beginning of the line. This looks at all of it, and it is shared by the two tests rather than
 * written twice, since two copies of one rule is what put the hole in the pair of adapters.
 */
function everyEscapeIsWhole(text: string): boolean {
  // WALKING FROM THE LEFT, BECAUSE ONLY THAT KNOWS WHICH BACKSLASHES ARE ALREADY SPOKEN FOR. The
  // first version looked only where `\x{` appeared and then checked the END of the string, so a lone
  // backslash sitting mid-line, which is precisely what a cut escape leaves behind, returned true.
  // A lookahead does not fix it either: `\\a` is the correct rendering of a wire name of `\a`, and
  // any rule reading the second backslash on its own rejects it. Measured both ways before this.
  const ALPHABET = ['\\\\', '\\empty', '\\...'];
  let at = 0;
  while (at < text.length) {
    if (text[at] !== '\\') {
      at += 1;
      continue;
    }
    const rest = text.slice(at);
    const spelled = ALPHABET.find((candidate) => rest.startsWith(candidate));
    if (spelled !== undefined) {
      at += spelled.length;
      continue;
    }
    const escape = /^\\x\{[0-9a-f]+\}/.exec(rest);
    if (escape === null) return false;
    at += escape[0].length;
  }
  return true;
}

/** The transcript shape `runAgentTurn` actually builds: interleaved call and result, then a refusal. */
const FULL_TRANSCRIPT: Turn[] = [
  { role: 'user', content: 'Have we seen this before?' },
  { role: 'tool_call', id: 'tc-1', given: 'toolu_abc', name: 'recall', args: { query: 'checkout' } },
  { role: 'tool_result', id: 'tc-1', name: 'recall', content: 'COVERAGE: UNKNOWN. Nothing ran.' },
  { role: 'assistant', content: 'There are no prior incidents on record.' },
  { role: 'refusal', content: 'That answer says something does not exist. Rewrite it.' },
];

describe('toConverseMessages', () => {
  it('maps a user turn to a user message carrying its text', () => {
    expect(toConverseMessages([{ role: 'user', content: 'hello' }])).toEqual([
      { role: 'user', content: [{ text: 'hello' }] },
    ]);
  });

  // THE ALTERNATION RULE, and it is the reason the merge exists rather than a tidiness preference.
  // Converse rejects two messages of the same role in a row outright, so a transcript that ever put
  // two user turns together would 400 for every model, every time.
  it('merges adjacent turns of the same role into one message', () => {
    const merged = toConverseMessages([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toEqual([{ text: 'first' }, { text: 'second' }]);
  });

  it('never emits two messages of the same role in a row, over a realistic transcript', () => {
    const roles = toConverseMessages(FULL_TRANSCRIPT).map((message) => message.role);
    expect(roles.length).toBeGreaterThan(2);
    for (let index = 1; index < roles.length; index += 1) {
      expect(roles[index]).not.toBe(roles[index - 1]);
    }
  });

  it('starts the conversation with a user message, which every Anthropic model requires', () => {
    expect(toConverseMessages(FULL_TRANSCRIPT)[0]?.role).toBe('user');
  });

  // THE DELIBERATE DIVERGENCE. `loop.ts` says an adapter hands `given` back, and this does not.
  // Converse is stateless, so a toolUseId only has to be self consistent within what we send, and
  // `given` arrives from the model with nothing constraining it: `loop.ts` documents a model that
  // reused one id for every call. Duplicated ids here are a 400. `tc-N` is unique by construction.
  it('replays tool calls under the loop id rather than the id the model gave', () => {
    const [, assistant] = toConverseMessages(FULL_TRANSCRIPT);
    expect(assistant?.content).toEqual([
      { toolUse: { toolUseId: 'tc-1', name: 'recall', input: { query: 'checkout' } } },
    ]);
    expect(JSON.stringify(assistant)).not.toContain('toolu_abc');
  });

  it('answers each tool call with a result under the same id', () => {
    const messages = toConverseMessages(FULL_TRANSCRIPT);
    const used = messages.flatMap((message) =>
      message.content.flatMap((block) => ('toolUse' in block ? [block.toolUse.toolUseId] : [])),
    );
    const answered = messages.flatMap((message) =>
      message.content.flatMap((block) => ('toolResult' in block ? [block.toolResult.toolUseId] : [])),
    );
    expect(used).toEqual(['tc-1']);
    expect(answered).toEqual(used);
  });

  // A refusal is the LOOP speaking, not the user. Converse has no role for that, so it travels as a
  // user turn, and without the prefix the model would read the system's correction as the operator
  // scolding it. Which reader thinks it said something is the whole point of the `refusal` role.
  it('marks a refusal as the system rather than letting it read as the user', () => {
    const messages = toConverseMessages([{ role: 'refusal', content: 'Rewrite it.' }]);
    const block = messages[0]?.content[0];
    expect(messages[0]?.role).toBe('user');
    expect(block).toBeDefined();
    expect(block && 'text' in block ? block.text : '').toMatch(/not the user speaking/);
    expect(block && 'text' in block ? block.text : '').toContain('Rewrite it.');
  });

  // THE INPUT IS DELIBERATELY IN THE WRONG ORDER. An earlier version of this test fed the blocks
  // already sorted, so the sort was a no-op on them and deleting it outright left this green.
  it('puts tool results first when a message carries text as well', () => {
    const messages = toConverseMessages([
      { role: 'user', content: 'and another thing' },
      { role: 'tool_result', id: 'tc-1', name: 'recall', content: 'result' },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content[0]).toHaveProperty('toolResult');
    expect(messages[0]?.content[1]).toHaveProperty('text');
  });

  it('sends an empty object rather than nothing when a tool call carried no arguments', () => {
    const messages = toConverseMessages([
      { role: 'tool_call', id: 'tc-1', given: 'g', name: 'recall', args: null },
    ]);
    const block = messages[0]?.content[0];
    expect(block && 'toolUse' in block ? block.toolUse.input : undefined).toEqual({});
  });
});

describe('toToolConfig', () => {
  it('describes every tool the loop offers', () => {
    const config = toToolConfig(TOOLS);
    expect(config.tools.map((entry) => entry.toolSpec.name)).toEqual(TOOLS.map((tool) => tool.name));
  });

  it('carries the description the model is meant to read', () => {
    const recall = toToolConfig(TOOLS).tools.find((entry) => entry.toolSpec.name === 'recall');
    expect(recall?.toolSpec.description).toMatch(/never report that something did not happen/);
  });

  // GENERATED FROM THE VALIDATOR'S OWN SCHEMA, not written beside it. A hand-copied schema drifts,
  // and the symptom is a model that "keeps getting the arguments wrong" while the validator is right.
  it('derives the schema from the same Zod object the loop validates against', () => {
    const recall = toToolConfig(TOOLS).tools.find((entry) => entry.toolSpec.name === 'recall');
    const json = recall?.toolSpec.inputSchema.json as { properties?: Record<string, unknown>; required?: string[] };
    expect(json.required).toEqual(['query']);
    expect(json.properties).toHaveProperty('limit');
  });

  it('drops the dialect annotation, which describes the schema rather than the arguments', () => {
    for (const entry of toToolConfig(TOOLS).tools) {
      expect(entry.toolSpec.inputSchema.json).not.toHaveProperty('$schema');
    }
  });
});

/** Converse always says why it stopped, so a fixture that omits it is not a response. */
function finished(content: unknown[], stopReason = 'end_turn'): unknown {
  return { output: { message: { content } }, stopReason };
}

/**
 * The refusal these blocks produce, or the empty string if they produced none.
 *
 * Returned rather than thrown, so a reply that stopped refusing fails the assertion about the
 * SENTENCE rather than an assertion about this helper, which would name the wrong thing. Shared by
 * the escaping tests and the listing-cap test because they read the same sentence for two different
 * properties, and the alternative is the copy-and-drift this whole change is about.
 */
function messageForBlocks(blocks: unknown[]): string {
  try {
    parseConverseReply(finished(blocks));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('parseConverseReply', () => {
  it('reads plain text as an answer', () => {
    expect(parseConverseReply(finished([{ text: 'done' }]))).toEqual({
      kind: 'answer',
      text: 'done',
    });
  });

  it('joins several text blocks rather than keeping only one', () => {
    const reply = parseConverseReply(finished([{ text: 'a' }, { text: 'b' }]));
    expect(reply).toEqual({ kind: 'answer', text: 'a\nb' });
  });

  it('reads a tool use as a tool call', () => {
    const reply = parseConverseReply(
      finished([{ toolUse: { toolUseId: 'x', name: 'recall', input: { query: 'q' } } }], 'tool_use'),
    );
    expect(reply).toEqual({ kind: 'tools', calls: [{ id: 'x', name: 'recall', args: { query: 'q' } }] });
  });

  // THE TRUNCATION REFUSAL. A reply cut off at the token ceiling arrives as well formed prose that
  // stops mid-thought, and `judgeAnswer` reads prose. Nothing downstream of here can tell it from a
  // finished answer, so this is the only place the difference is visible at all.
  it('refuses a reply the model was cut off in the middle of', () => {
    const cutOff = finished([{ text: 'The likely cause is the connection pool, which' }], 'max_tokens');
    expect(() => parseConverseReply(cutOff)).toThrow(ChatResponseError);
    expect(() => parseConverseReply(cutOff)).toThrow(/max_tokens/);
  });

  it('refuses a reply a filter or a guardrail altered on the way out', () => {
    for (const reason of ['content_filtered', 'guardrail_intervened', 'model_context_window_exceeded']) {
      expect(() => parseConverseReply(finished([{ text: 'reads fine' }], reason))).toThrow(ChatResponseError);
    }
  });

  // AN ALLOWLIST, not a list of bad reasons. A stop reason invented after this was written has to
  // refuse rather than pass, or the guard quietly becomes a no-op the year Bedrock adds one.
  it('refuses a stop reason it has never heard of, and a body carrying none at all', () => {
    expect(() => parseConverseReply(finished([{ text: 'hi' }], 'invented_later'))).toThrow(/invented_later/);
    expect(() => parseConverseReply({ output: { message: { content: [{ text: 'hi' }] } } })).toThrow(
      /none given/,
    );
  });

  it('accepts the three reasons that mean the model actually finished', () => {
    expect(parseConverseReply(finished([{ text: 'done' }], 'stop_sequence'))).toEqual({
      kind: 'answer',
      text: 'done',
    });
    expect(parseConverseReply(finished([{ text: 'done' }], 'end_turn')).kind).toBe('answer');
    expect(
      parseConverseReply(finished([{ toolUse: { toolUseId: 'x', name: 'recall', input: {} } }], 'tool_use')).kind,
    ).toBe('tools');
  });

  // THE ONE THAT MATTERS. Anthropic models routinely narrate before calling a tool. Returning that
  // narration as an ANSWER would be a serious bug rather than a cosmetic one: an answer is judged
  // and can END the turn, so "let me search for that" would finish the turn and the search would
  // never run. `ChatReply` is a union precisely so this cannot be represented as both.
  it('treats narration alongside a tool call as a tool call, not as an answer', () => {
    const reply = parseConverseReply(
      finished(
        [
          { text: 'Let me search the incident memory for that.' },
          { toolUse: { toolUseId: 'x', name: 'recall', input: {} } },
        ],
        'tool_use',
      ),
    );
    expect(reply.kind).toBe('tools');
    expect(JSON.stringify(reply)).not.toContain('Let me search');
  });

  // An empty answer is PERMITTED by `judgeAnswer`, because it claims no absence, so it would end the
  // turn on silence that reads like a considered reply. Refusing here is what stops that.
  it('refuses an empty reply rather than ending the turn on silence', () => {
    expect(() => parseConverseReply(finished([]))).toThrow(ChatResponseError);
    expect(() => parseConverseReply(finished([{ text: '   ' }]))).toThrow(/neither text nor a tool call/);
  });

  /**
   * THE SPLIT, PINNED AS ONE TABLE, because the two classes read as interchangeable and the whole
   * behaviour of a failed turn hangs on which one arrives.
   *
   * `ChatResponseError` means the provider answered and this adapter read the answer: the loop
   * catches it, the turn ends as a 200 refusal, and the transcript and the receipts survive.
   * `ChatUnreadableError` means the response was not a shape this adapter reads, which is this
   * build being wrong about the API rather than one turn going badly. Nothing catches it, so it
   * leaves as a 5xx. Written down as an assertion rather than as a comment because the failure it
   * guards is silent: class them together again and a shape change answers every question with
   * "no answer" while the error rate stays flat and `/health` keeps saying ok.
   *
   * THE EMPTY REPLY MOVED SIDES AND THAT IS THE POINT OF THE `readable` ROWS. It used to sit in the
   * list below and a reviewer showed what that cost on the real adapter: a model going quiet on
   * round two returned a 500 carrying none of the recalls the turn had already run. An empty reply
   * is a response this adapter read perfectly, so it belongs with the cut-off one.
   *
   * THE RULE THIS TABLE ENCODES, WRITTEN OUT BECAUSE THE SENTENCE THAT STOOD HERE WAS AN EXCLUSIVE
   * THE TABLE ITSELF DISPROVED. It said only "blocks arrived and not one of them was a kind this
   * build knows" is a shape disagreement, twenty-two lines above a row asserting that `{ text: 7 }`
   * is one - and `text` is a kind this build knows. The real line is the SDK's declaration, not the
   * key alone: a response is a shape disagreement when NOT ONE of its blocks carried a kind this
   * adapter knows SHAPED AS THE SDK DECLARES IT. `text` is declared a string, so a number under that
   * key goes loud. `ToolUseBlock` declares `toolUseId`, `name` and `input` with NO `?` and only
   * `type?` with one, so a `toolUse` is read when `name` and `toolUseId` are both strings.
   *
   * THE REPLACEMENT SENTENCE WAS THEN WRONG ABOUT THE SDK, WHICH IS WHY THE ROWS MOVED AGAIN. It
   * read `name: string | undefined` as "declared optional" and put a nameless `toolUse` on the quiet
   * side. The type includes `undefined` because smithy writes EVERY required field that way, so that
   * conclusion inverted the fact, and the code resting on it read a renamed field as a block worth
   * counting: a model emitting `{ toolUse: { toolUseId: 'x', toolName: 'recall' } }` refused every
   * turn with the 5xx rate flat, which is the failure the first paragraph says this split exists to
   * prevent. So a nameless AND a renamed `toolUse` are both on the LOUD side now, and the cost of
   * that is stated rather than hidden: a genuinely nameless block loses one turn's receipts. Silent
   * and systemic is the worse of the two failures, so it is the one the line is drawn against.
   *
   * EVERY MALFORMED `toolUse` ABOVE ARRIVES ALONE, AND THAT IS HOW THE NEXT ROUND'S BUG SURVIVED
   * THIS TABLE. Arriving alone, all of them reach the loud path through "not one block was read", so
   * the table proved the RULE while saying nothing about what enforced it. A malformed `toolUse`
   * beside a block that WAS read appeared nowhere in this file, and that is exactly the reply the
   * paragraph above is about: one sentence of narration, one renamed tool call. It answered with the
   * narration and dropped the call, quietly, which is the failure this whole split exists to prevent.
   * The mixed rows at the bottom of the loud list are the ones that hold the rule up now, and a
   * table of one-block replies is the shape of test that could never have.
   *
   * THE ROUND AFTER THAT, THE SAME GAP REOPENED ONE TYPE ALONG. The mixed rows added above both
   * carried an OBJECT under `toolUse`, and the counter behind them tested for an object, so a mixed
   * row carrying a PRIMITIVE was still answered with the narration in silence. Two of those are on
   * the loud list now. A mixed row is not one shape, it is a shape times whatever the key can hold,
   * and adding the first one does not cover the rest.
   *
   * The `reasoningContent` row appears on BOTH lists deliberately: alone it is loud, because nothing
   * at all was read, and beside a read block it is quiet, because a provider may send a kind this
   * build has never heard of. That pair is what keeps the unknown-kind rule from being widened along
   * with the `toolUse` one.
   *
   * IT DOES NOT MODEL A BLOCK TYPE WRITTEN AFTER THIS FILE, which this paragraph claimed for two
   * rounds while the row named its own key. A kind the installed SDK has never heard of never
   * arrives under its own name at all, so a fixture that spells one out is testing the easy half:
   * a kind the SDK knows and only this adapter ignores. The `$unknown` rows on both lists are the
   * other half, and they are the shape the real client actually delivers.
   */
  it('sorts a reply it could read from a response it could not', () => {
    const readable = [
      finished([{ text: 'The likely cause is the connection pool, which' }], 'max_tokens'),
      finished([]),
      finished([{ text: '  ' }]),
      finished([{ text: '' }]),
      // One block READ beside one that was not, which stays quiet as long as the unread one is a
      // kind this adapter does not handle. That is a provider doing what a provider may do, and it
      // is weak evidence of a shape change rather than proof the reply carried anything: this row
      // yields nothing at all and still refuses on the quiet side.
      //
      // THE ROW THAT USED TO SIT HERE WAS `[{ text: '' }, { toolUse: 'recall' }]` AND IT IS NOW ON
      // THE LOUD LIST. It was justified by saying a string carries no id and no name, so there is
      // no call in it to drop. That argument is wrong in the same way the adapter's own comment was
      // wrong: the `toolUse` key being present is the model asking for a tool, and being unable to
      // read which tool is the failure rather than the excuse. Keeping this position costs a turn's
      // receipts on a reply that was refusing either way, and it bought silence on
      // `[{ text: 'narration' }, { toolUse: 7 }]`, which does not refuse at all.
      //
      // THAT SENTENCE WAS FALSE FOR A ROUND. The row was deleted from here and never added to the
      // other list, so the decision it describes lived in this comment and in a commit message
      // while no test executed it. A strictly gentler rule passed the entire suite meanwhile. It is
      // on the loud list now, at the bottom, which is what makes the claim above checkable.
      finished([{ text: '' }, { reasoningContent: { reasoningText: { text: 'thinking' } } }]),
      // The same weak-evidence rule on the shape a kind newer than the SDK really arrives in. The
      // row above spells out a key the SDK knows; this one is filed under a name only the wire has.
      finished([{ text: '' }, { $unknown: ['futureBlockKind', { detail: 'x' }] }]),
    ];
    for (const response of readable) {
      expect(() => parseConverseReply(response)).toThrow(ChatResponseError);
      expect(() => parseConverseReply(response)).not.toThrow(ChatUnreadableError);
    }

    const unreadable = [
      null,
      'a string',
      7,
      { trace: {} },
      finished([{ reasoningContent: { reasoningText: { text: 'thinking' } } }]),
      // A key this adapter knows against a type the SDK does not declare for it.
      finished([{ text: 7 }]),
      finished([{ toolUse: 'recall' }]),
      finished([{ toolUse: null }]),
      // A kind it knows, wrong one level in. `name` and `toolUseId` are both declared without a
      // `?`, so every row here is a block the API says it should not have sent.
      finished([{ toolUse: {} }]),
      finished([{ toolUse: { toolUseId: 'x' } }]),
      finished([{ toolUse: { name: 'recall' } }]),
      finished([{ toolUse: { name: 7, toolUseId: 'x' } }]),
      finished([{ toolUse: [] }]),
      // Announced as a real tool call carrying `id: ''` until this round, which no tool result can
      // be correlated back to - worse than a refused turn, not better.
      finished([{ toolUse: { toolUseId: 7, name: 'recall' } }]),
      // THE ROW THIS ROUND IS ABOUT: one renamed field, the archetypal breaking change. Counted as
      // read by the previous rule, so a model emitting it refused every turn and raised nothing.
      finished([{ toolUse: { toolUseId: 'x', toolName: 'recall', input: {} } }]),
      // Nothing was read here either, so the mixed row on the quiet side does not cover this one.
      finished([{ text: 7 }, { toolUse: { toolUseId: 'x' } }]),
      // THE TWO ROWS THIS ROUND IS ABOUT, and the first is what a real breaking change looks like
      // arriving in a real reply: a model narrates before it calls a tool, so the renamed call comes
      // in beside a perfectly good sentence. Every row above it is a one-block reply, and until this
      // one existed the response below returned `{ kind: 'answer', text: 'Let me search...' }` with
      // a 200, the recall never run and nothing raised. The narration IS the wrong answer.
      finished([
        { text: 'Let me search the incident memory for that.' },
        { toolUse: { toolUseId: 'x', toolName: 'recall', input: {} } },
      ]),
      // And the same drop hiding behind a call that DID parse. One good call is not permission to
      // throw the other away: the turn would run half of what the model asked for and answer from
      // it, which is the same silence one layer along.
      finished([
        { toolUse: { toolUseId: 'a', name: 'recall', input: {} } },
        { toolUse: { toolUseId: 'b', toolName: 'recall', input: {} } },
      ]),
      // THE ROWS THIS ROUND IS ABOUT, and the shapes are measured rather than invented. Driving the
      // real client with a canned wire body returns `"toolUse": 7` as the number 7 and
      // `"toolUse": "recall"` as the string, because the deserializer enters its struct branch only
      // for a value that is already an object. Both used to be skipped without a word, so the first
      // row here returned `{ kind: 'answer', text: 'Let me search...' }` with a 200 and the call
      // gone. Same silent drop as the two rows above, through a door the rule that closed those did
      // not check, and the mixed row on the quiet list did not cover it because that one carried an
      // EMPTY text and therefore refused anyway.
      finished([{ text: 'Let me search the incident memory for that.' }, { toolUse: 7 }]),
      finished([{ text: 'Let me search the incident memory for that.' }, { toolUse: 'recall' }]),
      // AND THE NULL, which is here because the argument for leaving it out was an argument about
      // the SDK rather than about this adapter: the deserializer drops a null member, so a
      // conforming reply cannot deliver this and `use !== undefined && use !== null` passed the
      // whole suite. That premise about the SDK has now been wrong twice in this file, and the
      // guard says PRESENT AT ALL. A rule allowed to mean two things until the day the SDK changes
      // its mind is the same silence as the rows above, just further out in time.
      finished([{ text: 'Let me search the incident memory for that.' }, { toolUse: null }]),
      // THE ROW THE JUDGEMENT CALL IS ACTUALLY ABOUT, and the only one on this list whose place is
      // arguable rather than forced. It refuses either way, so moving it here off the quiet list
      // costs a turn's recall receipts and changes nothing the caller sees. A gentler rule that
      // keeps them, gating the throw on `calls.length > 0 || said.join('\n').trim().length > 0`,
      // stays loud on every narration row above and passes this suite whole. That is the point:
      // while this row sat in a comment instead of in this list, NOTHING could tell the two rules
      // apart, and a later round could re-narrow on the same argument without a single test going
      // red. It is here so the position has to be argued with rather than merely edited away.
      finished([{ text: '' }, { toolUse: 'recall' }]),
      // Alone, a kind newer than the SDK is loud for the ordinary reason: nothing was read at all.
      // The pair with the quiet row above is what the `reasoningContent` pair claimed to be.
      finished([{ $unknown: ['futureBlockKind', { detail: 'x' }] }]),
      // A malformed `text` beside a GOOD one, which is the row `[{ text: 7 }]` twelve lines up looks
      // like it covers and does not. That one is loud because NOTHING was read. Here the good
      // sentence holds `recognised` above zero, so until this round the reply came back as an answer
      // built from the blocks that happened to parse, with no sign of the one that did not.
      finished([{ text: 7 }, { text: 'The pool was exhausted.' }]),
      // AND THE NULL `text`, WHICH IS THE `toolUse` NULL ROW TWELVE LINES UP WEARING THE OTHER
      // DECLARED MEMBER'S NAME. The guard says PRESENT AT ALL, and `shaped.text != null` in its place
      // passed all 1518 tests, because no fixture anywhere in this suite carried a null text. The
      // adapter's own comment says the SDK drops a null member so a conforming reply cannot deliver
      // one, and that is exactly the premise this file has now been wrong about twice: it is an
      // argument about the SDK offered in place of a rule about this adapter. The pair is what makes
      // the cost visible rather than the bucket. Alone it changes which sentence an operator reads.
      // Beside a good sentence, the gentler rule does not refuse at all: it returns the narration as
      // a considered answer with the other block gone, which is the silence this whole guard exists
      // to end, and no assertion in this file could see it.
      finished([{ text: null }]),
      finished([{ text: 'Let me search the incident memory for that.' }, { text: null }]),
    ];
    // THE CLASS ALONE WAS THIS FILE'S OWN DEFECT, ONE LAYER OUT. Five different findings throw this
    // one class, so a rule change that moves a row from one of them to another leaves every
    // assertion above green while the operator reads the wrong sentence. Gating the text guard on
    // `recognised > 0` moves `[{ text: 7 }]` off its counter and onto "read none of them", which is
    // a description of a reply that did not happen, and it passed the whole suite. So the bucket is
    // asserted too, by the sentence each one writes, and the totals are asserted as a set so that a
    // row moving from one bucket into another cannot cancel out.
    const buckets: ReadonlyArray<readonly [string, string]> = [
      ['not-an-object', 'not an object'],
      ['no-content-array', 'carried no message content'],
      ['undeclaredToolUse', 'tool call(s) this adapter could not read'],
      ['undeclaredText', 'text block(s) holding something other than a string'],
      ['recognised===0', 'read none of them'],
    ];
    const tally: Record<string, number> = {};
    for (const response of unreadable) {
      expect(() => parseConverseReply(response)).toThrow(ChatUnreadableError);
      expect(() => parseConverseReply(response)).not.toThrow(ChatResponseError);
      let thrown = '';
      try {
        parseConverseReply(response);
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      const matched = buckets.filter(([, phrase]) => thrown.includes(phrase)).map(([name]) => name);
      // NO DEFAULT AND NO SECOND HOME. A default is what made the last count of this table wrong by
      // a factor of three. Two matches would mean the messages stopped being distinguishable, which
      // is this same failure arriving through the prose instead of through the branch.
      expect({ thrown, matched }).toMatchObject({ matched: { length: 1 } });
      for (const name of matched) tally[name] = (tally[name] ?? 0) + 1;
    }
    expect(tally).toEqual({
      'not-an-object': 3,
      'no-content-array': 1,
      undeclaredToolUse: 16,
      undeclaredText: 4,
      'recognised===0': 2,
    });
    expect(unreadable).toHaveLength(26);
  });

  // THE ONE JUDGEMENT CALL ON THAT LIST, GIVEN ITS OWN NAME so it cannot be weakened as a row edit.
  // Every other loud row is forced rather than chosen, though NOT all by the same mechanism, and two
  // versions of this comment have now been wrong about which. The first implied a single mechanism.
  // The second put "about a fifth" on the counters and the rest on "not one block was read", which
  // is that ratio inverted, and it was estimated rather than counted. The third counted it, but with
  // a classifier that DEFAULTED to one bucket, so every row throwing before block counting was filed
  // under `recognised === 0` and that number came out three times too big. Counted again with no
  // default, by the message each row actually throws: of 24 rows, 16 by `undeclaredToolUse`, 2 by
  // `undeclaredText`, 2 by `recognised === 0`, and 4 that never reach block counting at all, being 3
  // refused as not an object and 1 for carrying no content array. A default in a classifier is the
  // same defect as a default in a guard, and this file has now shipped both. That tally is no longer
  // a claim in a comment: the loop above asserts it, so a row changing bucket goes red here rather
  // than making this paragraph quietly wrong for a fourth time.
  // So the large majority are rows that would otherwise hand back a wrong answer
  // or quietly run half of what the model asked for. This one is neither. It refuses either way, so all the
  // error class decides is whether the turn's recall receipts survive, and a gentler rule gating the
  // throw on `calls.length > 0 || said.join('\n').trim().length > 0` would keep them while staying
  // loud on every other row. That rule passed this suite whole for a round, because the only case
  // separating it from the shipped one lived in a comment. Both now go red under it.
  //
  // THE CALL: a `toolUse` key present IS the model asking for a tool, and an adapter that cannot
  // read WHICH tool has stopped matching the API regardless of what else the reply carries. The
  // gentler rule reads the emptiness of the text as evidence about the toolUse, and it is not.
  it('is loud about an unreadable toolUse even when the reply would have refused anyway', () => {
    const refusesEitherWay = finished([{ text: '' }, { toolUse: 'recall' }]);
    expect(() => parseConverseReply(refusesEitherWay)).toThrow(ChatUnreadableError);
    // The DROPPED-CALL sentence specifically, not the `read none of them` fallback, which would be
    // the wrong diagnosis here: the text block was read perfectly well.
    expect(() => parseConverseReply(refusesEitherWay)).toThrow(
      /asked for 1 tool call\(s\) this adapter could not read/,
    );
  });

  // PRESENT HOLDING NOTHING, WHICH IS THE SAME DEFECT AS THE ROW ABOVE ONE MEMBER OVER AND WAS FOUND
  // INSIDE THE FIX FOR IT. The comment said `Absent is the only quiet case` and the line under it
  // read `if (use !== undefined)`, which makes `{ toolUse: undefined }` quiet too. The `text` branch
  // three lines up already used `in` for exactly this reason, so the two declared members of one
  // union answered the same question two different ways in one loop.
  //
  // WHY IT IS PINNED EVEN THOUGH THE SDK WILL NOT SEND IT. `undefined` is not a JSON value and the
  // deserializer never copies an absent member, so no conforming reply reaches this row. That is an
  // argument about the CLIENT and this guard states a rule about the ADAPTER, and reasoning from
  // what the SDK will deliver is what was wrong in rounds nine, eleven and thirteen. A hand-built
  // block, a proxy, a recorded fixture replayed through a different deserializer, or the next SDK
  // version all reach it. The row costs one line and removes the argument.
  it('is loud about a toolUse key present and holding nothing', () => {
    expect(() => parseConverseReply(finished([{ toolUse: undefined }]))).toThrow(
      /asked for 1 tool call\(s\) this adapter could not read/,
    );
    // Beside a good sentence, so `recognised === 0` is not what catches it. Under `!== undefined`
    // this returned the narration as a complete answer with a 200.
    expect(() =>
      parseConverseReply(finished([{ text: 'Let me search the memory.' }, { toolUse: undefined }])),
    ).toThrow(/asked for 1 tool call\(s\) this adapter could not read/);
    // And the control that keeps the rule from becoming "refuse every block": a block with no
    // `toolUse` key at all stays quiet, which is the one case the paragraph above calls quiet.
    expect(parseConverseReply(finished([{ text: 'Let me search the memory.' }]))).toEqual({
      kind: 'answer',
      text: 'Let me search the memory.',
    });
  });

  // ONE BLOCK CARRYING BOTH, WHICH NO FIXTURE IN THIS FILE DID until this round. Every mixed row in
  // the table above is two blocks, one read and one not, and that difference is the whole gap:
  // `ContentBlock` is declared a UNION, so "a block is either a text or a toolUse" reads as
  // obviously true. It is not. The deserializer copies every declared member that is present and
  // enforces no exactly-one rule, which is measured by driving the real client rather than argued
  // from the schema marker. So a counter keyed on "this block was already read as text" skips the
  // call and answers with the narration, and that rule passed all 1506 tests before these lines.
  //
  // The fifth round of one shape: the rule is right, the thing enforcing it is narrower, somewhere
  // new. Here the narrowness was in the fixtures rather than in the code.
  it('reads a block that carries both text and a toolUse', () => {
    const narration = 'Let me search the incident memory for that.';
    // Readable, so the call wins and the narration is dropped, exactly as when the two arrive as
    // separate blocks. This is the positive control: without it the rows below would also pass
    // under a rule that simply refused every block holding two keys.
    expect(
      parseConverseReply(finished([{ text: narration, toolUse: { toolUseId: 'x', name: 'recall', input: {} } }])),
    ).toEqual({ kind: 'tools', calls: [{ id: 'x', name: 'recall', args: {} }] });
    // Unreadable in that same block is the silent drop rather than an answer. A primitive and a
    // renamed field, since those are the two shapes earlier rounds each missed in turn.
    for (const held of [7, { toolUseId: 'x', toolName: 'recall' }]) {
      expect(() => parseConverseReply(finished([{ text: narration, toolUse: held }]))).toThrow(
        ChatUnreadableError,
      );
    }
  });

  // THE SAME HOLE IN `text`, WHICH SIX ROUNDS OF WIDENING `toolUse` WALKED STRAIGHT PAST. Every
  // paragraph in the adapter about a rule being narrower than it reads is about `toolUse`. The
  // `text` branch had no `else` at all, so a block whose `text` was not a string incremented neither
  // counter, and one good sentence beside it held `recognised` above zero. Adding the guard left all
  // 1507 tests green, which is the signature of the whole class: nothing constrained the break and
  // nothing constrained the fix.
  //
  // The middle row is the one that matters, and it is not a refusal. It is an ANSWER WITH A HOLE IN
  // THE MIDDLE OF A SENTENCE served with a 200, which is worse than the cut-off reply this adapter
  // already refuses at the stop-reason check, because a cut-off reply at least stops where a reader
  // can see it stop. The shapes below are measured against the real client rather than invented: a
  // declared string member is copied through with no coercion, so a number, an object and an array
  // all arrive intact, and only `null` is dropped before it gets here.
  it('refuses a text block holding something other than a string, in any position', () => {
    // The positive control, and it is load-bearing: every other assertion here is a throw, so a rule
    // that refused every reply outright would satisfy all of them and this is what catches it.
    expect(parseConverseReply(finished([{ text: 'Cause: ' }, { text: 'the pool.' }]))).toEqual({
      kind: 'answer',
      text: 'Cause: \nthe pool.',
    });
    // The hole in the middle. Before the guard this returned exactly the control's answer, with the
    // broken block silently gone and nothing marking the gap.
    expect(() =>
      parseConverseReply(finished([{ text: 'Cause: ' }, { text: 7 }, { text: ' the pool.' }])),
    ).toThrow(ChatUnreadableError);
    // Each measured shape beside a GOOD sentence, so `recognised === 0` cannot be what catches it.
    // That is the difference between this and the `[{ text: 7 }]` row in the table above, which was
    // loud all along and is why the gap looked covered.
    for (const held of [7, { nested: 'x' }, ['a', 'b']]) {
      expect(() =>
        parseConverseReply(finished([{ text: held }, { text: 'The pool was exhausted.' }])),
      ).toThrow(ChatUnreadableError);
    }
    // Named by the fault that actually happened. Without this the assertions above would also pass
    // if the guard were deleted and something else upstream started refusing, and the operator would
    // be reading about a reply nothing could be read from rather than about one block with a hole.
    expect(() => parseConverseReply(finished([{ text: 7 }, { text: 'The pool was exhausted.' }]))).toThrow(
      /1 text block\(s\) holding something other than a string/,
    );
    // THE ROW THAT PINS THE DECISION RATHER THAN THE RULE, and without it nothing here did. A
    // strictly gentler guard, `undeclaredText > 0 && calls.length === 0`, is loud on every other
    // assertion in this test and passes the entire suite, because narration beside a tool call is
    // discarded anyway so a broken one costs this reply nothing. It was measured green across all
    // 1508 before this line existed. The reason to refuse anyway is that the fault is not about this
    // reply: a `text` arriving in a shape the SDK does not declare will be true of EVERY reply, and
    // the gentler rule keeps the build quiet until the first turn that happens to carry no tool
    // call. That is the same "quiet on all of them" trade the adapter argues against, and this file
    // has now watched a gentler rule pass unnoticed often enough to write the difference down
    // instead of describing it.
    expect(() =>
      parseConverseReply(
        finished([{ text: 7 }, { toolUse: { toolUseId: 'x', name: 'recall', input: {} } }]),
      ),
    ).toThrow(ChatUnreadableError);
    // THE SAME TWO MEMBERS IN ONE BLOCK, which is the crossing this file proved possible one round
    // ago and then never made. `&& shaped.toolUse === undefined` on the text guard is loud on every
    // other assertion here and passed all 1514: the reply comes back as `kind: 'tools'`, the call
    // runs, and the sentence the model said around it is gone with nothing marking the gap. The row
    // above is the same idea in TWO blocks, which is exactly the narrowness round eleven found one
    // member over. A fixture pair that never crosses two rules cannot tell they are independent.
    expect(() =>
      parseConverseReply(finished([{ text: 7, toolUse: { toolUseId: 'x', name: 'recall', input: {} } }])),
    ).toThrow(/1 text block\(s\) holding something other than a string/);
    // TWO OF THEM, SO THE COUNT IS PINNED ABOVE ONE. `undeclaredText = 1` instead of `+= 1` reads
    // identically on every other row here and passes the suite, and it would tell whoever reads the
    // 5xx that one block was broken on a reply where most of the answer was.
    expect(() =>
      parseConverseReply(finished([{ text: 7 }, { text: 'kept' }, { text: { nested: 'x' } }])),
    ).toThrow(/2 text block\(s\) holding something other than a string/);
    // BOTH FAULTS AT ONCE, NAMED BY THE TOOL CALL, because the guards run in an order and the order
    // is a decision nothing was pinning. `&& undeclaredText === 0` on the toolUse guard passes the
    // whole suite, since no row until this one carried both, and it sends an operator to the text
    // that was broken rather than to the tool call that was dropped.
    expect(() => parseConverseReply(finished([{ text: 7 }, { toolUse: 7 }]))).toThrow(
      /1 tool call\(s\) this adapter could not read/,
    );
  });

  // THE LIMIT THAT WAS WRITTEN DOWN FOR TWO ROUNDS INSTEAD OF CLOSED. A tool call can arrive under a
  // block kind the installed SDK has never heard of, and the deserializer files the whole block as
  // `$unknown: [wireKey, value]`, so there is no `toolUse` key for either guard above to find. The
  // adapter used to return the narration beside it as the answer and say so in a comment, on the
  // argument that reading it meant guessing an unfamiliar kind was a tool call FROM ITS NAME. That
  // described evidence the code does not use. The name is never read. What is read is that the held
  // value carries `toolUseId` and `name` as strings, the same structural fact the `toolUse` guard
  // already treats as strong, and the result is a refusal rather than a dispatch, so nothing is
  // executed on the strength of a kind nobody here understands.
  it('refuses a tool call filed under a block kind the SDK cannot name', () => {
    // The positive control FIRST, since every other assertion is a throw. An unknown kind that is
    // NOT shaped like a call stays quiet, which is the whole quiet side of the split: a provider
    // doing something a provider may do, beside an answer that is complete on its own.
    expect(
      parseConverseReply(finished([{ text: 'The pool was exhausted.' }, { $unknown: ['reasoningV2', { steps: 3 }] }])),
    ).toEqual({ kind: 'answer', text: 'The pool was exhausted.' });
    // The failure it closes. Narration beside a call this build cannot see: before this, the answer.
    expect(() =>
      parseConverseReply(
        finished([{ text: 'Let me search the memory.' }, { $unknown: ['toolUseV2', { toolUseId: 'x', name: 'recall' }] }]),
      ),
    ).toThrow(ChatUnreadableError);
    // Named as a dropped CALL, not as an unreadable reply, so the 5xx sends an operator to the right
    // question. `describeBlocks` unwraps the tuple, so the kind name the wire used is in the message.
    expect(() =>
      parseConverseReply(
        finished([{ text: 'Let me search.' }, { $unknown: ['toolUseV2', { toolUseId: 'x', name: 'recall' }] }]),
      ),
    ).toThrow(/1 tool call\(s\) this adapter could not read/);
    // BESIDE A CALL THIS BUILD CAN READ, WHICH IS THE ROW THAT PINS THE RULE AND NOT MERELY THE
    // MECHANISM. Adding `calls.length === 0` to the branch is loud on every other assertion in this
    // test and passed the whole suite, all 1514, before this line existed. The argument for it is
    // that the turn is running tools either way, so a hidden one changes nothing. It changes the
    // thing that matters most: half of what the model asked for runs, the other half is dropped
    // without a word, and the turn reports success. That is the same failure the guard's ordering
    // is written to prevent for a malformed `toolUse` beside a valid one, reached through the one
    // door that guard cannot see. Seventh round running that the rule was right and the thing
    // standing behind it was narrower, somewhere new each time.
    expect(() =>
      parseConverseReply(
        finished([
          { toolUse: { toolUseId: 'a', name: 'recall', input: {} } },
          { $unknown: ['toolUseV2', { toolUseId: 'b', name: 'forget' }] },
        ]),
      ),
    ).toThrow(ChatUnreadableError);
    // A REAL CALL CARRIES `input` TOO, AND EVERY FIXTURE ABOVE HOLDS EXACTLY THE TWO FIELDS THE RULE
    // READS. That uniformity is not a property of real traffic, it is a property of fixtures written
    // by someone thinking about a rule, and it left `&& Object.keys(held).length === 2` loud on every
    // assertion above and green across the whole suite, all 1514, while dropping every call
    // production would ever send: a model asking for a tool sends arguments with it. Eighth round of
    // this file's one shape, and this time it was inside the fix for the seventh.
    expect(() =>
      parseConverseReply(
        finished([
          { text: 'Let me search.' },
          {
            $unknown: [
              'toolUseV2',
              { toolUseId: 'x', name: 'recall', input: { query: 'pool exhaustion' } },
            ],
          },
        ]),
      ),
    ).toThrow(/1 tool call\(s\) this adapter could not read/);
    // ALONE ON THE REPLY. Every row above pairs the block with another one, so `content.length > 1`
    // is loud on all of them and green on the suite, and the reply would still refuse, but through
    // `recognised === 0` and its `read none of them` sentence. That is the wrong diagnosis for a
    // reply that did contain a call, and the message is what an operator acts on.
    expect(() =>
      parseConverseReply(
        finished([{ $unknown: ['toolUseV2', { toolUseId: 'x', name: 'recall', input: {} }] }]),
      ),
    ).toThrow(/1 tool call\(s\) this adapter could not read/);
    // THE NAME IN THE TUPLE IS NOT THE EVIDENCE, which the adapter asserts in three places and until
    // now enforced in none. `String(held[0]).toLowerCase().includes('tool')` passed the entire suite,
    // because every loud fixture happened to use a tool-shaped name and every quiet one did not. Both
    // directions are pinned now: a call-shaped value under a name that says nothing about tools is
    // loud, and a tool-shaped name over a value that is not a call stays quiet.
    expect(() =>
      parseConverseReply(
        finished([
          { text: 'Let me search.' },
          { $unknown: ['citationsContentV2', { toolUseId: 'x', name: 'recall', input: {} }] },
        ]),
      ),
    ).toThrow(/1 tool call\(s\) this adapter could not read/);
    expect(
      parseConverseReply(
        finished([
          { text: 'The pool was exhausted.' },
          { $unknown: ['toolResultV2', { toolUseId: 'x' }] },
        ]),
      ),
    ).toEqual({ kind: 'answer', text: 'The pool was exhausted.' });
    // BOTH FIELDS ARE REQUIRED TO TRIP IT, which is what keeps the rule off conforming traffic. A
    // `toolResult` carries `toolUseId` alone, so a future kind shaped like one must not be loud.
    for (const held of [{ toolUseId: 'x' }, { name: 'recall' }, { toolUseId: 7, name: 'recall' }, 'recall', 42]) {
      expect(
        parseConverseReply(finished([{ text: 'The pool was exhausted.' }, { $unknown: ['someV2', held] }])),
      ).toEqual({ kind: 'answer', text: 'The pool was exhausted.' });
    }
  });

  // A NAME THE WIRE CHOSE CANNOT RESHAPE THE LINE IT LANDS IN. The kind name inside the tuple goes
  // into the operator's sentence verbatim, and a name is not a word: it is whatever bytes the body
  // carried. A newline in one splits the finding across two lines, so half of it reads as a separate
  // record and whoever is reading loses which reply the rest belonged to, which is worth more to
  // somebody forging a log than the fault itself is worth to them. Escaped rather than stripped,
  // because a key differing from a declared member only by an invisible character is the exact thing
  // being diagnosed, and stripping would render it identical to the member it is impersonating.
  it('escapes a wire-chosen name instead of letting it break the operator line', () => {
    const messageFor = messageForBlocks;
    // THE TUPLE KEY, which is the path a union takes.
    const tuple = messageFor([
      {
        $unknown: [
          'toolUseV2\nstopReason: end_turn',
          { toolUseId: 'x', name: 'recall', input: {} },
        ],
      },
    ]);
    expect(tuple).toMatch(/1 tool call\(s\) this adapter could not read/);
    expect(tuple).not.toContain('\n');
    expect(tuple).toContain('toolUseV2\\x{0a}stopReason');
    // A KEY INSIDE THE VALUE, which is the wider of the two paths and the one the adapter's own
    // security note denied existed for two versions running. `ToolUseBlock` is declared a STRUCT
    // rather than a union, so the deserializer's `__type` fallback copies unrecognised wire keys
    // straight onto it and `describeHeld` prints them one level down. Sanitising only the tuple key
    // would have left this open while reading as covered, which is the same defect one layer out.
    const inner = messageFor([{ toolUse: { 'toolUseId\nstopReason: end_turn': 'x' } }]);
    expect(inner).toMatch(/1 tool call\(s\) this adapter could not read/);
    expect(inner).not.toContain('\n');
    expect(inner).toContain('toolUseId\\x{0a}stopReason');
    // AND LENGTH, for the reason values are never printed at all. A name is as long as the body says
    // it is, so a line whose length the wire decides is a line the wire can bury.
    const long = messageFor([
      { $unknown: ['v'.repeat(200), { toolUseId: 'x', name: 'recall', input: {} }] },
    ]);
    expect(long).toContain(`${'v'.repeat(60)}\\...`);
    expect(long).not.toContain('v'.repeat(61));
    // AND THE CLASS ITSELF, MEMBER BY MEMBER, because it was held by ONE character. Both
    // `/[\p{Cc}]/gu` and the single newline `/[\n]/gu` passed every assertion above: the comment
    // argued for everything that can reshape a rendered line, and one newline was all that had to
    // hold. Each of these does something different, which is why the argument was never about
    // newlines. A carriage return overwrites the line already written. ESC opens a live control
    // sequence in any terminal reading the log. U+202E reverses the reading order of everything
    // after it without altering a byte, which is the newline problem with its seams hidden. The
    // separators end the line in most viewers and in every JS string context, and they were OUTSIDE
    // the first version of this class while the comment claimed to cover exactly this.
    //
    // Written as code points rather than as escape sequences on purpose: typing them as `\u` escapes
    // is what put the characters THEMSELVES into the adapter, a NUL byte among them.
    //
    // The last row is a LONE SURROGATE, which is not a character at all: it is half of one, and it
    // passed through raw because the class named the four categories a reader would think of and
    // stopped there. A log written as UTF-8 turns every distinct lone surrogate into the same
    // replacement character, so two different names print alike, which is the impersonation this
    // whole function exists to expose, and the record stops being well-formed UTF-8 on the way.
    // `String.fromCodePoint` builds one directly; `for...of` never splits a well-formed PAIR, so
    // ordinary astral text is untouched by this row and by the class it pins.
    const reshapers: ReadonlyArray<readonly [number, string]> = [
      [0x00, 'x{00}'],
      [0x0d, 'x{0d}'],
      [0x1b, 'x{1b}'],
      [0x202e, 'x{202e}'],
      [0x2028, 'x{2028}'],
      [0x2029, 'x{2029}'],
      [0xd800, 'x{d800}'],
    ];
    for (const [point, escaped] of reshapers) {
      const character = String.fromCodePoint(point);
      const message = messageFor([{ toolUse: { [`toolUseId${character}after`]: 'x' } }]);
      expect(message).toContain(`toolUseId\\${escaped}after`);
      expect(message).not.toContain(character);
    }
    // AND THE WHOLE CODE POINT, NOT ITS FIRST HALF. `charCodeAt` reports the high surrogate, so every
    // character in the TAG block printed as the same `\xdb40`. That block is the standard carrier for
    // invisible text, so these two names are precisely the impersonation this escaping exists to
    // expose, and the version that shipped rendered them identically while reading as covered.
    const tagged = (point: number): string =>
      messageFor([{ toolUse: { [`toolUseId${String.fromCodePoint(point)}`]: 'x' } }]);
    expect(tagged(0xe0041)).toContain('toolUseId\\x{e0041}');
    expect(tagged(0xe0042)).toContain('toolUseId\\x{e0042}');
    // AND THE ANTI-COLLISION PROPERTY WITH A PAIR THAT COULD ACTUALLY COLLIDE, which the two rows
    // above cannot. `\xe0041` against `\xe0042` differs in the last digit under every encoding this
    // function has ever had, including the broken one, so asserting they differ proved nothing and
    // read as the whole property. A variable-width escape with no delimiter is not injective, and
    // this is the pair that shows it: an ESC followed by the literal text "ca0" and the single
    // character U+1BCA0 both rendered `\x1bca0`. Two different names, one line, and the operator
    // reading it has no way to tell which arrived. Delimiters fix that, and then the delimiter's own
    // character has to be escaped too, or a name carrying the literal text `\x{1b}` collides with a
    // real ESC by writing the escape itself. Both directions are pinned, because the second only
    // became reachable once the first was fixed.
    const escaped = (name: string): string => messageFor([{ toolUse: { [name]: 'x' } }]);
    const esc = String.fromCodePoint(0x1b);
    expect(escaped(`${esc}ca0`)).not.toEqual(escaped(String.fromCodePoint(0x1bca0)));
    expect(escaped('\\x{1b}')).not.toEqual(escaped(esc));
    expect(escaped(String.fromCodePoint(0x1bca0))).toContain('\\x{1bca0}');
    // AND THE CAP COUNTS WHOLE UNITS. Slicing the escaped string can leave a trailing `\x{202`, a
    // code that does not exist and an operator looking it up finds nothing, concluding the tool is
    // broken rather than the reply. Capping the RAW name instead would let a control-heavy name print
    // at up to NINE times the budget, which is what a TAG character now costs: four for the
    // delimiters, five for the digits. Neither: the loop stops before the unit that would cross the
    // line. Seven whole escapes of eight characters each is 56, the eighth would reach 64, so the
    // mark lands at 56 and eight does not divide sixty, which is the arithmetic the first version of
    // this row lacked. It used six-character escapes, six divides sixty, and a slice and a whole-unit
    // loop agree exactly there, so the assertion read as proof while proving nothing.
    const bidi = String.fromCodePoint(0x202e);
    const escapeHeavy = messageFor([{ toolUse: { [bidi.repeat(40)]: 'x' } }]);
    expect(escapeHeavy).toContain(`${'\\x{202e}'.repeat(7)}\\...`);
    expect(escapeHeavy).not.toContain('\\x{202e}'.repeat(8));
    expect(everyEscapeIsWhole(escapeHeavy)).toBe(true);
    // One ordinary character in front moves the boundary to a different place inside the eighth
    // escape, so the two rows do not share an arithmetic accident either.
    const offBoundary = messageFor([{ toolUse: { [`a${bidi.repeat(40)}`]: 'x' } }]);
    expect(offBoundary).toContain(`a${'\\x{202e}'.repeat(7)}\\...`);
    expect(everyEscapeIsWhole(offBoundary)).toBe(true);
    // AND THE HELPER ITSELF HAS TO REFUSE SOMETHING, or a check that returns true for everything
    // reads as coverage across four call sites. A lone backslash mid-line is what a cut escape
    // leaves, and the first version accepted it because it only looked where `\x{` already appeared.
    //
    // The row that used to sit here was `a\...`, which this helper now ACCEPTS and should: the
    // truncation marker moved behind the backslash this round, so `\...` is a member of the alphabet
    // rather than a cut. Keeping it as a refusal would have pinned the OLD alphabet, which is how a
    // stale assertion outlives the rule it was written for. These four are the shapes that stay
    // outside the alphabet however it grows: a backslash introducing a letter it never introduces, a
    // trailing one with nothing after it, an unclosed code escape, and the marker one dot short,
    // which is the nearest miss and the one a lookahead rule waves through.
    expect(everyEscapeIsWhole('Blocks were: toolUse:{a\\z} and nothing else.')).toBe(false);
    expect(everyEscapeIsWhole('Blocks were: toolUse:{a\\')).toBe(false);
    expect(everyEscapeIsWhole('Blocks were: toolUse:{a\\x{202')).toBe(false);
    expect(everyEscapeIsWhole('Blocks were: toolUse:{a\\..}')).toBe(false);
    // And the marker itself is whole, which is the row the one above replaced.
    expect(everyEscapeIsWhole('Blocks were: toolUse:{a\\...}')).toBe(true);
    // And it has to ACCEPT the whole alphabet, including a doubled backslash mid-line, which is the
    // correct rendering of a wire name of `\a` and which a lookahead rule rejects.
    expect(everyEscapeIsWhole(messageFor([{ toolUse: { '\\a': 'x' } }]))).toBe(true);
    expect(everyEscapeIsWhole(messageFor([{ toolUse: { '': 7 } }]))).toBe(true);
    // AND THE EMPTY NAME, which a wire body really can carry and which rendered as nothing at all:
    // `Blocks were: toolUse:{:number}` reads as a rendering fault rather than as the finding, and an
    // operator cannot tell it from a key that failed to print. Marked with the one character no name
    // can produce for itself, since a literal backslash off the wire is doubled.
    expect(messageFor([{ toolUse: { '': 7 } }])).toContain('toolUse:{\\empty:number}');
    expect(escaped('\\empty')).not.toEqual(escaped(''));
  });

  // THE LINE HAS A LENGTH OF ITS OWN, AND THE COMMENT SAID IT DID NOT. "Nothing the wire controls
  // decides how much of this line it gets" was false while the per-name cap sat directly above it:
  // the cap bounds one NAME, and a reply carries as many blocks as the body says. A thousand of the
  // SHORTEST unreadable block there is, rendering as `toolUse:{}`, wrote a 12,537-character record
  // with every individual name well inside its 60, and richer blocks write several times that.
  // Measured rather than reasoned about, with the cap lifted. Worse than the long name, in fact,
  // because a log line that size is usually cut by something downstream that says nothing about
  // having cut it, so the finding disappears and looks delivered.
  it('caps the whole block listing on whole blocks, at a budget this pins exactly', () => {
    const shortest = messageForBlocks(Array.from({ length: 1000 }, () => ({ toolUse: {} })));
    expect(shortest).toMatch(/1000 tool call\(s\) this adapter could not read/);
    // BOTH counts survive, not just the total. How many arrived is what an operator acts on, and how
    // many of them they are actually looking at is what stops them reading a cut list as the whole
    // of it. The first version said only "cut here; 1000 block(s) in all".
    expect(shortest).toContain('\\... (66 of 1000 shown)');
    expect(shortest.length).toBeLessThan(1500);

    // THE CUT TAKES WHOLE BLOCKS, AND THE FIRST FIX FOR THIS SLICED. Nothing above can see that,
    // because `toolUse:{}` holds no escape to cut. These blocks do: the listing runs 781 characters
    // in 29 whole entries, and a slice at 800 would take 19 more, landing inside the thirtieth on
    // `\x{202e` with the closing brace gone. That is not merely unreadable. Under the ENCODING THIS
    // REPLACED, the same cut left `\x20`, a valid escape meaning SPACE, where the wire had sent a
    // right-to-left override, so the wire chose what the truncation said. Measured, not argued.
    const bidi = String.fromCodePoint(0x202e);
    const escapeHeavy = messageForBlocks(
      Array.from({ length: 1000 }, () => ({ toolUse: { [bidi]: 7 } })),
    );
    expect(escapeHeavy).toContain('\\... (29 of 1000 shown)');
    expect(everyEscapeIsWhole(escapeHeavy)).toBe(true);
    expect(escapeHeavy).not.toContain(bidi);

    // AND THE BUDGET ITSELF, WHICH THE FIRST VERSION LEFT LOOSE ENOUGH TO BE MEANINGLESS: a cap
    // anywhere from 801 to 924 passed it, so the number in the source was decoration. Two shapes
    // whose boundaries land on opposite sides of one value close that. Blocks rendering `undefined`
    // are 9 characters and the separator is 2, so k of them measure 11k-2 and 72 fit in 800 while 73
    // need 801: showing 72 proves the budget is at MOST 800. One 8-character block in front shifts
    // every boundary by one, so 73 entries measure exactly 800: showing 73 proves it is at LEAST
    // 800. Together they name it. A test that cannot tell 800 from 924 is not pinning a budget.
    const uniform = messageForBlocks(Array.from({ length: 1000 }, () => undefined));
    expect(uniform).toContain('\\... (72 of 1000 shown)');
    const shifted = messageForBlocks([
      { a: 7 },
      ...Array.from({ length: 999 }, () => undefined),
    ]);
    expect(shifted).toContain('\\... (73 of 1000 shown)');

    // AND EVERY LEVEL INSIDE ONE BLOCK, WHICH IS THE HOLE THIS CAP OPENS IF IT IS THE ONLY ONE.
    // `joinWithinBudget` stops BEFORE the item that would cross the line, so a single block wider
    // than the whole listing is allowed to be leaves the outer join with nothing it can show and the
    // line reads `(0 of 1 shown)`: a count with nothing counted, which is worse than the long line it
    // replaced, because the operator now has no name at all. One reply carrying one fat block is not
    // exotic. So each level has a budget smaller than the one holding it, and these two rows are what
    // make that ordering a rule rather than three numbers that happen to be in order today.
    const keyed = (count: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: count }, (_unused, at) => [`k${at}`, at]));
    // AND THE COUNT, NOT A DIGIT SEQUENCE. These two rows used `(\d+ of 200 shown)`, which pins the
    // ordering they were written for and NOTHING about the two budgets: measured, every value from 9
    // to roughly 390 produced a passing line for the inner one and 9 to roughly 800 for the entry
    // one. That is the same complaint that produced this whole shape, at the two sites the fix for it
    // did not sweep, in the commit that made the sweep. Naming the count leaves an eleven-wide band,
    // since a listing cannot be made to end exactly on a budget, so the constants are named too.
    const wideBlock = messageForBlocks([keyed(200)]);
    expect(wideBlock).toContain('k0:number');
    expect(wideBlock).not.toContain('(0 of 1 shown)');
    expect(wideBlock).toMatch(/\+\\\.\.\. \(37 of 200 shown\)/);
    expect(BLOCK_ENTRY_BUDGET).toBe(400);
    const deepBlock = messageForBlocks([{ toolUse: keyed(200) }]);
    expect(deepBlock).toContain('toolUse:{k0:number');
    expect(deepBlock).not.toContain('(0 of 1 shown)');
    expect(deepBlock).toMatch(/\+\\\.\.\. \(19 of 200 shown\)/);
    expect(INNER_KEY_BUDGET).toBe(200);
    // The ordering the two rows above exist for, stated as the inequality rather than left implicit
    // in three numbers that happen to be in order today.
    expect(INNER_KEY_BUDGET).toBeLessThan(BLOCK_ENTRY_BUDGET);
  });

  // AND THE EARLIER SINK, WHICH EVERY ROUND OF THIS WALKED PAST. Before a single block is read, a
  // response with no `output.message.content` array names its TOP LEVEL keys, and those came off the
  // wire exactly as the block keys did. It was raw and uncapped while the block describer four
  // hundred lines down escaped everything, which is what one rule believed everywhere looks like from
  // the inside. It is also the CHEAPER of the two to reach: no blocks required, just a body.
  it('escapes and bounds the top level key list, which is the sink reached first', () => {
    const messageFor = (response: unknown): string => {
      try {
        parseConverseReply(response);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return '';
    };
    const newline = String.fromCodePoint(0x0a);
    const forged = messageFor({ [`trace${newline}Blocks were: text:string`]: {} });
    expect(forged).toContain('carried no message content');
    expect(forged).toContain('trace\\x{0a}Blocks were: text:string');
    expect(forged).not.toContain(newline);
    const long = messageFor({ ['k'.repeat(200)]: {} });
    expect(long).toContain(`${'k'.repeat(60)}\\...`);
    expect(long).not.toContain('k'.repeat(61));
    const many = messageFor(
      Object.fromEntries(Array.from({ length: 400 }, (_unused, at) => [`key${at}`, at])),
    );
    // MEASURED, NOT BRACKETED. `(\d+ of 400 shown)` with a `< 1200` beside it looks like two
    // assertions about the budget and is none: run against the real module, every value from 1 to
    // 3087 satisfies the regex, so the 800 in the source was decoration here exactly as it was in the
    // embedder's identical row. The same 400 keys through the same budget give the same 114 in both
    // files, which is the point of the shared module and is now asserted rather than assumed.
    expect(many).toContain('\\... (114 of 400 shown)');
    const lead = 'Top level keys were: ';
    const keyList = many.slice(many.indexOf(lead) + lead.length, many.indexOf(', \\...'));
    expect(keyList.length).toBeLessThanOrEqual(TOP_LEVEL_KEY_BUDGET);
    expect(keyList.length).toBeGreaterThan(TOP_LEVEL_KEY_BUDGET - 8);
    expect(keyList.endsWith('key113')).toBe(true);
    expect(many.length).toBeLessThan(1200);
    expect(everyEscapeIsWhole(many)).toBe(true);
  });

  // THE STOP REASON IS A WIRE STRING TOO, and it is the easiest of them to miss, because the check
  // guarding it rejects everything OUTSIDE a known set. That reads as a closed set and is the exact
  // opposite of one: the only values that ever reach this message are the ones nobody vetted.
  // Reachability measured rather than argued, by driving the real client with a canned body: a
  // 5,000-character stopReason carrying a newline arrives intact and was printed raw and uncapped.
  it('escapes and caps the stop reason, which is also a name the wire chose', () => {
    let message = '';
    try {
      parseConverseReply({
        output: { message: { content: [{ text: 'The pool was exhausted.' }] } },
        stopReason: `mystery${String.fromCodePoint(0x0a)}stopReason: end_turn${'z'.repeat(200)}`,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/The model stopped for the reason/);
    expect(message).toContain('mystery\\x{0a}stopReason');
    expect(message).not.toContain(String.fromCodePoint(0x0a));
    expect(message).not.toContain('z'.repeat(61));
  });

  // THE BOUNDARY AS PAIRS RATHER THAN AS A SENTENCE. One field apart each time. Described in prose
  // for three rounds and implemented three different ways, so it is pinned by the smallest possible
  // difference instead - and on BOTH declared fields, because a table that only ever varied one of
  // them is how a rule checking neither of them passed.
  it('separates a toolUse it can call from one the SDK does not declare, by one field', () => {
    expect(parseConverseReply(finished([{ toolUse: { toolUseId: 'x', name: 'recall', input: {} } }]))).toEqual({
      kind: 'tools',
      calls: [{ id: 'x', name: 'recall', args: {} }],
    });
    // The name removed, nothing else.
    expect(() => parseConverseReply(finished([{ toolUse: { toolUseId: 'x', input: {} } }]))).toThrow(
      ChatUnreadableError,
    );
    // The name RENAMED, nothing else. Indistinguishable from the row above to any rule that asks
    // only whether something is an object, which is what made this silent for a round.
    expect(() =>
      parseConverseReply(finished([{ toolUse: { toolUseId: 'x', toolName: 'recall', input: {} } }])),
    ).toThrow(ChatUnreadableError);
    // The id mistyped, nothing else.
    expect(() =>
      parseConverseReply(finished([{ toolUse: { toolUseId: 7, name: 'recall', input: {} } }])),
    ).toThrow(ChatUnreadableError);
  });

  // The operator gets the block shapes, not just the count, because the whole point of being loud
  // here is that somebody can see WHICH new block type this build stopped reading.
  it('names the block kinds it did not recognise', () => {
    expect(() =>
      parseConverseReply(finished([{ reasoningContent: { reasoningText: {} } }, { citation: {}, meta: {} }])),
    ).toThrow(/reasoningContent:\{reasoningText:object\}, citation:\{\}\+meta:\{\}/);
    // THE CASE THIS TEST LOOKED LIKE IT COVERED AND DID NOT. Both rows above are kinds the SDK
    // KNOWS and only this adapter ignores, so they arrive under their own names. A kind written
    // AFTER the installed SDK never does: the union deserializer files it as
    // `$unknown: [wireKey, value]`, measured by driving the real client rather than assumed, and
    // `describeHeld` collapsed that tuple to the word `array`. So the one sentence written for
    // "somebody can see WHICH new block type this build stopped reading" read `$unknown:array`
    // and named nothing. The kind is unwrapped now, and the value is still only ever described.
    expect(() => parseConverseReply(finished([{ $unknown: ['futureBlockKind', { detail: 'x' }] }]))).toThrow(
      /\$unknown:futureBlockKind:\{detail:string\}/,
    );
  });

  // ONE LEVEL IN, BECAUSE THAT IS THE LEVEL THE RULE CHECKS. Naming keys alone said "Blocks were:
  // toolUse" about a block whose toolUse was the whole problem. Naming the type alone says
  // "toolUse:object", which is exactly as useless once the decision is made on the fields INSIDE it.
  //
  // WHAT THE OPERATOR SEES IS THE FIELD THAT WENT MISSING, NOT THE ONE THAT REPLACED IT, and this
  // comment claimed the second for a round. `toolName` below cannot reach the adapter through the
  // real SDK. `ToolUseBlock` is a struct schema declaring toolUseId, name, input and type, the
  // deserializer walks only declared members, and the fallback that copies unknown wire keys through
  // needs a string `__type`. That mechanism is read from the SDK source and confirmed by driving the
  // real client. WHETHER A CONVERSE SUCCESS REPLY EVER CARRIES `__type` IS AWS SERVER BEHAVIOUR AND
  // IS NOT CHECKABLE FROM THIS REPO, so it is flagged here as the one unverified premise rather than
  // asserted: if `__type` were present, `toolName` DOES pass through and the paragraph inverts. So
  // on everything that can be checked from here, an AWS-side rename arrives
  // as `{ toolUseId: 'x', input: {} }` and renders as `toolUse:{toolUseId:string+input:object}`, and
  // what names the fault for the operator is `name` being gone rather than `toolName` being there.
  // The fixture keeps the synthetic shape because it pins the RENDERING of an inner key this build
  // does not know, which the realistic shape at the row above cannot pin. The rule fires on both.
  //
  // NEITHER ASSERTION BELOW IS A REGRESSION GUARD FOR THE RULE, and that is said out loud so nobody
  // counts it as one. Both fixtures satisfy the `recognised === 0` fallback as well, and both throws
  // render `describeBlocks` identically, so this test survives a revert of the dropped-call guard
  // without going red. What it pins is the RENDERING. The guard is held up by the mixed rows in the
  // sort table above, which are the ones that fail when it is removed.
  it('names the field inside a toolUse it could not read', () => {
    expect(() =>
      parseConverseReply(finished([{ toolUse: { toolUseId: 'x', toolName: 'recall' } }])),
    ).toThrow(/toolUse:\{toolUseId:string\+toolName:string\}/);
    // A HAND-WRITTEN SHAPE THE REAL CLIENT CANNOT DELIVER, said out loud so nobody reads it as
    // production behaviour: a wire array under `toolUse` is normalised to `{}` on the way in and
    // renders as `toolUse:{}`. What this row pins is the renderer, on the one input that reaches
    // its array branch. The rule fires on both shapes either way.
    expect(() => parseConverseReply(finished([{ toolUse: [] }]))).toThrow(/toolUse:array/);
  });

  // TWO DIFFERENT FAILURES NEED TWO DIFFERENT SENTENCES, and this is the one that did not exist.
  // "This adapter read none of them" is false here and points an operator at a whole-adapter rewrite
  // when the truth is that one field was renamed and the rest of the reply parsed perfectly.
  it('says a tool call was dropped, rather than that it read nothing, when a block did get through', () => {
    const narrated = finished([
      { text: 'Let me search the incident memory for that.' },
      { toolUse: { toolUseId: 'x', toolName: 'recall', input: {} } },
    ]);
    expect(() => parseConverseReply(narrated)).toThrow(
      /asked for 1 tool call\(s\) this adapter could not read/,
    );
    expect(() => parseConverseReply(narrated)).toThrow(
      /toolUse:\{toolUseId:string\+toolName:string\+input:object\}/,
    );
    expect(() => parseConverseReply(narrated)).not.toThrow(/read none of them/);
  });

  // A block with no keys rendered as the empty string, so the sentence came out as "Blocks were: ,
  // named by key" and read as a broken template rather than as the finding it was. An array block
  // did the same when empty, and named itself by index when not, while `describeHeld` one level down
  // called the identical value `array` - so one sentence could name the same shape two ways.
  it('renders a degenerate block instead of leaving a blank stretch mid-sentence', () => {
    expect(() => parseConverseReply(finished([{}]))).toThrow(/Blocks were: \{\}/);
    expect(() => parseConverseReply(finished([[]]))).toThrow(/Blocks were: array/);
    expect(() => parseConverseReply(finished([['a', 'b']]))).toThrow(/Blocks were: array/);
  });

  // THE TYPE IS HALF THE DIAGNOSIS AND IT USED TO BE MISSING. Naming keys alone produced "Blocks
  // were: text. Expected each to carry text or toolUse", which names the kind it received as the
  // kind it wanted and sends the operator hunting an API change that has not happened. Under a key
  // this adapter knows, what went wrong is the type, so the type is what the message has to carry.
  it('names the type under a key it knows, rather than asking for the key it already got', () => {
    expect(() => parseConverseReply(finished([{ text: 7 }]))).toThrow(/text:number/);
    expect(() => parseConverseReply(finished([{ text: 7 }]))).not.toThrow(/Expected each to carry text/);
  });

  it('names the keys it actually saw when the body is not the shape it expects', () => {
    expect(() => parseConverseReply({ trace: {}, metrics: {} })).toThrow(/trace, metrics/);
  });

  it('refuses a body that is not an object at all', () => {
    expect(() => parseConverseReply(null)).toThrow(/was null, not an object/);
    expect(() => parseConverseReply('a string')).toThrow(/was string, not an object/);
  });
});

/**
 * THE ONLY TESTS HERE THAT RUN THE REAL DESERIALIZER, and they exist because most of what the
 * adapter argues rests on sentences beginning "the SDK delivers". Every one of those was established
 * by a throwaway probe that was then deleted, so this suite carried the CONCLUSIONS while nothing
 * carried the EVIDENCE. That is a specific kind of blind: every other fixture in this file
 * HAND-BUILDS the shape it claims the SDK produces, so an SDK bump that started enforcing
 * exactly-one on the union, or that coerced a member arriving in the wrong shape, would leave all
 * fifteen hundred of them green while production changed underneath. These drive a real
 * `BedrockRuntimeClient` over a canned wire body, so the premises go red instead of the conclusions
 * going quietly wrong.
 *
 * No network and no credentials: the request handler is replaced, so the body below is deserialised
 * by the installed SDK and nothing leaves the process.
 */
describe('the SDK contract the adapter rules rest on', () => {
  async function blocksFromWire(content: unknown): Promise<Record<string, unknown>[]> {
    const body = { output: { message: { role: 'assistant', content } }, stopReason: 'end_turn' };
    const client = new BedrockRuntimeClient({
      region: 'eu-central-1',
      credentials: { accessKeyId: 'not-used', secretAccessKey: 'not-used' },
      requestHandler: {
        handle: () =>
          Promise.resolve({
            response: {
              statusCode: 200,
              headers: { 'content-type': 'application/json' },
              body: new TextEncoder().encode(JSON.stringify(body)),
            },
          }),
      },
    } as unknown as NonNullable<ConstructorParameters<typeof BedrockRuntimeClient>[0]>);
    const reply = await client.send(new ConverseCommand({ modelId: 'm', messages: [] }));
    return (reply.output as { message?: { content?: Record<string, unknown>[] } } | undefined)?.message?.content ?? [];
  }

  // The premise the whole `undeclaredToolUse` design rests on, and the one that reads as obviously
  // false: `ContentBlock` is declared a UNION, so "a block is either a text or a toolUse" looks like
  // a guarantee. It is not one. The deserializer copies every declared member that is present and
  // enforces nothing about how many there are.
  it('copies every declared member present, so one block can carry text AND toolUse', async () => {
    const blocks = await blocksFromWire([{ text: 'narration', toolUse: 7 }]);
    expect(blocks).toHaveLength(1);
    expect(Object.keys(blocks[0] ?? {}).sort()).toEqual(['text', 'toolUse']);
    expect(blocks[0]?.toolUse).toBe(7);
  });

  // Why the guards test PRESENCE and not type. A member arriving in a shape the schema does not
  // declare is handed through untouched rather than coerced or dropped, so it reaches the adapter
  // and something there has to have an opinion about it.
  it('does not coerce a declared member that arrives in the wrong shape', async () => {
    expect((await blocksFromWire([{ text: 7 }]))[0]?.text).toBe(7);
    expect((await blocksFromWire([{ toolUse: 'recall' }]))[0]?.toolUse).toBe('recall');
    expect((await blocksFromWire([{ text: { nested: 'x' } }]))[0]?.text).toEqual({ nested: 'x' });
  });

  // And why testing presence is SAFE. If a null member were copied, every ordinary text block would
  // carry a null `toolUse` and presence would turn the entire product loud. It is not copied.
  it('drops a null member instead of copying it', async () => {
    // Asserted as the WHOLE block rather than as `'toolUse' in block`, because that phrasing is also
    // true of the empty object this helper returns if deserialising ever stops producing anything,
    // and a premise test that passes when the mechanism is gone is worse than no test.
    expect(await blocksFromWire([{ text: 'hi', toolUse: null }])).toEqual([{ text: 'hi' }]);
  });

  // The case the loud path was written for. A kind newer than the installed SDK never arrives under
  // its own name, and the name survives only inside this tuple, which is why `describeBlocks`
  // unwraps it and why a call can hide in a block with no `toolUse` key at all.
  it('files a kind newer than itself under $unknown, wire key intact', async () => {
    const blocks = await blocksFromWire([{ toolUseV2: { toolUseId: 'x', name: 'recall' } }]);
    expect(blocks[0]?.$unknown).toEqual(['toolUseV2', { toolUseId: 'x', name: 'recall' }]);
  });

  // Both halves of the condition that decides whether a name survives at all. Neither of these can
  // be improved by anything in the adapter, which is the point of pinning them.
  //
  // AND THIS IS WHERE THE LOUD PATH ENDS, stated here because the adapter spent two versions saying
  // the opposite by implication. The second row is the same condition that keeps the `$unknown` rule
  // off conforming traffic, read from the other side: a kind newer than the SDK sharing a block with
  // a declared member is discarded before the adapter runs. So the rule covers the standalone case
  // and only that, and the third row is what the gap actually costs rather than an abstract `aV2`.
  // Nothing in the adapter can close it, because the evidence never arrives. Pinned so that an SDK
  // which starts keeping those keys goes red here instead of quietly widening what the rule covers.
  it('keeps no name when the block is not exactly one unrecognised key', async () => {
    expect(await blocksFromWire([{ aV2: 1, bV2: 2 }])).toEqual([{}]);
    expect(await blocksFromWire([{ text: 'hi', aV2: 1 }])).toEqual([{ text: 'hi' }]);
    expect(
      await blocksFromWire([{ text: 'narration', toolUseV2: { toolUseId: 'x', name: 'recall' } }]),
    ).toEqual([{ text: 'narration' }]);
  });
});

describe('createBedrockChatModel', () => {
  it('identifies the model so an answer can be traced to what produced it', () => {
    expect(createBedrockChatModel({ ...OPTIONS, client: converseWith([]) }).id).toBe(
      'bedrock:eu.anthropic.claude-haiku-4-5-20251001-v1:0',
    );
  });

  it('builds its client for the region it was given', () => {
    const seen: string[] = [];
    createBedrockChatModel({
      ...OPTIONS,
      createClient: (region) => {
        seen.push(region);
        return converseWith([]);
      },
    });
    expect(seen).toEqual(['eu-central-1']);
  });

  it('sends the system prompt, the transcript, the tools and the inference settings', async () => {
    const capture: { command?: unknown } = {};
    const model = createBedrockChatModel({ ...OPTIONS, client: converseWith([{ text: 'ok' }], capture) });
    await model.reply({ system: SYSTEM_PROMPT, history: FULL_TRANSCRIPT, tools: TOOLS });

    const input = inputOf(capture);
    expect(input.modelId).toBe(OPTIONS.modelId);
    expect(input.system).toEqual([{ text: SYSTEM_PROMPT }]);
    expect(input.messages).toEqual(toConverseMessages(FULL_TRANSCRIPT));
    expect(input.toolConfig.tools).toHaveLength(TOOLS.length);
    expect(input.inferenceConfig.temperature).toBe(0);
    expect(input.inferenceConfig.maxTokens).toBe(2048);
  });

  // The other half of the AGENT_MAX_TOKENS chain. `loadChatConfig` is what turns the variable into
  // this option, and this is what turns the option into the request: without both, the adapter's
  // own advice to raise the ceiling sends the operator to a setting that changes nothing.
  it('sends the ceiling it was configured with rather than the default', async () => {
    const capture: Capture = {};
    const model = createBedrockChatModel({
      ...OPTIONS,
      client: converseWith([{ text: 'ok' }], capture),
      maxTokens: 512,
    });
    await model.reply({ system: 's', history: [], tools: TOOLS });
    expect(inputOf(capture).inferenceConfig.maxTokens).toBe(512);
  });

  // WHERE THE COMMAND IS BUILT IS THE ASSERTION HERE. Every line of it is our own code, so a throw
  // out of `toToolConfig` is a bug in this repository. Move the constructor inside the try below
  // and the same throw comes back as a ChatProviderError: the operator's log then records an
  // outage at Bedrock, under the provider error name "Error", for a call Bedrock never received,
  // and the actual sentence naming the offending field is buried on a cause nobody reads. A schema
  // `z.toJSONSchema` refuses is the realistic way this happens, because the description the model
  // is shown is DERIVED from the validator rather than written beside it.
  it('reports a schema this repository cannot describe as our own bug, not as a provider outage', async () => {
    const capture: Capture = {};
    const undescribable: ToolDefinition = {
      name: 'recall',
      writes: false,
      description: 'Its arguments cannot be expressed in JSON Schema, so describing it must fail.',
      schema: z.object({ query: z.bigint() }),
    };
    const model = createBedrockChatModel({ ...OPTIONS, client: converseWith([{ text: 'ok' }], capture) });

    const error = await model
      .reply({ system: 's', history: [], tools: [undescribable] })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChatProviderError);
    expect((error as Error).message).toMatch(/JSON Schema/);
    // Nothing was sent, which is exactly why blaming the provider would be wrong.
    expect(capture.command).toBeUndefined();
  });

  // The abort is what stops work nobody is waiting for any more. Without it a timed-out call keeps
  // running at AWS and keeps being billed, and the race would still make every timeout test pass.
  it('hands the client an abort signal, so a call it gave up on can actually be stopped', async () => {
    const capture: Capture = {};
    const model = createBedrockChatModel({ ...OPTIONS, client: converseWith([{ text: 'ok' }], capture) });
    await model.reply({ system: 's', history: [], tools: TOOLS });
    expect(capture.options?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(capture.options?.abortSignal?.aborted).toBe(false);
  });

  it('aborts that signal when the budget runs out', async () => {
    let seen: AbortSignal | undefined;
    const never: ConverseCapableClient = {
      send: (_command, options) => {
        seen = options?.abortSignal;
        return new Promise(() => {});
      },
    };
    const model = createBedrockChatModel({ ...OPTIONS, client: never, timeoutMs: 5 });
    await expect(model.reply({ system: 's', history: [], tools: TOOLS })).rejects.toThrow(ChatTimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  // A 30 second timer left armed after every successful reply is invisible in a passing test and
  // holds the process open in production. The count is what makes the `finally` load-bearing.
  it('clears its deadline timer once the reply has arrived', async () => {
    vi.useFakeTimers();
    try {
      const model = createBedrockChatModel({ ...OPTIONS, client: converseWith([{ text: 'ok' }]) });
      await model.reply({ system: 's', history: [], tools: TOOLS });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a budget that would make every call report a timeout', () => {
    const client = converseWith([]);
    expect(() => createBedrockChatModel({ ...OPTIONS, client, timeoutMs: 0 })).toThrow(/positive number/);
    expect(() => createBedrockChatModel({ ...OPTIONS, client, timeoutMs: Number.NaN })).toThrow(/positive number/);
    expect(() => createBedrockChatModel({ ...OPTIONS, client, maxTokens: 0 })).toThrow(/positive integer/);
    expect(() => createBedrockChatModel({ ...OPTIONS, client, maxTokens: 1.5 })).toThrow(/positive integer/);
  });

  // AN EMPTY `cause` IS THE ASSERTION, not decoration. Delete the `error instanceof
  // ChatTimeoutError` rethrow and this call does not start failing: it falls through to the
  // `timedOut` branch, which builds a SECOND ChatTimeoutError wrapping the first. Same class, same
  // message, so `rejects.toThrow(ChatTimeoutError)` alone stays green while the operator reads a
  // timeout whose cause is a timeout whose cause is nothing. The two branches mean different
  // things: this one is "nothing came back in time", the one below is "the call failed because we
  // stopped it", and only the second has an original error worth keeping.
  it('gives up on a call that never answers, and reports that timeout rather than a wrapped one', async () => {
    const never: ConverseCapableClient = { send: () => new Promise(() => {}) };
    const model = createBedrockChatModel({ ...OPTIONS, client: never, timeoutMs: 5 });
    const error = await model.reply({ system: 's', history: [], tools: TOOLS }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ChatTimeoutError);
    expect((error as Error).cause).toBeUndefined();
  });

  // The SDK retries with sleeps that do not observe the abort signal, so a client that ignores the
  // signal is not a contrived double: it is what a throttled call looks like. The race is what makes
  // the promise settle on time, and without it this test hangs for the full 60ms and then passes.
  it('settles on time even when the client is deaf to the abort signal', async () => {
    const deaf: ConverseCapableClient = {
      send: () => new Promise((resolve) => setTimeout(() => resolve({ output: { message: { content: [{ text: 'late' }] } } }), 60)),
    };
    const model = createBedrockChatModel({ ...OPTIONS, client: deaf, timeoutMs: 10 });
    const started = Date.now();
    await expect(model.reply({ system: 's', history: [], tools: TOOLS })).rejects.toThrow(ChatTimeoutError);
    expect(Date.now() - started).toBeLessThan(55);
  });

  // THE LATE FAILURE PATH, and reaching it needs a client that fails BECAUSE of the abort rather
  // than one that merely fails later. A client failing on its own schedule can never get here: the
  // deadline rejects first, wins the race, and `error instanceof ChatTimeoutError` returns above.
  // An earlier version of this test did exactly that, and deleting the whole `if (timedOut)` branch
  // left the suite green. This double rejects from the abort listener, which runs INSIDE
  // `controller.abort()` and so settles the send promise before the deadline's own rejection.
  it('reports a failure caused by the abort as the timeout it was, keeping the original on the cause', async () => {
    const failsOnAbort: ConverseCapableClient = {
      send: (_command, options) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
          });
        }),
    };
    const model = createBedrockChatModel({ ...OPTIONS, client: failsOnAbort, timeoutMs: 5 });
    const error = await model.reply({ system: 's', history: [], tools: TOOLS }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ChatTimeoutError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).name).toBe('AbortError');
  });

  it('keeps the provider error identity', async () => {
    const failing: ConverseCapableClient = {
      send: () =>
        Promise.reject(
          Object.assign(new Error('User arn:aws:iam::123456789012:user/bob is not authorized'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403, requestId: 'req-9' },
          }),
        ),
    };
    const model = createBedrockChatModel({ ...OPTIONS, client: failing });
    await expect(model.reply({ system: 's', history: [], tools: TOOLS })).rejects.toThrow(ChatProviderError);
    await expect(model.reply({ system: 's', history: [], tools: TOOLS })).rejects.toThrow(
      /AccessDeniedException \(HTTP 403\), request req-9/,
    );
  });

  // THE IDENTITY IS STILL A STRING THE FAR SIDE CHOSE. Withholding the provider's PROSE while
  // pasting its chosen NAME straight in is one rule kept in one place and dropped in the next one
  // over, and the name is the better carrier of the two: it lands mid-sentence in the operator's own
  // line, so a forged continuation reads as this adapter speaking rather than as quoted content. The
  // request id arrives by the same road. Both sat raw here while the block describer twelve hundred
  // lines up escaped everything, which is what a rule enforced in one place and believed everywhere
  // looks like from the inside.
  it('escapes the provider name and request id, which the far side also chooses', async () => {
    const newline = String.fromCodePoint(0x0a);
    const escape = String.fromCodePoint(0x1b);
    const failing: ConverseCapableClient = {
      send: () =>
        Promise.reject(
          Object.assign(new Error('denied'), {
            name: `AccessDenied${newline}ChatProviderError: all clear`,
            $metadata: { httpStatusCode: 403, requestId: `req-9${escape}[2K` },
          }),
        ),
    };
    const model = createBedrockChatModel({ ...OPTIONS, client: failing });
    const error = await model
      .reply({ system: 's', history: [], tools: TOOLS })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ChatProviderError);
    const message = (error as Error).message;
    expect(message).toContain('AccessDenied\\x{0a}ChatProviderError');
    expect(message).toContain('req-9\\x{1b}[2K');
    expect(message).not.toContain(newline);
    expect(message).not.toContain(escape);
  });

  // PRESENT AND FALSY, WHICH IS THE ROW ABOVE ONE STEP EARLIER. `describeProviderError` keeps any
  // number and any string it is handed, so a `0` status and an `''` request id both survive it and
  // reach the two lines that decide whether to print them. Those two lines read `=== undefined` in
  // both adapters now, and they read `metadata.httpStatusCode ? ... : ''` in one of them until this
  // round: a falsy-but-present value was dropped, so the message told the operator there was no
  // request id at all when what actually arrived was an EMPTY one, which is a different fault with a
  // different cause. `\empty` exists for exactly this and nothing was asserting it end to end.
  //
  // Both values are what a real failure looks like rather than invented: a status of 0 is what a
  // connection that never completed reports, and an empty `x-amzn-RequestId` is a header present and
  // blank. Pinned on this adapter and on the embedder, because the same two expressions live in both
  // files and the last round of this defect was one file keeping the rule and the other dropping it.
  it('prints a status of zero and an empty request id rather than hiding them', async () => {
    const failing: ConverseCapableClient = {
      send: () =>
        Promise.reject(
          Object.assign(new Error('socket hang up'), {
            name: 'TimeoutError',
            $metadata: { httpStatusCode: 0, requestId: '' },
          }),
        ),
    };
    const model = createBedrockChatModel({ ...OPTIONS, client: failing });
    const error = await model
      .reply({ system: 's', history: [], tools: TOOLS })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ChatProviderError);
    expect((error as Error).message).toContain('(HTTP 0)');
    expect((error as Error).message).toContain(', request \\empty');
    // WHICH ADAPTER SAID IT, WHICH NOTHING PINNED UNTIL THE SENTENCE BECAME SHARED. Both messages
    // used to spell their own subject out, so the word could not be wrong without the whole line
    // being wrong. It is now a one-word argument to a base class, and swapping it sends the operator
    // to the wrong adapter with the suite still green. That is the same defect this round is about,
    // introduced by the fix for it, which is why it is pinned in the same commit rather than after.
    expect((error as Error).message).toContain('The chat provider rejected the call for model');
    expect((error as Error).message).not.toContain('embedding provider');
    // The fields are readable off the error too, not only inside the sentence, since that is what a
    // structured log reads. `0` and `''` must survive as themselves rather than as undefined.
    expect((error as ChatProviderError).httpStatusCode).toBe(0);
    expect((error as ChatProviderError).requestId).toBe('');
    // The control, so the rule does not become "always print both": genuinely absent metadata still
    // prints neither clause. This is the case the old truthiness test was conflating with the two
    // above, and without this row `=== undefined` could be replaced by `!== null` unnoticed.
    const bare: ConverseCapableClient = {
      send: () => Promise.reject(Object.assign(new Error('no metadata'), { name: 'WeirdError' })),
    };
    const bareError = await createBedrockChatModel({ ...OPTIONS, client: bare })
      .reply({ system: 's', history: [], tools: TOOLS })
      .catch((thrown: unknown) => thrown);
    expect((bareError as Error).message).not.toContain('HTTP');
    expect((bareError as Error).message).not.toContain('request');
    expect((bareError as ChatProviderError).httpStatusCode).toBeUndefined();
    expect((bareError as ChatProviderError).requestId).toBeUndefined();
  });

  // THE TWIN OF THE EMBEDDER'S EMPTY-NAME ROW, because the sentence is shared and the extraction is
  // too: `describeProviderError` lives in the embedder and this adapter imports it, so one falsy
  // collapse there wore the absent-name word on BOTH subjects' lines. Pinned end to end on each so
  // neither adapter can drift back alone.
  it('prints an empty provider name as \\empty rather than the absent-name word', async () => {
    const failing: ConverseCapableClient = {
      send: () =>
        Promise.reject(
          Object.assign(new Error('denied'), {
            name: '',
            $metadata: { httpStatusCode: 403, requestId: undefined },
          }),
        ),
    };
    const model = createBedrockChatModel({ ...OPTIONS, client: failing });
    const error = await model
      .reply({ system: 's', history: [], tools: TOOLS })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ChatProviderError);
    expect((error as Error).message).toContain(': \\empty (HTTP 403)');
    expect((error as Error).message).not.toContain('UnknownProviderError');
  });

  // A provider message can name an account and a role. `loop.ts` records that a review proved this
  // exact leak by rejecting a recall with an AccessDeniedException and reading a role ARN back out
  // of a 200, because a tool result is a response body. The identity is useful; the prose is not.
  it('does not repeat the provider prose, which can name an account or a role', async () => {
    const failing: ConverseCapableClient = {
      send: () =>
        Promise.reject(
          Object.assign(new Error('User arn:aws:iam::123456789012:user/bob is not authorized'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          }),
        ),
    };
    const model = createBedrockChatModel({ ...OPTIONS, client: failing });
    const error = await model.reply({ system: 's', history: [], tools: TOOLS }).catch((thrown: unknown) => thrown);
    expect((error as Error).message).not.toContain('arn:aws:iam');
    expect((error as Error).message).not.toContain('bob');
    expect(((error as Error).cause as Error).message).toContain('arn:aws:iam');
  });
});

/**
 * THE JOIN, DRIVEN THROUGH BOTH HALVES, because each half passed on its own while what a caller
 * actually got was wrong.
 *
 * The table above says an empty reply raises `ChatResponseError`. `agent-loop.test.ts` says a
 * `ChatResponseError` arriving mid-turn ends as a refusal that keeps its receipts. Both of those
 * were green for as long as this file has existed, and the behaviour between them was still wrong:
 * an empty reply used to raise the sibling class, so a model that simply went quiet on round two
 * returned a 500 and none of the recalls the turn had already run. Nothing was red, because
 * nothing ran both halves in one place. A reviewer found it by driving the real adapter.
 *
 * SO THIS DRIVES THE REAL ADAPTER INTO THE REAL LOOP and asserts what is left in the caller's hand.
 * It lives in the adapter's file rather than the loop's because the dependency may only point this
 * way: this file already imports the port, and the loop is not allowed to know this file exists.
 */
describe('a reply with nothing in it, from the client through to the answer', () => {
  const converseScript = (...responses: readonly unknown[]): ConverseCapableClient => {
    let call = 0;
    return {
      send: () => {
        const response = responses[Math.min(call, responses.length - 1)];
        call += 1;
        return Promise.resolve(response);
      },
    };
  };

  const asksToRecall = {
    output: {
      message: {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'call-1', name: 'recall', input: { query: 'checkout latency' } } }],
      },
    },
    stopReason: 'tool_use',
  };

  it('keeps the recall it already ran rather than losing the turn to a 500', async () => {
    const saidNothing = { output: { message: { role: 'assistant', content: [] } }, stopReason: 'end_turn' };
    const model = createBedrockChatModel({ ...OPTIONS, client: converseScript(asksToRecall, saidNothing) });

    const result = await runAgentTurn(
      {
        model,
        repository: repositoryReturning(recallResult({ coverage: 'COVERED', memories: [scoredMemory()] })),
        workspaceId: 'demo',
      },
      'has checkout been slow before?',
    );

    expect(result.text).toContain('did not return a reply this server could use');
    expect(result.transcript[result.transcript.length - 1]?.role).toBe('refusal');
    // The four assertions that were 500, unclassified, and nothing at all before the split.
    expect(result.recalls).toHaveLength(1);
    expect(result.coverage).toBe('COVERED');
    expect(result.toolCallCount).toBe(1);
    expect(result.transcript).toHaveLength(4);
  });

  // THE CASE BETWEEN THE TWO PINNED ENDS, WHICH IS WHERE THE DEFECT KEEPS BEING FOUND. The tests
  // either side of this one drive an empty content array and a block type this build never heard
  // of, so a block of a KNOWN kind carrying the WRONG SHAPE is straddled by both and touched by
  // neither. That gap has now been wrong in both directions: first a nameless `toolUse` counted as
  // unread and took a turn's receipts out as a 500, then the fix for that counted any object at all
  // and a RENAMED field went quiet - one field from a legal block, and every reply a refusal with
  // nothing raised anywhere. This drives the renamed field through the real adapter into the real
  // loop, because a unit test on the parser cannot show that the loop does not catch it.
  it('leaves the loop when a tool-use field is renamed, rather than refusing every turn', async () => {
    const renamedField = {
      output: {
        message: {
          role: 'assistant',
          content: [{ toolUse: { toolUseId: 'call-2', toolName: 'recall', input: {} } }],
        },
      },
      stopReason: 'end_turn',
    };
    const model = createBedrockChatModel({ ...OPTIONS, client: converseScript(asksToRecall, renamedField) });

    await expect(
      runAgentTurn(
        {
          model,
          repository: repositoryReturning(recallResult({ coverage: 'COVERED', memories: [scoredMemory()] })),
          workspaceId: 'demo',
        },
        'has checkout been slow before?',
      ),
    ).rejects.toThrow(ChatUnreadableError);
  });

  // THE OTHER SIDE OF THE SPLIT, DRIVEN THE SAME WAY, so the two cannot be quietly collapsed back
  // into one class by making both sides behave alike. This is the failure that has to stay loud: a
  // block type written after this file would empty every reply while the stop reason stayed
  // `end_turn`, and swallowed as a refusal it answers every question with "no answer" forever.
  it('still leaves the loop when the blocks are a kind this build does not read', async () => {
    const model = createBedrockChatModel({
      ...OPTIONS,
      client: converseScript({
        output: { message: { role: 'assistant', content: [{ reasoningContent: {} }] } },
        stopReason: 'end_turn',
      }),
    });

    await expect(
      runAgentTurn({ model, repository: fakeRepository(), workspaceId: 'demo' }, 'has checkout been slow before?'),
    ).rejects.toThrow(ChatUnreadableError);
  });
});
