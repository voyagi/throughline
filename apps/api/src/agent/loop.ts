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

/**
 * Thrown by a `ChatModel` when the provider ANSWERED, this adapter READ the answer, and the answer
 * is not one a turn can end on: cut off at a token ceiling, filtered, stopped for a reason that is
 * not an end, or read cleanly and empty.
 *
 * DECLARED HERE, WITH THE PORT, RATHER THAN IN THE ADAPTER THAT THROWS IT FIRST. The loop has to
 * tell "the model replied with something unusable" from "the provider is unreachable", because it
 * ends a turn differently for each, and reaching into the Bedrock adapter for the class would make
 * every consumer of this loop depend on the AWS SDK, the local model and its tests included. Same
 * rule as `ChatModel` above: the thing that owns the contract should not be the thing that happens
 * to implement it first.
 *
 * NARROWED TO A REPLY THAT WAS READ. It used to cover both this and "the response was not a shape
 * this adapter recognises", and the loop answered both with a 200 refusal. The second is not a
 * provider behaving as providers do, it is this build being wrong about the API, and after an SDK
 * upgrade or a response-shape change it would be EVERY turn: every question answered "no answer",
 * the 5xx rate flat, `/health` still ok, and the only trace an optional log line. That case is
 * `ChatUnreadableError` below and it is deliberately not caught.
 *
 * ITS MESSAGE IS FOR THE OPERATOR'S LOG AND NEVER FOR A RESPONSE BODY. The adapter builds these
 * from literals, but one of them quotes part of the provider's own response, and `http/failures.ts`
 * records at length why a string from outside is not allowed to reach a caller. The loop logs this
 * and answers with a sentence of its own.
 */
export class ChatResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatResponseError';
  }
}

/**
 * Thrown by a `ChatModel` when the response cannot be READ at all: not an object, no content array,
 * or content in which not one block was a kind the adapter knows, shaped the way the provider's own
 * SDK declares that kind. A block it read and found empty is NOT this: that is `ChatResponseError`
 * below, and the difference is the turn's receipts.
 *
 * A SIBLING OF `ChatResponseError` AND DELIBERATELY NOT A SUBCLASS, because the loop's whole
 * decision is one `instanceof` and a subclass would be caught by it. This one is meant to escape:
 * it means the adapter and the provider disagree about the shape of a response, which is a bug in
 * this build rather than a thing that happened to one turn. It leaves as a 5xx so that a broken
 * adapter is loud on the first request rather than quiet on every one.
 *
 * THE COST IS THE RECEIPTS, AND WHAT IS WRITTEN HERE ABOUT THAT COST HAS ALREADY BEEN WRONG ONCE.
 * A turn that recalled something and then hit this loses its transcript, its receipts and its
 * coverage verdict to the failure. The paragraph that stood here justified that by claiming there
 * is no version of this failure that is both rare and mid-turn. That was false, and the case it was
 * false about was the common one: a model that simply goes quiet used to land here, so a silent
 * `end_turn` on round two of a real turn returned a 500 and zero receipts. It now raises
 * `ChatResponseError` from the same site, because a response this adapter read and found empty is a
 * provider being a provider. See the split at the bottom of `parseConverseReply`.
 *
 * WHAT IS LEFT IS BELIEVED RARE AND IS NOT PROVEN IMPOSSIBLE, and that is the honest version. Two of
 * the three throws cannot be mid-turn in any interesting way: a response that is not an object, and
 * one with no content array, are wrong on round one of every turn. The third, blocks present and not
 * one of them read, is systemic in the case worth being loud for and could in principle happen to a
 * single turn, if a model emitted nothing but a block type new to this build on exactly that round.
 * That residue is accepted rather than argued away. What would settle it is the same measurement
 * `unusableReply` names for its own accepted loss: a rate on the live path that is not near zero.
 *
 * THIS PARAGRAPH HAS NOW BEEN WRONG TWICE, FIRST ABOUT THE WORD "READ" AND THEN ABOUT THE FACT UNDER
 * IT. "Read" once meant "yielded something usable", so a `toolUse` carrying no name was called
 * unreadable and took a turn's receipts out as a 500. The fix for that counted ANY object under
 * `toolUse`, on the stated ground that the SDK declares `name` optional. It does not: `ToolUseBlock`
 * writes `name` with no `?`, which makes it a required member whose type merely includes `undefined`,
 * and the version resting on that misreading went QUIET on a renamed field - every reply a refusal,
 * the 5xx rate flat, which is the exact failure this class exists for. "Read" now means what it says:
 * a kind this adapter knows, shaped as the SDK declares it. An empty string is read; misshapen is not.
 */
