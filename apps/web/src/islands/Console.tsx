import { useRef, useState } from 'preact/hooks';
import { postTurn, type ApiFailure } from '../scripts/api.ts';
import { isBlank, readText, type ContradictionKind } from '../scripts/contradiction.ts';
import { clock, HOLDER, KIND_LABEL, labelled, verdictClass } from '../scripts/presentation.ts';
import { readRecall } from '../scripts/recall-state.ts';
import { KindAgeCells } from './cells.tsx';
import type {
  AgentTurnResponse,
  CoverageCause,
  MemoryKind,
  RecalledMemoryView,
  RecallEventView,
  TurnView,
} from '../scripts/types.ts';

/**
 * The console: position and board.
 *
 * Left is the R/T log, the incident conversation as a position log. Right is THE BOARD, where
 * every memory event posts a strip whose printed fields are the receipt.
 *
 * NOTHING ON THE BOARD IS PARSED OUT OF PROSE. Every strip is rendered from structured fields the
 * API sent: `recalls[].memories` for what was recalled, `recalls[].receipt` for the verdict and
 * its numbers, `tool_call` turns for what was written, and `refusal` turns for what the loop
 * refused. The transcript's rendered `tool_result` text is what the MODEL was shown, and it is
 * shown here too, verbatim, inside a record where instrument type is allowed - but it is never the
 * source of a number on a strip. A console that regex-scraped its own agent's prose would be a
 * second implementation of the receipt, free to drift from the first.
 *
 * WHEN A SEARCH DOES NOT COMPLETE, THE BOARD SAYS SO. It never renders an empty rack that looks
 * like a searched-and-found-nothing result, because that is the exact confusion this product exists
 * to remove, and committing it in the product's own console would be the loudest possible way to
 * fail.
 *
 * That sentence used to be here and was FALSE, which is worse than not having written it. A recall
 * that threw returned `recalls: []`, the rack counted zero strips, and the board printed "No strips
 * on this board yet" - identical, byte for byte, to what it prints when nobody has asked anything.
 * `failedRecalls` below is what makes the sentence true: a recall the model asked for whose id
 * never comes back in `recalls` is racked as a refusal slip, and the turn's own coverage verdict is
 * printed in the log whether or not any receipt survived.
 *
 * An API that does not answer at all is a different case again, and it is rendered in the log as a
 * named failure rather than as silence.
 */

interface Props {
  readonly apiBase: string;
}

/** One question and whatever came back, in the order they happened. */
interface Exchange {
  readonly at: string;
  readonly question: string;
  readonly outcome:
    | { readonly kind: 'pending' }
    | { readonly kind: 'answered'; readonly response: AgentTurnResponse }
    | { readonly kind: 'failed'; readonly failure: ApiFailure };
}

/**
 * What the search could not do, in the operator's words rather than the provider's.
 *
 * A LOOKUP ON A VALUE, not a sentence passed through from the server. The server sends a cause
 * code precisely so that the words shown here are written here: an error message from a database
 * driver or a model provider can carry an internal hostname or a role identifier, and this pane
 * renders straight onto a screen that gets recorded.
 */
const CAUSE: Readonly<Record<CoverageCause, string>> = {
  no_retrieval_path: 'no usable retrieval path',
  embedder_failed: 'the embedding provider did not answer',
  exclusion_counts_failed: 'the exclusion counts could not be read',
  candidate_query_failed: 'the candidate query did not complete',
  scoring_failed: 'a candidate could not be scored',
};

/**
 * The chip's words for each kind of refusal.
 *
 * A TABLE KEYED BY THE UNION, so a fourth kind fails the build rather than borrowing the wording of
 * a third. This was a two armed ternary over what turned out to be three cases, and the third case
 * silently took the second's sentence: a receipt reporting minus one memory was refused with the
 * words "its own fields disagree" when its fields agreed and one value was simply not a count.
 */
const REFUSED_CHIP: Readonly<Record<ContradictionKind, string>> = {
  malformed: 'A FIELD IS NOT A MEASUREMENT',
  internal: 'ITS OWN FIELDS DISAGREE',
  // NOT "ITS COUNT DISAGREES WITH THE STRIPS", WHICH NAMED THE ONE THING THAT WAS PROVABLY FINE. Two
  // rules carry this kind and they are different disagreements: one is the count against the rack,
  // the other is an UNKNOWN verdict over memories that arrived, and that second one is reached ONLY
  // after the count has been checked and agreed. So the chip asserted a disagreement the receipt did
  // not have, on the rule where the count matches exactly. A table keyed by the union fixed a ternary
  // that was short a case; this is the same fault one level up, in an arm that over-specifies.
  rack: 'IT DISAGREES WITH WHAT ARRIVED',
};

