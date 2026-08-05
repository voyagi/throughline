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
 *
 * WHAT THIS DOES NOT DO, stated here because the sentence above is easy to read as more than it is.
 * The guarantee is per TURN and per PHRASING, not per QUESTION. `worstCoverage` records that SOME
 * recall this turn came back COVERED; nothing binds an absence claim to the SUBJECT that was
 * searched. A turn that recalls "checkout latency", gets a COVERED empty result, and then asserts
 * that nothing is on record about the payments database is permitted, and that is a real hole, not
 * a quibble. Closing it needs the claim's subject matched against the queries actually run, which
 * is a semantic judgement this loop deliberately does not make, because a model deciding whether
 * its own sentence is about the thing it searched is the same theatre as a model deciding when to
 * audit itself. Until a narrower binding exists, treat the guarantee as: an absence claim cannot
 * survive a turn in which no search completed. It can survive a turn that searched something else.
 */

import type { TurnView } from '@throughline/contract';
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

/**
 * One thing the model said or was told, in the order it happened.
 *
 * DECLARED IN `@throughline/contract` AND ALIASED HERE, rather than written out twice. This
 * transcript is returned verbatim in the 200 from `/agent/turn`, so the loop's internal shape and
 * the wire shape are not two things that resemble each other, they are one thing. They were two
 * for about an hour, and `npm run gate:dup` refused the commit, which was the correct answer: a
 * union copied into a second file is the classic thing that silently loses a member.
 *
 * The reasoning that used to sit here, on why `refusal` is its own role rather than an `assistant`
 * turn or a `tool_result`, moved with the declaration and is in that file.
 */
export type Turn = TurnView;

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
}

/** One completed recall, keyed to the call the model made, so a receipt can be traced to its ask. */
export interface RecallEvent {
  readonly callId: string;
  readonly result: RecallResult;
}

export interface AgentAnswer {
  readonly text: string;
  /** Every tool call and result, in order. This is the record of who said what. */
  readonly transcript: readonly Turn[];
  /**
   * Every completed recall, as DATA rather than as the sentence the model was shown.
   *
   * The transcript's `tool_result` content is written for a language model. Handing that string to
   * a console and asking it to find the candidate count in there would be a second implementation
   * of the receipt, written in regular expressions, free to drift from the first the moment the
   * rendering changes. So the receipt travels intact and the console reads fields.
   */
  readonly recalls: readonly RecallEvent[];
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

  const transcript: Turn[] = [{ role: 'user', content: message }];
  const recalls: RecallEvent[] = [];
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
      // The loop wrote this sentence, so it goes in the loop's role. It used to be pushed as an
      // `assistant` turn, which is the same misattribution fixed twice already on other paths.
      transcript.push({ role: 'refusal', content: text });
      return {
        text,
        transcript,
        coverage: worstCoverage,
        refusedAnAbsenceClaim,
        toolCallCount,
        modelId: model.id,
        recalls,
      };
    }

    const reply = await model.reply({ system: SYSTEM, history: transcript, tools: TOOLS });

    if (reply.kind === 'answer') {
      const verdict = judgeAnswer(reply.text, worstCoverage);

      // The model's words go in the transcript FIRST, always, whether they are permitted or not.
      // The refused branch used to skip this and push the loop's own sentence under the assistant
      // role instead, which both attributed the loop's words to the model and dropped what the
      // model actually said. That is the same defect the `refusal` role exists to prevent, on the
      // sibling of the path where it was first fixed, and no test could see it because every one
      // of them looked at the FIRST refusal turn. Two rounds, two instances, one shape.
      transcript.push({ role: 'assistant', content: reply.text });

      if (verdict.permitted) {
        return {
          text: reply.text,
          transcript,
          coverage: worstCoverage,
          refusedAnAbsenceClaim,
          toolCallCount,
          modelId: model.id,
          recalls,
        };
      }

      transcript.push({ role: 'refusal', content: verdict.refusal });

      if (refusedAnAbsenceClaim) {
        // Already refused once. Ending the turn on the refusal rather than on the answer is the
        // safe direction: a second attempt at the same claim is not a misunderstanding.
        //
        // What the OPERATOR is shown is not `verdict.refusal`. That sentence is written in the
        // second person to the model ("Rewrite it to say what you actually know"), and returning it
        // as the answer put instructions for the model on the screen meant for the person handling
        // the incident. So the returned text is deliberately NOT the last transcript turn here:
        // the transcript records the exchange, and `text` is what the operator reads.
        return {
          text: refusalForTheUser(worstCoverage),
          transcript,
          coverage: worstCoverage,
          refusedAnAbsenceClaim,
          toolCallCount,
          modelId: model.id,
          recalls,
        };
      }

      refusedAnAbsenceClaim = true;
      continue;
    }

    for (const call of reply.calls) {
      // Announced BEFORE the budget check, and that order is the fix for a defect this file
      // introduced while fixing the same defect elsewhere. The over-budget branch used to push a
      // `tool_result` and skip this line, so it emitted a result for an id no `tool_call` had
      // announced: the exact shape the `refusal` role was added to remove, left standing on the
      // one path the invariant test did not drive. The model really did ask for the tool, so
      // recording the request and answering it with a refusal is also the honest transcript.
      transcript.push({ role: 'tool_call', id: call.id, name: call.name, args: call.args });

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

      const outcome = await runTool(call, { repository, workspaceId });
      if (outcome.coverage !== undefined) worstCoverage = worseOf(worstCoverage, outcome.coverage);
      // Keyed by the call id the model supplied, so a console can line a receipt up with the
      // request that produced it rather than by position.
      if (outcome.recall !== undefined) recalls.push({ callId: call.id, result: outcome.recall });
      transcript.push({ role: 'tool_result', id: call.id, name: call.name, content: outcome.content });
    }
  }
}