export class ChatUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatUnreadableError';
  }
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
  /**
   * A hard ceiling on how long one turn may take, measured on the clock rather than in rounds.
   *
   * Rounds bound how many times the model may speak. Nothing bounded how LONG each one took, which
   * was academic while the only model was the local one that answers synchronously. A hosted model
   * has a per-call budget of its own and twelve rounds of it MULTIPLY.
   */
  readonly turnBudgetMs?: number;
  /**
   * Where a detail goes when the turn cannot show it to the caller.
   *
   * Optional, because no decision in this loop depends on it, and wired in `server.ts` from the
   * same logger the rest of the process writes to. A turn refused for an unusable reply can only
   * say THAT it happened: the reason is what an operator needs and is the one thing that must not
   * reach a response body.
   */
  readonly log?: (line: string) => void;
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

/**
 * Ten times the longest turn measured against live Bedrock, which answered in 5.4 seconds.
 *
 * The number that matters is the one this replaces. The shipped chat defaults are 30 seconds per
 * call and twelve rounds, so before this bound existed a single `POST /agent/turn` could hold a
 * request open for six minutes while the caller watched a spinner.
 *
 * WHAT IS ACTUALLY ENFORCED, because a bound written down loosely is worse than one left implied.
 * The clock is read before each round AND before each tool call, and neither check interrupts work
 * already in flight, so a turn starts nothing new past its budget and the last thing it started
 * runs to its own ceiling. The bound is therefore the budget plus the longest single step, and the
 * longest single step is a TOOL rather than the 30 s model call (`bedrock-model.ts`).
 *
 * That tool is `supersede`, dispatched below like any other. It runs inside `db.transaction`
 * (`packages/memory/src/db.ts`), so one call is a pool connect bounded by the 10 s
 * `connectionTimeoutMillis` plus SEVEN statements each bounded by the 15 s `statement_timeout`:
 * BEGIN, the locking SELECT, the insert, the update that closes the old row, the audit insert, the
 * re-read, COMMIT. The timeout is applied as a connection startup option, so it is per statement
 * and not for the transaction. That is about 115 s, against about 70 s for `remember` and about
 * 32 s for `recall`. So the bound is roughly 175 s: call it three minutes, not exactly sixty
 * seconds and not six.
 *
 * TWO VERSIONS OF THIS PARAGRAPH HAVE NOW BEEN WRONG IN THE SAME WAY, which is why the derivation
 * is written out instead of the number. The first said ninety seconds while counting only the model
 * call. The second said ninety seconds again while counting `recall` and calling it "the most
 * expensive tool", which it is not: it was the most expensive tool the author had in mind. Both
 * measured one mechanism and wrote the figure down against another. Anyone changing a timeout,
 * adding a statement to `supersede`, or adding a tool has to redo the arithmetic above, and if
 * three minutes is not acceptable the fix is a deadline handed to the tool call, not a reworded
 * comment.
 */
const DEFAULT_TURN_BUDGET_MS = 60_000;

/**
 * Refuse a budget that removes the ceiling it exists to impose.
 *
 * `Date.now() + NaN` is `NaN` and every comparison against `NaN` is false, so a NaN budget does not
 * shorten a turn, it makes the check that ends one unreachable. `maxToolCalls` fails the same way
 * through `maxRounds`, and worse: the tool budget is what stops one turn from spending the day's
 * provider bill. Zero is not nullish, so it survives `??` and refuses every turn at round zero,
 * after the HTTP layer has already claimed a budget slot and cannot refund it.
 *
 * Neither has a configuration path today, so this is a guard against the env var somebody adds
 * later. Both Bedrock adapters validate their own budgets in this shape and for this reason, and
 * the embedder's note is the shortest version of it: an unvalidated budget is worse than a wrong
 * one, because a wrong one is visible.
 */
