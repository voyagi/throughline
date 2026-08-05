/**
 * The agent's tool loop.
 *
 * Deterministic control flow, model-chosen content. The model decides WHICH tool to call and what
 * to say; it decides nothing about whether an answer is permitted, how many turns are allowed, or
 * what a recall receipt means. Everything that gates a claim is computed here, in code, which is
 * the same rule the memory layer already follows: an LLM writes the narrative, never the number.
 *
 * THE ONE PROPERTY THIS FILE EXISTS FOR. The agent must be structurally unable to report an
 * absence it did not establish. Three independent controls, because one is a prompt and prompts are
 * suggestions:
 *
 * 1. The tool RESULT for a failed recall leads with the failure, so there is no reading of it in
 *    which the model sees memories before it sees that the search did not run (`renderRecall`).
 * 2. The loop tracks the WORST coverage verdict any recall returned this turn. That is state the
 *    model cannot influence.
 * 3. The final answer is checked against that verdict. An answer asserting absence when coverage
 *    was not COVERED is refused and the model is told why, once. If it does it again, the turn ends
 *    with the refusal rather than with the answer, because the alternative is shipping the exact
 *    sentence this product exists to prevent.
 *
 * Control 3 is a blocklist of phrasings and would be weak alone. It is not alone, and it is the
 * only one of the three that looks at what the model actually SAID rather than what it was told.
 */

import {
  CoverageUnknownError,
  type Coverage,
  type MemoryRepository,
  type RecallResult,
} from '@throughline/memory';
import {
  claimsAbsence,
  mayAssertAbsence,
  parseToolCall,
  renderMemory,
  renderRecall,
  TOOLS,
  type ForgetArguments,
  type InspectArguments,
  type RecallArguments,
  type RememberArguments,
  type SupersedeArguments,
  type ToolDefinition,
} from './tools.ts';

/** One thing the model said or was told, in the order it happened. */
export type Turn =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string }
  | { readonly role: 'tool_call'; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly role: 'tool_result'; readonly id: string; readonly name: string; readonly content: string }
  /**
   * The loop's own words: what it told the model when it refused an answer.
   *
   * Its own role rather than a `tool_result`, and that distinction is load bearing in two places.
   * A provider adapter has to render it as model input, and a `tool_result` carrying an id that no
   * preceding `tool_call` announced is rejected outright by both the Bedrock Converse API and the
   * Anthropic Messages API, so the shape this used to have would have failed on first contact with
   * a real provider while passing every test here. The console has the mirror problem: attributing
   * the refusal to the user or to a tool puts the loop's sentence in someone else's mouth on the
   * one screen that exists to show who said what.
   */
  | { readonly role: 'refusal'; readonly content: string };

export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/**
 * What the model came back with: either an answer, or tools it wants run.
 *
 * A union rather than an object with optional fields, so "it answered AND asked for tools" is not
 * representable. Providers differ on whether they can do both; the loop does not need to care and
 * should not have a branch for a state it will not act on.
 */
export type ChatReply =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'tools'; readonly calls: readonly ChatToolCall[] };

/**
 * The port the Bedrock adapter implements and the scripted local model also implements.
 *
 * Defined here rather than in the adapter for the same reason `Embedder` lives in the memory
 * package: the thing that OWNS the contract should not be the thing that happens to be first to
 * implement it.
 */
export interface ChatModel {
  /** Identifies the model in an audit row, so an answer can be traced to what produced it. */
  readonly id: string;
  reply(input: {
    readonly system: string;
    readonly history: readonly Turn[];
    readonly tools: readonly ToolDefinition[];
  }): Promise<ChatReply>;
}

export interface AgentOptions {
  readonly model: ChatModel;
  readonly repository: MemoryRepository;
  readonly workspaceId: string;
  /**
   * A hard ceiling on tool round trips in one turn.
   *
   * Not a tuning parameter. It is what stops a model that has decided to recall forever from
   * spending the demo's daily budget in ninety seconds, and it is enforced here rather than hoped
   * for in a prompt.
   */
  readonly maxToolCalls?: number;
  readonly clock?: () => Date;
}