interface ToolOutcome {
  readonly content: string;
  /** Set only by recall, because it is the only tool that produces a coverage verdict. */
  readonly coverage?: Coverage;
  /**
   * The recall itself, when the tool WAS a recall and it completed.
   *
   * Absent when the recall threw, and that absence is meaningful rather than incidental: there is
   * no receipt to show for a search that did not finish, and inventing an empty one would put a
   * blank record on the board where the truth is that nothing was recorded.
   */
  readonly recall?: RecallResult;
}

interface ToolContext {
  readonly repository: MemoryRepository;
  readonly workspaceId: string;
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
    // NO THROWN MESSAGE GOES IN HERE, and that is a boundary rather than tidiness.
    //
    // A `tool_result` is not an internal detail. The HTTP surface returns the whole transcript on a
    // 200, so anything written here is a response body, and it is written by whatever threw. That
    // is a second exit from the process that the error mapper in `http/failures.ts` never sees: a
    // review proved it by rejecting a recall with an AccessDeniedException and reading a role ARN
    // back out of a 200. The mapper was clean and the claim built on it was still false, because it
    // only ever guarded the FAILURE path and this is the success path.
    //
    // The model loses nothing it could act on. "The search could not run" is the entire operable
    // content of a provider failure; an account id and a role name are not things a model reasons
    // about. The detail is not lost either, it goes to the operator's log at the boundary that
    // caught it.
    const content =
      error instanceof CoverageUnknownError
        ? 'That could not be answered from memory: the search could not establish what it covered, ' +
          'so nothing about absence follows from it.'
        : `${call.name} failed. The reason is in the operator's log rather than here. Do not treat ` +
          'this as a result. If it was a recall, you have learned nothing about whether the thing ' +
          'exists.';

    // ONE rule, and it is the fix for a real fail-open hole rather than a hypothetical. A recall
    // that THREW used to return no coverage at all, so a turn that recalled once COVERED and then
    // hit a database error on a second recall kept COVERED as its verdict, and `judgeAnswer` then
    // permitted "no prior incidents" on the strength of a search that had broken. The loop is
    // written against the `MemoryRepository` PORT, whose contract nowhere promises that recall does
    // not throw, and `runRecall`'s own comments record that it has shipped a throw straight past
    // its coverage decision TWICE ("it used to throw straight past every coverage decision in this
    // function", "One bad row used to take the entire recall down").
    //
    // The rule is ATTEMPTED-AND-FAILED, not "failed for any reason", and the difference is a
    // decision rather than an oversight. A recall whose arguments the schema refused never reached
    // the repository and returns above this catch with no verdict, so it leaves the turn's coverage
    // alone. Degrading there would be permanent: `worseOf` only ever moves downwards, so one
    // malformed argument list would pin the whole turn at UNKNOWN even after the model retried and
    // got a clean COVERED search, and the demo would refuse answers it had genuinely established.
    // The cost of that choice is real and is pinned by a test: a COVERED recall followed by a
    // malformed one still permits an absence claim. That is the same per-turn limit described at
    // the top of this file, not a separate hole.
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
    // The RESULT travels alongside the rendered text, and the two have different readers. The
    // string is what the MODEL is shown. The structured result is what the console racks on its
    // board, so that no reader of this system has to recover a number by parsing a sentence
    // written for something else. A console that regex-scraped this prose would be a second
    // implementation of the receipt, free to drift from the first.
    return { content: renderRecall(result), coverage: result.receipt.coverage, recall: result };
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

/**
 * What the OPERATOR is told when an answer is withheld.
 *
 * Separate from `AnswerVerdict.refusal`, which is addressed to the model in the second person and
 * tells it how to rewrite. Returning that text as the answer put the model's instructions on the
 * operator's screen. Both exist because they have different readers, and the transcript keeps the
 * model-facing one so the exchange stays auditable.
 */
export function refusalForTheUser(coverage: Coverage | null): string {
  const searched =
    coverage === null
      ? 'no search of the incident memory ran during this turn'
      : `the search of the incident memory came back ${coverage}`;
  return (
    `This answer was withheld. It asserted that something does not exist, and ${searched}, so that ` +
    'was never established. Treat it as an unanswered question rather than as an absence, and read ' +
    'the receipt above for what the search actually did.'
  );
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