function requireBudget(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Agent ${name} must be a positive finite number, received ${String(value)}. A budget that is ` +
        'not a number does not shorten a turn, it removes the limit.',
    );
  }
  return value;
}

/**
 * What a turn says when it ends without an answer.
 *
 * A factory rather than three literals, because the second sentence is the one that matters and it
 * has to be identical every time. A turn that stopped early knows LESS than one that finished, so
 * the single thing it must never do is hand back a shorter answer that reads as a conclusion. Only
 * the opening clause differs, and it names which ceiling was hit.
 */
function stoppedEarly(because: string): string {
  return (
    `${because} Nothing here is a finding, and in particular nothing here says that anything is ` +
    'absent from memory.'
  );
}

const RAN_OUT_OF_TIME = stoppedEarly('This turn ran out of time before reaching an answer.');
const RAN_OUT_OF_ROOM = stoppedEarly('This turn ran out of room before reaching an answer.');
const REPLY_UNUSABLE = stoppedEarly(
  'The model did not return a reply this server could use, so this turn has no answer.',
);

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

Cite the memories you use by their id, and say when one is flagged stale.

Write plain prose. The console prints your answer verbatim and renders no markdown, so asterisks,
backticks and heading marks reach the reader as literal punctuation rather than as formatting.`;

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
  const maxToolCalls = requireBudget('maxToolCalls', options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS);
  const turnBudgetMs = requireBudget('turnBudgetMs', options.turnBudgetMs ?? DEFAULT_TURN_BUDGET_MS);

  const transcript: Turn[] = [{ role: 'user', content: message }];
  const recalls: RecallEvent[] = [];
  let worstCoverage: Coverage | null = null;
  let toolCallCount = 0;
  let refusedAnAbsenceClaim = false;
  // THE ID EVERY JOIN IN THIS TURN IS KEYED ON, and it has a counter of its own rather than reusing
  // `toolCallCount`, which counts a different thing. Only calls UNDER budget increment that one, so
  // an over-budget call would be announced under an id the last counted call already holds, and the
  // one property this id has to have is that it cannot repeat.
  let announced = 0;

  // A cap on ROUNDS, not just on tool calls, and they are genuinely different limits. Once the tool
  // budget is spent, every further request is answered with "you have used your budget" WITHOUT
  // incrementing the tool count, so a model that keeps asking for tools would spin here forever on
  // a budget that can never be exceeded again. That is a hang, live, in front of whoever is
  // watching. The extra rounds are for the model to notice and answer.
  const maxRounds = maxToolCalls + 4;
  const expiresAt = Date.now() + turnBudgetMs;
  const outOfTime = (): boolean => Date.now() >= expiresAt;

  // ONE PLACE BUILDS THE ANSWER, and it reads the loop's state at the moment it is called rather
  // than being handed a copy. There were three of these literals, one per exit, and they are the
  // shape a field gets added to on the happy path and forgotten on the early ones: `recalls` is
  // itself a field that arrived late, and the receipts are the whole argument of this product.
  const answerFrom = (text: string): AgentAnswer => ({
    text,
    transcript,
    coverage: worstCoverage,
    refusedAnAbsenceClaim,
    toolCallCount,
    modelId: model.id,
    recalls,
  });

  // EVERY WAY A TURN CAN END WITHOUT AN ANSWER ends it here, in one place. Each pushes the loop's
  // own sentence as a `refusal` and hands back everything the turn did establish: the transcript,
  // the receipts and the worst coverage any recall returned. A turn that stopped early still
  // searched whatever it searched, and dropping that would leave the caller a status code to read
  // where the receipt should be.
  const endTurn = (text: string): AgentAnswer => {
    // The loop wrote this sentence, so it goes in the loop's role. It used to be pushed as an
    // `assistant` turn, which is the same misattribution fixed twice already on other paths.
    transcript.push({ role: 'refusal', content: text });
    return answerFrom(text);
  };

  for (let round = 0; ; round += 1) {
    const timeUp = outOfTime();
    if (round >= maxRounds || timeUp) return endTurn(timeUp ? RAN_OUT_OF_TIME : RAN_OUT_OF_ROOM);

    let reply: ChatReply;
    try {
      reply = await model.reply({ system: SYSTEM, history: transcript, tools: TOOLS });
    } catch (error) {
      return endTurn(unusableReply(error, options.log));
    }

    if (reply.kind === 'answer') {
      const settled = settleAnswer(reply.text, transcript, worstCoverage, refusedAnAbsenceClaim);
      if (settled !== null) return answerFrom(settled);
      refusedAnAbsenceClaim = true;
      continue;
    }

    for (const call of reply.calls) {
      // THE CLOCK IS READ HERE TOO, not only between rounds, and the gap that leaves is not small.
      // One reply may ask for the whole tool budget at once, and the most expensive tool is a
      // transaction of seven statements against the cluster, so eight of them can outlast the
      // turn's budget many times over while the check at the top of the loop waits for a round that
      // has not come round yet. The arithmetic is with `DEFAULT_TURN_BUDGET_MS`. Read BEFORE the
      // call is announced, so the transcript never carries a `tool_call` with nothing under it.
      if (outOfTime()) return endTurn(RAN_OUT_OF_TIME);

      // Announced BEFORE the budget check, and that order is the fix for a defect this file
      // introduced while fixing the same defect elsewhere. The over-budget branch used to push a
      // `tool_result` and skip this line, so it emitted a result for an id no `tool_call` had
      // announced: the exact shape the `refusal` role was added to remove, left standing on the
      // one path the invariant test did not drive. The model really did ask for the tool, so
      // recording the request and answering it with a refusal is also the honest transcript.
      //
      // THE ID IS THIS LOOP'S OWN AND THE MODEL'S GOES IN `given`, which is the fix for a hole the
      // turn coherence guard found by firing on it. `call.id` arrives from the model and nothing
      // constrains it, so a model reusing one id for every call produced two announcements, two
      // results and two receipts under one key. Every join in this system is that key: the console
      // matches a receipt to the request that produced it by id, and a repeat there hides a FAILED
      // recall behind a successful one, on the page whose whole argument is that the two are told
      // apart. `given` keeps what the model sent, because that is what a provider adapter has to
      // hand back when it replays this transcript, and discarding it to gain uniqueness would trade
      // one loss for another.
      announced += 1;
      const id = `tc-${announced}`;
      transcript.push({ role: 'tool_call', id, given: call.id, name: call.name, args: call.args });

      if (toolCallCount >= maxToolCalls) {
        transcript.push({
          role: 'tool_result',
          id,
          name: call.name,
          content:
            `This turn has already used its ${maxToolCalls} tool calls. Answer with what you have, ` +
            'and say plainly what you did not get to check.',
        });
        continue;
      }
      toolCallCount += 1;

      const outcome = await runTool(call, { repository, workspaceId });
      worstCoverage = recordOutcome(outcome, { id, name: call.name }, { transcript, recalls }, worstCoverage);
    }
  }
}