export interface AgentAnswer {
  readonly text: string;
  /** Every tool call and result, in order. This is what the console's memory pane renders. */
  readonly transcript: readonly Turn[];
  /** The worst coverage any recall returned. `null` when nothing was recalled at all. */
  readonly coverage: Coverage | null;
  /** True when the loop refused an answer for asserting an absence it had not established. */
  readonly refusedAnAbsenceClaim: boolean;
  readonly toolCallCount: number;
  readonly modelId: string;
}

const DEFAULT_MAX_TOOL_CALLS = 8;

const SYSTEM = `You are an on-call incident response assistant. Your value is entirely in what you
remember across incidents: what broke before, what actually fixed it, and which promising
hypothesis turned out to be a red herring.

Before answering anything about past incidents, recall. After learning something durable, remember
it, with provenance.

Every recall comes back with a coverage verdict. COVERED means the search ran over everything it
was meant to. PARTIAL means it was cut short, so what you got is real but incomplete. UNKNOWN means
the search could not run at all, and an empty result under UNKNOWN tells you nothing whatsoever.

You may never report that something did not happen, was never seen, or has no prior record, unless
a recall came back COVERED and empty. If coverage was UNKNOWN, say that the memory could not be
searched and why. Saying "no prior incidents" when you simply could not look is the single worst
thing you can do here, and it is worse than saying nothing.

Cite the memories you use by their id, and say when one is flagged stale.`;

/** The system prompt the loop sends. Exported so a test can assert what the model was actually told. */
export const SYSTEM_PROMPT = SYSTEM;

/**
 * Run one user message to an answer, calling tools in between.
 *
 * The `coverage` this returns is the WORST verdict any recall produced, not the last one. A turn
 * that recalled twice, once COVERED and once UNKNOWN, is a turn with an unanswered question in it.
 */
export async function runAgentTurn(options: AgentOptions, message: string): Promise<AgentAnswer> {
  const { model, repository, workspaceId } = options;
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const clock = options.clock ?? ((): Date => new Date());

  const transcript: Turn[] = [{ role: 'user', content: message }];
  let worstCoverage: Coverage | null = null;
  let toolCallCount = 0;
  let refusedAnAbsenceClaim = false;

  // A cap on ROUNDS, not just on tool calls, and they are genuinely different limits. Once the tool
  // budget is spent, every further request is answered with "you have used your budget" WITHOUT
  // incrementing the tool count, so a model that keeps asking for tools would spin here forever on
  // a budget that can never be exceeded again. That is a hang, live, in front of whoever is
  // watching. The extra rounds are for the model to notice and answer.
  const maxRounds = maxToolCalls + 4;

  for (let round = 0; ; round += 1) {
    if (round >= maxRounds) {
      const text =
        'This turn ran out of room before reaching an answer. Nothing here is a finding, and in ' +
        'particular nothing here says that anything is absent from memory.';
      transcript.push({ role: 'assistant', content: text });
      return {
        text,
        transcript,
        coverage: worstCoverage,
        refusedAnAbsenceClaim,
        toolCallCount,
        modelId: model.id,
      };
    }

    const reply = await model.reply({ system: SYSTEM, history: transcript, tools: TOOLS });

    if (reply.kind === 'answer') {
      const verdict = judgeAnswer(reply.text, worstCoverage);
      if (verdict.permitted || refusedAnAbsenceClaim) {
        // Already refused once. Ending the turn with the refusal rather than with the answer is the
        // safe direction: a second attempt at the same claim is not a misunderstanding.
        const text = verdict.permitted ? reply.text : verdict.refusal;
        transcript.push({ role: 'assistant', content: text });
        return {
          text,
          transcript,
          coverage: worstCoverage,
          refusedAnAbsenceClaim,
          toolCallCount,
          modelId: model.id,
        };
      }
      refusedAnAbsenceClaim = true;
      transcript.push({ role: 'assistant', content: reply.text });
      transcript.push({ role: 'refusal', content: verdict.refusal });
      continue;
    }

    for (const call of reply.calls) {
      if (toolCallCount >= maxToolCalls) {
        transcript.push({
          role: 'tool_result',
          id: call.id,
          name: call.name,
          content:
            `This turn has already used its ${maxToolCalls} tool calls. Answer with what you have, ` +
            'and say plainly what you did not get to check.',
        });
        continue;
      }
      toolCallCount += 1;
      transcript.push({ role: 'tool_call', id: call.id, name: call.name, args: call.args });

      const outcome = await runTool(call, { repository, workspaceId, clock });
      if (outcome.coverage !== undefined) worstCoverage = worseOf(worstCoverage, outcome.coverage);
      transcript.push({ role: 'tool_result', id: call.id, name: call.name, content: outcome.content });
    }
  }
}