const PATH_LABEL: Readonly<Record<string, string>> = {
  ann_index: 'ANN index',
  exact_scan: 'exact scan',
  none: 'none, both paths need a query vector',
};

/** A recalled memory, as a strip in its holder. Stale rows are COCKED, never dropped or dimmed. */
function RecalledStrip({ memory }: { memory: RecalledMemoryView }) {
  // THE ROW'S OWN TWO WORDS, which are the memory's claim about itself rather than the receipt's
  // claim about the memory. The archive strip decides the identical thing about the identical two
  // fields; the argument for substituting rather than dropping the strip is in `contradiction.ts`
  // beside `readText`.
  //
  // NO COUNT OF WHAT IS LEFT IS CLAIMED HERE, AND ONE WAS. This called them the last two received
  // strings on this board that printed raw. Re-swept since, against every interpolation the board
  // renders, that sentence was true; it is the SPECIES that keeps being wrong, three times so far,
  // and the change that wrote it had already refused to make the same claim next door in
  // `status-state.ts` for that reason. A sentence a reader cannot check from the line it sits on is
  // what this file keeps paying for, so `contradiction.ts` records the sweep instead of the total.
  const contentIsBlank = isBlank(memory.content);
  const assertedByIsBlank = isBlank(memory.assertedBy);

  return (
    <div class={memory.stale ? 'strip cocked posted' : 'strip posted'}>
      {/* Guarded, like every other lookup on this board. A kind the server adds later would
          otherwise render a holder with NO colour, which on this design means "unlit" and is a
          claim about the memory rather than about the console. */}
      <span class={labelled(HOLDER, memory.kind) ?? 'holder'}></span>
      <div>
        <div class="row r-main">
          <div class="cell">
            <b>Content</b>
            {/* A MEMORY WITH NO BODY IS STILL RACKED, and that is the decision rather than an
                omission. Dropping the strip would take the rack below the `returned` this receipt
                counted, and `readRecall` refuses a receipt whose count disagrees with the memories
                beside it, so the board would refuse a receipt that was telling the truth. */}
            <span class={contentIsBlank || memory.stale ? 'say doubt' : 'say'}>
              {readText(memory.content, 'This memory arrived with no content.')}
            </span>
          </div>
          <div class="cell">
            <b>Score</b>
            <span class={memory.stale ? 'val doubt' : 'val'}>{memory.score.toFixed(2)}</span>
          </div>
        </div>
        <div class="row r-four">
          <KindAgeCells kind={memory.kind} ageDays={memory.ageDays} halfLifeDays={memory.halfLifeDays} />
          <div class="cell">
            <b>{memory.stale ? 'State' : 'Confirmed'}</b>
            {memory.stale ? (
              <span class="stamp cock">Cocked</span>
            ) : (
              <span class="val">{memory.confirmations}x</span>
            )}
          </div>
        </div>
        <div class="row r-three">
          <div class="cell">
            <b>Asserted by</b>
            {/* THE CLASS FOLLOWS THE WORDS, as it does on the Incident cell beside it. Provenance is
                the column that says where a memory came from, so an unmarked empty one is the worst
                cell on the board to leave looking confident. */}
            <span class={assertedByIsBlank ? 'val doubt' : 'val'}>
              {readText(memory.assertedBy, 'nobody named')}
            </span>
          </div>
          <div class="cell">
            <b>Incident</b>
            {/* THE CLASS FOLLOWS THE WORDS, because on this design the class is a claim. The archive
                twin marks a blank incident as doubt and this one printed it in the confident class,
                so two boards typed one absence two ways.
                THE WORDS THEN STILL DIFFERED, which was the same defect one layer down and it
                survived the fix that named it: the class was made to agree while this cell said "not
                recorded" and the archive's said "none recorded" about the same field, the same
                absence and the same label. It reads as "none" here now, which claims the row names
                no incident rather than leaving open whether one existed and went unwritten. */}
            <span class={isBlank(memory.incidentId ?? '') ? 'val doubt' : 'val'}>
              {readText(memory.incidentId ?? '', 'none recorded')}
            </span>
          </div>
          <div class="cell">
            <b>Similarity</b>
            <span class="val">{memory.similarity.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** An empty holder with a printed refusal slip in it: absence given a physical shape. */
function UnknownSlip({ event, at }: { event: RecallEventView; at: string }) {
  const { receipt } = event;
  // NOTHING RAN, OR IT RAN AND DID NOT FINISH, and those are different sentences. This slip said
  // NO SEARCH RAN for every UNKNOWN, and the guard beside it deliberately does NOT refuse an
  // UNKNOWN that reports a path and candidates examined, because an UNKNOWN must never be hidden.
  // The docblock in `recall-state.ts` named the wording as the honest fix for that pair and the
  // first version of this change shipped neither, which a review caught. Today's producer always
  // sends a path of `none` with nothing examined, so this reads exactly as it did before.
  const nothingRan = receipt.retrievalPath === 'none' && receipt.candidatesConsidered === 0;
  return (
    <div class="empty">
      <span class="holder"></span>
      <div class="slip">
        <span class="k">Refusal slip &middot; {at}</span>
        <div class="v">
          {receipt.coverage !== 'UNKNOWN'
            ? 'SEARCH CUT SHORT. VERDICT: PARTIAL.'
            : nothingRan
              ? 'NO SEARCH RAN. VERDICT: UNKNOWN.'
              : 'THE SEARCH DID NOT COMPLETE. VERDICT: UNKNOWN.'}
        </div>
        <div class="fields">
          <div>
            <span>QUERY</span>{' '}
            {readText(receipt.query, 'none recorded, so this slip cannot say what was searched for')}
          </div>
          <div>
            <span>PATH</span>{' '}
            {labelled(PATH_LABEL, receipt.retrievalPath) ??
              readText(receipt.retrievalPath, 'a path this receipt did not name')}
          </div>
          <div>
            <span>EXAMINED</span> {receipt.candidatesConsidered} candidates
          </div>
          <div>
            <span>ELAPSED</span> {receipt.elapsedMs} ms
          </div>
          <div>
            {/* Fallback to the raw code rather than rendering nothing. A cause the server adds
                later would otherwise print as an empty cell, which reads as "no reason" on the
                one slip whose entire job is to carry the reason. THAT FALLBACK DID THE THING IT
                WAS WRITTEN TO PREVENT for one value: a cause of pure whitespace is non-null, so it
                took this arm, and both the label lookup and the raw code printed nothing. A BLANK
                CAUSE IS NOT THE SAME FACT AS A MISSING ONE, so it does not borrow "not recorded":
                the field arrived and named no stage. */}
            <span>STOPPED BY</span>{' '}
            {receipt.coverageCause === null
              ? 'not recorded'
              : (labelled(CAUSE, receipt.coverageCause) ??
                readText(receipt.coverageCause, 'a stage this receipt did not name'))}
          </div>
          <div>
            <span>RETURNED</span> {receipt.returned}
          </div>
        </div>
        <p>
          {receipt.coverage !== 'UNKNOWN'
            ? 'What is here is real but incomplete. Some of the workspace was never examined.'
            : nothingRan
              ? 'Nothing here says the archive is empty. The search did not run, so this question has no answer on this board.'
              : // NOT "the search started". `retrievalPathFor` NAMES a path before anything executes,
                // so the negation of `nothingRan` is satisfied by a receipt that only reports a path,
                // and a review pointed out that the two halves of that negation carry very different
                // evidence. This says what the receipt shows and stops there.
                'Nothing here says the archive is empty. This search reports a path or candidates examined and still produced no usable result, so this question has no answer on this board.'}
        </p>
      </div>
    </div>
  );
}

/**
 * Every verdict one answered turn prints in the log: one chip per recall, then the turn's own.
 *
 * ONE COMPONENT BECAUSE THE TURN CHIP HAS TO KNOW WHAT THE RECALL CHIPS DECIDED, and the first
 * version of this change did not let it. It took a refused receipt's NUMBERS off this line and left
 * the turn verdict two lines below, which is not independent of them: `loop.ts` folds each recall's
 * own coverage into `worstCoverage` with `worseOf`, and `server.ts` ships that as
 * `response.coverage`, so for a single recall turn it IS the refused receipt's word. The board
 * declared that receipt unbelievable and the log printed COVERED underneath, in the green class,
 * next to an UNKNOWN one. COVERED is the verdict that licenses an absence claim, which makes it the
 * worst possible field to have left behind.
 *
 * SO A REFUSED RECEIPT SUPPRESSES THE TURN'S VERDICT, unless the turn already reports UNKNOWN.
 * `worseOf` takes the worst of the recalls, so UNKNOWN is the one value a refused input cannot have
 * flattered, and it is the verdict this product exists to show: passing it through is both safe and
 * required. Anything better than UNKNOWN may be resting on the receipt just refused, and there is
 * no way from here to tell whether it is.
 */
function TurnVerdicts({ at, response }: { readonly at: string; readonly response: AgentTurnResponse }) {
  const strips = response.recalls.map(readRecall);
  // BOTH WAYS A SEARCH IN THIS TURN CAN LEAVE NO READABLE RECEIPT, and the first version counted
  // one. A recall whose arguments failed the schema, or that arrived after the tool budget was
  // spent, never produces a receipt and never reaches `worseOf`, so it is excluded from the turn's
  // verdict entirely while the board racks a slip saying the search did not complete. The comment
  // justifying the suppression said there is no way from here to tell, and for THIS case there is:
  // `failedRecalls` derives it by call id, and the board already draws it.
  const unreadable =
    strips.some((strip) => strip.kind === 'refused') ||
    failedRecalls(response.transcript, response.recalls).length > 0;
  return (
    <>
      {strips.map((strip, index) =>
        strip.kind === 'refused' ? (
          <span class={verdictClass('UNKNOWN')} key={`${at}-${index}`}>
            RECEIPT REFUSED &middot; {REFUSED_CHIP[strip.contradiction]}
          </span>
        ) : (
          <span class={verdictClass(strip.event.receipt.coverage)} key={`${at}-${index}`}>
            {(
              labelled(PATH_LABEL, strip.event.receipt.retrievalPath) ??
              readText(strip.event.receipt.retrievalPath, 'a path this receipt did not name')
            ).toUpperCase()}{' '}
            &middot; {strip.event.receipt.candidatesConsidered} EXAMINED &middot;{' '}
            {strip.event.receipt.returned} RETURNED &middot; {strip.event.receipt.elapsedMs} MS &middot;{' '}
            {strip.event.receipt.coverage}
          </span>
        ),
      )}
      {/* The TURN's verdict, which is the worst any recall returned and the thing `judgeAnswer`
          actually gates on. It used to be rendered nowhere at all, so a turn whose only recall
          THREW showed no verdict anywhere on the page: the output of the control this product is
          built around was invisible. */}
      {response.coverage !== null &&
        (unreadable && response.coverage !== 'UNKNOWN' ? (
          // THE WORD IS STILL PRINTED, and suppressing it was the first fix's own defect. COVERED
          // is the only verdict `judgeAnswer` accepts as licence for an absence claim, so a turn
          // that reported COVERED while carrying an unreadable receipt is exactly the turn a
          // sceptic needs to see, and hiding the word traded an overclaim for a silence. It is
          // printed as WHAT ARRIVED rather than as this turn's verdict, in the unlit class.
          //
          // The sentence says only what this console can see: a search in this turn has no receipt
          // it could read. It does NOT say the refused receipt fed the fold, which was the previous
          // wording and is a claim about how the API computed a value, asserted about a body this
          // board has just concluded did not come from that API.
          <span class={verdictClass('UNKNOWN')}>
            TURN COVERAGE &middot; REPORTED {response.coverage}, NOT USABLE: A SEARCH IN THIS TURN HAS
            NO RECEIPT THIS BOARD COULD READ
          </span>
        ) : (
          <span class={verdictClass(response.coverage)}>TURN COVERAGE &middot; {response.coverage}</span>
        ))}
    </>
  );
}

/**
 * The receipt as the model saw it, verbatim. Instrument type inside a record, which is its cage.
 *
 * THE THIRD READER OF `tool_result.content`, and the sweep guarded the other two first. A blank one
 * drew the `Receipts, verbatim` heading over a disclosure labelled "What the agent was shown" that
 * opens onto nothing, while the same field read by `writeAttempts` says "This tool answered with
 * nothing at all." One field, three readers, and two of them honest is the shape this repository
 * keeps paying for. (That citation gave a line distance, and it was wrong by more than three times
 * over on the tree that carried it. No distance is quoted in its place and none should be: the
 * function is named instead, which is the one locator an insertion above it cannot falsify.)
 *
 * SUBSTITUTED RATHER THAN SUPPRESSED. Dropping the record when it is blank would take the heading
 * with it and hide that the agent was shown something empty, which is a fact about the turn worth
 * seeing. VERBATIM SURVIVES for every value that has anything in it.
 */
function ReceiptRecord({ content }: { content: string }) {
  return (
    <details class="receipt">
      <summary>What the agent was shown</summary>
      <pre class="mono">{readText(content, 'This receipt came back with nothing in it.')}</pre>
    </details>
  );
}

interface WriteAttempt {
  readonly id: string;
  readonly content: string;
  readonly kind: MemoryKind | null;
  readonly assertedBy: string;
  readonly tool: string;
  /** What the tool ACTUALLY answered. Absent only if the turn ended before the result was recorded. */
  readonly outcome: string;
}

/**
 * Every write the model ASKED for, with what the tool answered.
 *
 * THE BAY IS NOT CALLED "WRITTEN", and that is the second correction here. The first version
 * collected these calls and racked them under a heading that claimed they had happened. A tool call
 * whose arguments the schema REFUSED is still in the transcript, so a `remember` with an invented
 * kind and no provenance posted a strip announcing a memory that was never stored, under a
 * hardcoded protection window the API never sent. On the one page whose argument is that you can
 * check what the agent did, that is the worst possible thing to get wrong.
 *
 * So each attempt carries the tool's own answer, verbatim, and the reader sees a refusal as a
 * refusal. A structured write receipt, the way `recalls` is structured, is the real fix and it
 * needs an API change; until then this says only what it can prove.
 *
 * `assertedBy` is read from the TOP LEVEL of the arguments because that is where `rememberSchema`
 * puts it. The first version read `args.provenance.assertedBy`, a shape the wire format does not
 * have, so every strip printed "not supplied" for provenance that had in fact been supplied.
 */
function writeAttempts(transcript: readonly TurnView[]): readonly WriteAttempt[] {
  const results = new Map<string, string>();
  for (const turn of transcript) {
    if (turn.role === 'tool_result') results.set(turn.id, turn.content);
  }

  const attempts: WriteAttempt[] = [];
  for (const turn of transcript) {
    if (turn.role !== 'tool_call') continue;
    if (turn.name !== 'remember' && turn.name !== 'supersede') continue;
    // Read defensively: this is the one place on the board fed by values the MODEL chose, so
    // nothing is assumed about their shape or their type. ALL FOUR VALUES HERE WERE BLANK
    // VULNERABLE, three through a TYPE test and the fourth through a NULLISH read, and neither kind
    // of test is an emptiness test: `'   '` is a string and is not nullish, so it walked past both
    // and printed a labelled cell with nothing in it. Blank is folded into the substitute the
    // missing value already had, because a `content` of pure whitespace supplies no content either.
    //
    // THE FIRST VERSION OF THIS COMMENT SAID THREE AND CONVERTED TWO, leaving `kind` behind under a
    // sentence claiming it was done. Two reviewers found it independently. `kind` cannot go through
    // `readText`, whose return type is a string, so it folds blank into the NULL that the cell and
    // the holder already have words for.
    const args = (turn.args ?? {}) as Record<string, unknown>;
    const content = readText(typeof args['content'] === 'string' ? args['content'] : '', '(no content supplied)');
    const kind = typeof args['kind'] === 'string' && !isBlank(args['kind']) ? (args['kind'] as MemoryKind) : null;
    const assertedBy = readText(typeof args['assertedBy'] === 'string' ? args['assertedBy'] : '', 'not supplied');
    // THE ANSWER IS THE ONE FIELD WHOSE TWO ABSENCES ARE DIFFERENT FACTS, so it does not reuse the
    // sentence above it. No entry means the turn ended first. A blank entry means the tool ANSWERED
    // and said nothing, and printing "the turn ended before this tool answered" over that would be
    // this board reporting a sequence of events that did not happen.
    const answer = results.get(turn.id);
    attempts.push({
      id: turn.id,
      content,
      kind,
      assertedBy,
      tool: turn.name,
      outcome:
        answer === undefined
          ? 'The turn ended before this tool answered.'
          : readText(answer, 'This tool answered with nothing at all.'),
    });
  }
  return attempts;
}

/**
 * Recalls the model asked for that produced NO receipt, which means the search threw.
 *
 * THIS EXISTS BECAUSE ITS ABSENCE WAS THE PRODUCT'S OWN HEADLINE FAILURE, committed in the
 * product's own console. A recall that throws returns `recalls: []`, so the board had nothing to
 * rack and rendered "No strips on this board yet" - byte for byte what it renders when nobody has
 * asked anything at all. A search that broke and a question never asked looked identical on the
 * one screen built to keep them apart.
 *
 * A `tool_call` named recall whose id never appears in `recalls` is exactly that case, and it is
 * derived by id rather than by counting, so a turn that recalled twice and lost one still shows
 * the one it lost.
 */
function failedRecalls(
  transcript: readonly TurnView[],
  completed: readonly RecallEventView[],
): readonly { id: string; query: string; reason: string }[] {
  const done = new Set(completed.map((event) => event.callId));
  const results = new Map<string, string>();
  for (const turn of transcript) {
    if (turn.role === 'tool_result') results.set(turn.id, turn.content);
  }

  const failed: { id: string; query: string; reason: string }[] = [];
  for (const turn of transcript) {
    if (turn.role !== 'tool_call' || turn.name !== 'recall' || done.has(turn.id)) continue;
    const args = (turn.args ?? {}) as Record<string, unknown>;
    // THE SIBLING OF `writeAttempts`, GUARDED THE SAME WAY AND FOR THE SAME REASON. Both build the
    // same map off the same `tool_result` turns, so the same CLASS of value reaches both readers,
    // each on its own tool's ids. (Not the same VALUE: this one reads `recall` ids and that one
    // reads `remember` and `supersede`, so no single blank result is read by both, and a test over
    // one of them proves nothing about the other.)
    const answer = results.get(turn.id);
    failed.push({
      id: turn.id,
      query: readText(typeof args['query'] === 'string' ? args['query'] : '', '(no query recorded)'),
      reason:
        answer === undefined
          ? 'The turn ended before this search answered.'
          : readText(answer, 'This search answered with nothing at all.'),
    });
  }
  return failed;
}

export default function Console({ apiBase }: Props) {
  const [exchanges, setExchanges] = useState<readonly Exchange[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const logEnd = useRef<HTMLDivElement>(null);

  const send = async (event: Event) => {
    event.preventDefault();
    const question = draft.trim();
    if (question.length === 0 || busy) return;

    const at = new Date().toISOString();
    setBusy(true);
    setDraft('');
    setExchanges((previous) => [...previous, { at, question, outcome: { kind: 'pending' } }]);

    const result = await postTurn(apiBase, question);

    setExchanges((previous) =>
      previous.map((exchange) =>
        exchange.at === at && exchange.question === question
          ? {
              ...exchange,
              outcome: result.ok
                ? { kind: 'answered' as const, response: result.value }
                : { kind: 'failed' as const, failure: result.failure },
            }
          : exchange,
      ),
    );
    setBusy(false);
    logEnd.current?.scrollIntoView({ block: 'end' });
  };

  const answered = exchanges.flatMap((exchange) =>
    exchange.outcome.kind === 'answered' ? [{ at: exchange.at, response: exchange.outcome.response }] : [],
  );

  // EVERY RECALL IS READ THROUGH `readRecall` BEFORE ANY OF IT IS DRAWN, and the strips a refused
  // one carries are never racked. The board used to print `receipt.returned` in the log and rack
  // `event.memories` on the right with nothing comparing them, which is the same defect the archive
  // page was fixed for, on the page this product demonstrates itself on. The decision lives in
  // `recall-state.ts` so it can be tested without mounting anything, and the log below calls the
  // same function on the same event rather than repeating the test.
  const recalls = answered.flatMap(({ at, response }) =>
    response.recalls.map((event) => ({ at, strip: readRecall(event) })),
  );
  const shown = recalls.flatMap(({ at, strip }) => (strip.kind === 'shown' ? [{ at, event: strip.event }] : []));
  const contradicting = recalls.flatMap(({ at, strip }) => (strip.kind === 'refused' ? [{ at, strip }] : []));
  const found = shown.flatMap(({ event }) => event.memories);
  const unresolved = shown.filter(({ event }) => event.receipt.coverage !== 'COVERED');
  const refusals = answered.flatMap(({ response }) =>
    response.transcript.flatMap((turn) => (turn.role === 'refusal' ? [turn.content] : [])),
  );
  const attempts = answered.flatMap(({ response }) => writeAttempts(response.transcript));
  const broken = answered.flatMap(({ at, response }) =>
    failedRecalls(response.transcript, response.recalls).map((one) => ({ at, ...one })),
  );
  const receipts = answered.flatMap(({ response }) =>
    response.transcript.flatMap((turn) =>
      turn.role === 'tool_result' && turn.name === 'recall' ? [turn.content] : [],
    ),
  );
  const latest = answered.at(-1);
  // `contradicting` COUNTS, and leaving it out would be the defect this whole change is about. An
  // empty board prints "Every search this session completed and matched nothing. Under a COVERED
  // verdict that is a real absence", which is the page's most confident sentence, and a refused
  // receipt is the last thing that may sit under it.
  const stripCount =
    found.length + unresolved.length + broken.length + refusals.length + attempts.length + contradicting.length;

  return (
    <div class="split">
      <section class="log" aria-label="R/T log">
        <div class="panehead">
          <h2>R/T log</h2>
          <span>{exchanges.length === 0 ? 'ON POSITION' : `${exchanges.length} EXCHANGES`}</span>
        </div>

        <div aria-live="polite">
          {exchanges.length === 0 && (
            <article class="utt">
              <time>--:--:--</time>
              <div>
                <p class="who">Throughline</p>
                <p class="said">
                  Ask about a past incident. Every answer arrives with the receipt that produced it, and
                  when the search cannot run you will get UNKNOWN rather than a confident nothing.
                </p>
              </div>
            </article>
          )}

          {exchanges.map((exchange) => (
            <div key={exchange.at}>
              <article class="utt op">
                <time>{clock(exchange.at)}</time>
                <div>
                  <p class="who">On call</p>
                  <p class="said">{exchange.question}</p>
                </div>
              </article>

              {exchange.outcome.kind === 'pending' && (
                <article class="utt">
                  <time>{clock(exchange.at)}</time>
                  <div>
                    <p class="who">Throughline</p>
                    <p class="said">
                      <em>Recalling.</em>
                    </p>
                  </div>
                </article>
              )}

              {exchange.outcome.kind === 'failed' && (
                <article class="utt">
                  <time>{clock(exchange.at)}</time>
                  <div>
                    <p class="who">Throughline</p>
                    <p class="said">
                      <em>{exchange.outcome.failure.detail}</em>
                    </p>
                    <span class="verdict v-unk">{exchange.outcome.failure.error.toUpperCase()}</span>
                  </div>
                </article>
              )}

              {exchange.outcome.kind === 'answered' && (
                <article class="utt">
                  <time>{clock(exchange.at)}</time>
                  <div>
                    <p class="who">Throughline</p>
                    {/* THE ONE FREE TEXT FIELD THE LOOP NEITHER AUTHORS NOR VALIDATES, and the sweep
                        that closed every other blank on this page walked past it twice.
                        `TURN_CHECKS.text` is a bare `isString`, `loop.ts` copies the model's reply
                        into it verbatim, and `judgeAnswer` deliberately does not police length, so a
                        model answering with whitespace drew a speaker with nothing said, directly
                        above a TURN COVERAGE chip in the green class. Every other blank on this
                        board needs a body this API does not produce. This one does not.
                        NOT "DOES NOT AUTHOR", WHICH IS WHAT THIS SAID AND WAS FALSE. A recalled
                        memory's `content` and `assertedBy` are not authored by the loop either;
                        they are read back out of the store. The difference is that the write
                        schemas trim those two and refuse them empty, and nothing trims this one. */}
                    <p class="said">
                      {readText(
                        exchange.outcome.response.text,
                        'This turn came back with no answer in it. What the search did is on the board.',
                      )}
                    </p>
                    <TurnVerdicts at={exchange.at} response={exchange.outcome.response} />
                    {exchange.outcome.response.refusedAnAbsenceClaim && (
                      <p class="said">
                        <em>
                          An answer was refused during this turn for claiming an absence the search had not
                          established. The refusal is on the board.
                        </em>
                      </p>
                    )}
                  </div>
                </article>
              )}
            </div>
          ))}
          <div ref={logEnd}></div>
        </div>

        <form class="composer" onSubmit={send}>
          <div>
            <label for="say">Transmit</label>
            <input
              class="field"
              id="say"
              name="say"
              type="text"
              autocomplete="off"
              maxLength={4000}
              placeholder="Checkout p99 went from 180 ms to 4.2 s. Have we seen this before?"
              value={draft}
              disabled={busy}
              onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
            />
          </div>
          <button class="btn" type="submit" disabled={busy} aria-busy={busy ? 'true' : 'false'}>
            {busy ? 'Recording' : 'Send and record'}
          </button>
        </form>
      </section>

      <div class="slot" aria-hidden="true">
        <span class="slotlabel">Printer</span>
      </div>

      <section aria-label="The board">
        <div class="panehead">
          <h2>The board</h2>
          <span>
            {latest === undefined
              ? 'NOTHING POSTED'
              : `LIVE · ${clock(latest.at)} · ${stripCount} ${stripCount === 1 ? 'STRIP' : 'STRIPS'}`}
          </span>
        </div>

        <div class="rack live">
          {stripCount === 0 &&
            (answered.length === 0 ? (
              <p class="baynote">No strips on this board yet. The first incident posts the first one.</p>
            ) : (
              // A search that RAN and matched nothing is a real absence, and it is the one state
              // that legitimately racks no strips. It gets its own sentence rather than the
              // never-asked one, because "nothing was found" and "nothing was asked" are the two
              // facts this entire product exists to keep apart.
              <p class="baynote">
                Every search this session completed and matched nothing. Under a COVERED verdict
                that is a real absence, not a gap in the board.
              </p>
            ))}

          {/* Keys are positional throughout this rack. The obvious identifiers are not unique: a
              call id is unique WITHIN a turn and the loop mints it per turn, so the first call of
              every turn is "tc-1", and the same memory can be recalled by two questions in one
              session, so keying on either collapses distinct strips into one. This used to name the
              local model's "recall-1", which is no longer the id anything joins on. It still
              travels, in `given`, which this page does not read. The conclusion did not change,
              because the minted id repeats across turns exactly as the old one did. */}
          {found.length > 0 && <h3 class="subbay">Recalled</h3>}
          {found.map((memory, index) => (
            <RecalledStrip memory={memory} key={`${memory.id}-${index}`} />
          ))}

          {unresolved.length > 0 && <h3 class="subbay">Unknown</h3>}
          {unresolved.map(({ at, event }, index) => (
            <UnknownSlip event={event} at={clock(at)} key={`${at}-${index}`} />
          ))}

          {contradicting.length > 0 && <h3 class="subbay">Receipts this board refused</h3>}
          {contradicting.map(({ at, strip }, index) => (
            <div class="empty" key={`contradiction-${index}`}>
              <span class="holder"></span>
              <div class="slip">
                <span class="k">Refusal slip &middot; {clock(at)}</span>
                <div class="v">RECEIPT REFUSED. VERDICT: UNKNOWN.</div>
                <div class="fields">
                  {/* THE QUERY THE RECEIPT CLAIMS, labelled as exactly that. Without it a reader
                      cannot tell which of the turn's searches was refused, but it is still a field
                      off a receipt this board has just called unbelievable, and the transcript
                      holds an independent copy of what the model asked keyed by the same call id.
                      Printing it as "QUERY" would present the refused receipt's word as the
                      question, which is the one overclaim this slip had left. Every measurement is
                      withheld: they are what could not be believed. */}
                  <div>
                    <span>QUERY THE RECEIPT CLAIMS</span>{' '}
                    {readText(strip.event.receipt.query, 'none, this receipt records no query')}
                  </div>
                  <div>
                    <span>MEASUREMENTS</span> none, because nothing on this receipt can be read as one
                  </div>
                </div>
                <p>{strip.failure.detail}</p>
                <p>
                  Nothing here says the memory is empty. A receipt that cannot be read as one
                  consistent statement gives no reason to believe any part of it, so this board
                  prints none of its measurements rather than choosing the comfortable ones.
                </p>
              </div>
            </div>
          ))}

          {refusals.length > 0 && <h3 class="subbay">Refused</h3>}
          {/* A REFUSAL IS COUNTED IN `stripCount`, so a blank one is a strip the header promises and
              the rack does not draw: an empty chip under a heading saying the loop refused
              something. `TURN_ROLE_CHECKS.refusal` checks `content` as a bare string. */}
          {refusals.map((refusal, index) => (
            <div key={`refusal-${index}`}>
              <span class="tag">{readText(refusal, 'A refusal was recorded with no words in it.')}</span>
            </div>
          ))}

          {broken.length > 0 && <h3 class="subbay">The search that did not run</h3>}
          {broken.map((one, index) => (
            <div class="empty" key={`broken-${index}`}>
              <span class="holder"></span>
              <div class="slip">
                <span class="k">Refusal slip &middot; {clock(one.at)}</span>
                {/* NOT "the search threw". Three different things produce no receipt: the recall
                    threw, its arguments failed the schema, or the turn's tool budget was already
                    spent. Only the first is a throw, and naming the wrong one on a slip whose job
                    is to say what happened would be the same overclaim this board exists to
                    refuse. The tool's own answer is printed below and says which. */}
                <div class="v">NO RECEIPT. THIS SEARCH DID NOT COMPLETE.</div>
                <div class="fields">
                  <div>
                    <span>QUERY</span> {one.query}
                  </div>
                  <div>
                    <span>RECEIPT</span> none, so nothing about coverage can be said
                  </div>
                </div>
                <p>{one.reason}</p>
                <p>
                  This is not an empty result. The board has nothing to rack for this question, and
                  that is a different fact from the archive having nothing in it.
                </p>
              </div>
            </div>
          ))}

          {attempts.length > 0 && <h3 class="subbay">Writes the agent asked for</h3>}
          {attempts.map((entry, index) => (
            <div class="strip posted" key={`attempt-${index}`}>
              <span class={entry.kind === null ? 'holder' : (labelled(HOLDER, entry.kind) ?? 'holder')}></span>
              <div>
                <div class="row r-main">
                  <div class="cell">
                    <b>Content</b>
                    <span class="say">{entry.content}</span>
                  </div>
                  <div class="cell">
                    <b>Tool</b>
                    <span class="val">{entry.tool.toUpperCase()}</span>
                  </div>
                </div>
                <div class="row r-three">
                  <div class="cell">
                    <b>Kind</b>
                    <span class="val">
                      {entry.kind === null ? 'not supplied' : (labelled(KIND_LABEL, entry.kind) ?? entry.kind)}
                    </span>
                  </div>
                  <div class="cell">
                    <b>Asserted by</b>
                    <span class="val">{entry.assertedBy}</span>
                  </div>
                  <div class="cell">
                    <b>What the tool answered</b>
                    <span class="say">{entry.outcome}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {receipts.length > 0 && <h3 class="subbay">Receipts, verbatim</h3>}
          {receipts.map((content, index) => (
            <ReceiptRecord content={content} key={`${index}-${content.length}`} />
          ))}
        </div>
      </section>
    </div>
  );
}