/**
 * The sentence a turn ends on when the adapter could not use the model's reply, or a rethrow.
 *
 * A REPLY THE ADAPTER COULD NOT USE ENDS THE TURN THE WAY A SPENT BUDGET DOES, rather than leaving
 * the loop. It used to leave. `parseConverseReply` began refusing a cut-off reply, nothing caught
 * the refusal, and a `max_tokens` stop reached the caller as a 500 under rule `unclassified`: the
 * same bucket as an unhandled crash, and it took the transcript, the recall receipts and the
 * coverage verdict with it. Those receipts are the thing this product argues it does differently.
 * `server.ts` also claims the daily budget BEFORE that call and says in a comment that it
 * deliberately does not refund, so each attempt spent a metered slot to show nothing, and
 * `temperature` is 0, so the same question kept doing it.
 *
 * WHAT THIS IS FOR, STATED AS THE ONE CASE IT IS: the provider answered, the adapter read the
 * answer, and the answer is incomplete. Everything else throws past here. `ChatUnreadableError` is
 * this build disagreeing with the API about response shape and has to be loud. `ChatTimeoutError`
 * and `ChatProviderError` are the provider not answering at all.
 *
 * THE HONEST PART, BECAUSE AN EARLIER VERSION OF THIS PARAGRAPH WAS NOT. It said a provider that is
 * down leaves "no receipt worth keeping", which is false whenever the failure lands mid-turn: a
 * timeout on round three, after two recalls have run, discards a transcript and two receipts and
 * returns a 500. That is a real loss and it stands today for a reason that is about dependencies
 * rather than about the caller. Telling a timeout from any other throw means naming the adapter's
 * error classes here, and this file is the port: `ChatResponseError` and `ChatUnreadableError` are
 * declared here precisely so the loop never imports the adapter. Moving two more classes into the
 * port to recover receipts on a case that is already loud is a change worth making deliberately,
 * with the owner, and not as a side effect of a review round. What would settle it: a mid-turn
 * timeout rate that is not near zero on the live path.
 */