interface ToolOutcome {
  readonly content: string;
  /** Set only by recall, because it is the only tool that produces a coverage verdict. */
  readonly coverage?: Coverage;
}

interface ToolContext {
  readonly repository: MemoryRepository;
  readonly workspaceId: string;
  readonly clock: () => Date;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runTool(call: ChatToolCall, context: ToolContext): Promise<ToolOutcome> {
  const parsed = parseToolCall(call.name, call.args);
  if (!parsed.ok) return { content: parsed.reason };

  try {
    return await dispatch(parsed.tool, parsed.args, context);
  } catch (error) {
    // A failed tool is an ordinary event and the model should be told, in its own terms, rather
    // than having the turn collapse.
    //
    // `CoverageUnknownError` earns a sentence of its own because it is not a malfunction: it is the
    // memory layer refusing to let an unanswerable question be answered. Be honest about its
    // reachability. `createRepository` does NOT throw it today: `runRecall` catches an embedder
    // failure, a failed count query, a failed candidate query and an unscoreable row, and returns
    // an UNKNOWN receipt for each. This arm exists because the error is the memory package's
    // documented signal for exactly this situation ("an agent tool can be forced to surface it"),
    // and because `MemoryRepository` is a port: a decorated or replacement implementation may
    // throw it. It refines the MESSAGE only. It is not what sets coverage.
    const content =
      error instanceof CoverageUnknownError
        ? `That could not be answered from memory: ${error.message}`
        : `${call.name} failed: ${describeError(error)}. Do not treat this as a result. If it was ` +
          'a recall, you have learned nothing about whether the thing exists.';

    // ONE rule, and it is the fix for a real fail-open hole rather than a hypothetical. A recall
    // that THREW used to return no coverage at all, so a turn that recalled once COVERED and then
    // hit a database error on a second recall kept COVERED as its verdict, and `judgeAnswer` then
    // permitted "no prior incidents" on the strength of a search that had broken. The loop is
    // written against the `MemoryRepository` PORT, whose contract nowhere promises that recall does
    // not throw, and `runRecall`'s own comments record that it has shipped a throw straight past
    // its coverage decision TWICE ("it used to throw straight past every coverage decision in this
    // function", "One bad row used to take the entire recall down"). A recall that failed for any
    // reason leaves the turn unable to support a claim about absence, which is exactly what an
    // UNKNOWN verdict means.
    return parsed.tool.name === 'recall' ? { content, coverage: 'UNKNOWN' } : { content };
  }
}

async function dispatch(
  tool: ToolDefinition,
  args: unknown,
  context: ToolContext,
): Promise<ToolOutcome> {
  const { repository, workspaceId } = context;

  if (tool.name === 'recall') {
    const input = args as RecallArguments;
    const result: RecallResult = await repository.recall({
      workspaceId,
      text: input.query,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return { content: renderRecall(result), coverage: result.receipt.coverage };
  }

  if (tool.name === 'remember') {
    const input = args as RememberArguments;
    const stored = await repository.remember({
      workspaceId,
      kind: input.kind,
      content: input.content,
      provenance: {
        assertedBy: input.assertedBy,
        incidentId: input.incidentId ?? null,
        sourceRef: input.sourceRef ?? null,
      },
    });
    return {
      content:
        `Stored as ${stored.id}. It is unembedded, so it will not be found by semantic recall ` +
        'until it is embedded.',
    };
  }

  if (tool.name === 'supersede') {
    const input = args as SupersedeArguments;
    const { previous, replacement } = await repository.supersede(input.previousId, {
      workspaceId,
      kind: input.kind,
      content: input.content,
      provenance: {
        assertedBy: input.assertedBy,
        incidentId: input.incidentId ?? null,
        sourceRef: input.sourceRef ?? null,
      },
    });
    return {
      content:
        `${replacement.id} now supersedes ${previous.id}. The old memory is not deleted: its ` +
        `validity window closed at ${previous.validUntil?.toISOString() ?? 'now'} and it stays ` +
        'queryable, so the history of what was believed remains readable.',
    };
  }

  if (tool.name === 'inspect') {
    const input = args as InspectArguments;
    const memory = await repository.getById(workspaceId, input.memoryId);
    if (!memory) {
      return {
        content:
          `No memory with id ${input.memoryId} in this workspace. This is a real absence: it was ` +
          'a direct lookup by primary key, not a search.',
      };
    }
    return { content: renderMemory(memory) };
  }

  // forget. Left last because it is the only one whose repository operation does not exist yet as a
  // single call: a tombstone is written by the eviction path, and wiring a one-row tombstone
  // through it is the next change to `MemoryRepository` rather than something to fake here. The
  // tool's own description says so too, so the model is not told it can do something it cannot.
  const input = args as ForgetArguments;
  return {
    content:
      `forget is not wired up yet, so nothing was changed for ${input.memoryId}. Say that plainly ` +
      'rather than implying the memory was removed.',
  };
}

const COVERAGE_ORDER: readonly Coverage[] = ['COVERED', 'PARTIAL', 'UNKNOWN'];

/**
 * Reduce a verdict to one this code recognises, treating anything else as UNKNOWN.
 *
 * An ALLOWLIST for the same reason `assertAnswerable` gives: coverage is typed as one of three
 * strings and arrives from a database column, so the type is a claim about the code rather than
 * about the data. Without this, `worseOf` compared through `indexOf`, an unrecognised verdict
 * scored -1, and `indexOf(left) >= -1` is true for every left, so a bad value was silently DROPPED
 * and the previous verdict survived. That fails open in the one direction that matters: the
 * previous verdict can be COVERED, and COVERED is what permits an absence claim.
 */
function recognised(coverage: Coverage): Coverage {
  return coverage === 'COVERED' || coverage === 'PARTIAL' ? coverage : 'UNKNOWN';
}

/** The worse of two verdicts, where worse means less able to support a claim about absence. */
export function worseOf(left: Coverage | null, right: Coverage): Coverage {
  const rightVerdict = recognised(right);
  if (left === null) return rightVerdict;
  const leftVerdict = recognised(left);
  return COVERAGE_ORDER.indexOf(leftVerdict) >= COVERAGE_ORDER.indexOf(rightVerdict)
    ? leftVerdict
    : rightVerdict;
}

export interface AnswerVerdict {
  readonly permitted: boolean;
  /** What the model is told when the answer is refused. Empty when it is permitted. */
  readonly refusal: string;
}

/**
 * May this answer stand, given what the recalls actually established?
 *
 * Pure, so the rule can be tested exhaustively without a model, a database or a network. The only
 * thing it refuses is an assertion of absence unsupported by a COVERED recall. It does not police
 * tone, hedging or length, because a check that refuses too much gets loosened until it refuses
 * nothing.
 */
export function judgeAnswer(text: string, coverage: Coverage | null): AnswerVerdict {
  if (!claimsAbsence(text)) return { permitted: true, refusal: '' };
  if (coverage !== null && mayAssertAbsence(coverage)) return { permitted: true, refusal: '' };

  const because =
    coverage === null
      ? 'you did not recall anything at all this turn'
      : `the recall came back ${coverage}`;
  return {
    permitted: false,
    refusal:
      `That answer says something does not exist, and ${because}, so you have not established it. ` +
      'Rewrite it to say what you actually know: that the memory could not be searched, or was ' +
      'searched only in part, and what would need to happen to answer the question properly. Do ' +
      'not restate the absence.',
  };
}