function unusableReply(error: unknown, log: ((line: string) => void) | undefined): string {
  if (!(error instanceof ChatResponseError)) throw error;
  // The adapter writes this message and it quotes the stop reason the provider sent, so it goes to
  // the operator's log and never into a body. `http/failures.ts` has the long version of why a
  // string from outside is not allowed to reach a caller.
  log?.(`[agent] the model's reply could not be used: ${error.message}`);
  return REPLY_UNUSABLE;
}

/**
 * What the operator is handed for an answer turn, or null when the model gets one more round.
 *
 * Returns the TEXT rather than the whole answer, because the fields around it belong to the loop
 * and reading them from here would mean copying the loop's state at the wrong moment.
 */
function settleAnswer(
  text: string,
  transcript: Turn[],
  coverage: Coverage | null,
  alreadyRefused: boolean,
): string | null {
  const verdict = judgeAnswer(text, coverage);

  // The model's words go in the transcript FIRST, always, whether they are permitted or not. The
  // refused branch used to skip this and push the loop's own sentence under the assistant role
  // instead, which both attributed the loop's words to the model and dropped what the model
  // actually said. That is the same defect the `refusal` role exists to prevent, on the sibling of
  // the path where it was first fixed, and no test could see it because every one of them looked at
  // the FIRST refusal turn. Two rounds, two instances, one shape.
  transcript.push({ role: 'assistant', content: text });
  if (verdict.permitted) return text;

  transcript.push({ role: 'refusal', content: verdict.refusal });
  if (!alreadyRefused) return null;

  // Already refused once. Ending the turn on the refusal rather than on the answer is the safe
  // direction: a second attempt at the same claim is not a misunderstanding.
  //
  // What the OPERATOR is shown is not `verdict.refusal`. That sentence is written in the second
  // person to the model ("Rewrite it to say what you actually know"), and returning it as the
  // answer put instructions for the model on the screen meant for the person handling the incident.
  // So the returned text is deliberately NOT the last transcript turn here: the transcript records
  // the exchange, and this is what the operator reads.
  return refusalForTheUser(coverage);
}

/**
 * Write what one tool call did into the turn, and report the worst coverage seen so far.
 *
 * A turn is only as covered as its least covered recall, which is why this takes the running
 * verdict and returns the new one rather than reading the last result.
 */
function recordOutcome(
  outcome: ToolOutcome,
  call: { readonly id: string; readonly name: string },
  turn: { readonly transcript: Turn[]; readonly recalls: RecallEvent[] },
  coverageSoFar: Coverage | null,
): Coverage | null {
  // Keyed by the id the LOOP announced rather than by position, and rather than by the id the model
  // supplied, for the reason given where that id is minted.
  if (outcome.recall !== undefined) turn.recalls.push({ callId: call.id, result: outcome.recall });
  turn.transcript.push({ role: 'tool_result', id: call.id, name: call.name, content: outcome.content });
  if (outcome.coverage === undefined) return coverageSoFar;
  return worseOf(coverageSoFar, outcome.coverage);
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
