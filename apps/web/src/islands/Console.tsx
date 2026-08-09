import { useRef, useState } from 'preact/hooks';
import { postTurn, type ApiFailure } from '../scripts/api.ts';
import { clock, HOLDER, KIND_LABEL, labelled, verdictClass } from '../scripts/presentation.ts';
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

const PATH_LABEL: Readonly<Record<string, string>> = {
  ann_index: 'ANN index',
  exact_scan: 'exact scan',
  none: 'none, both paths need a query vector',
};

/** A recalled memory, as a strip in its holder. Stale rows are COCKED, never dropped or dimmed. */
function RecalledStrip({ memory }: { memory: RecalledMemoryView }) {
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
            <span class={memory.stale ? 'say doubt' : 'say'}>{memory.content}</span>
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
            <span class="val">{memory.assertedBy}</span>
          </div>
          <div class="cell">
            <b>Incident</b>
            <span class="val">{memory.incidentId ?? 'not recorded'}</span>
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
  return (
    <div class="empty">
      <span class="holder"></span>
      <div class="slip">
        <span class="k">Refusal slip &middot; {at}</span>
        <div class="v">
          {receipt.coverage === 'UNKNOWN' ? 'NO SEARCH RAN. VERDICT: UNKNOWN.' : 'SEARCH CUT SHORT. VERDICT: PARTIAL.'}
        </div>
        <div class="fields">
          <div>
            <span>QUERY</span> {receipt.query}
          </div>
          <div>
            <span>PATH</span> {labelled(PATH_LABEL, receipt.retrievalPath) ?? receipt.retrievalPath}
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
                one slip whose entire job is to carry the reason. */}
            <span>STOPPED BY</span>{' '}
            {receipt.coverageCause === null
              ? 'not recorded'
              : (labelled(CAUSE, receipt.coverageCause) ?? receipt.coverageCause)}
          </div>
          <div>
            <span>RETURNED</span> {receipt.returned}
          </div>
        </div>
        <p>
          {receipt.coverage === 'UNKNOWN'
            ? 'Nothing here says the archive is empty. The search did not run, so this question has no answer on this board.'
            : 'What is here is real but incomplete. Some of the workspace was never examined.'}
        </p>
      </div>
    </div>
  );
}

/** The receipt as the model saw it, verbatim. Instrument type inside a record, which is its cage. */
function ReceiptRecord({ content }: { content: string }) {
  return (
    <details class="receipt">
      <summary>What the agent was shown</summary>
      <pre class="mono">{content}</pre>
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
    // nothing is assumed about their shape or their type.
    const args = (turn.args ?? {}) as Record<string, unknown>;
    const content = typeof args['content'] === 'string' ? args['content'] : '(no content supplied)';
    const kind = typeof args['kind'] === 'string' ? (args['kind'] as MemoryKind) : null;
    const assertedBy = typeof args['assertedBy'] === 'string' ? args['assertedBy'] : 'not supplied';
    attempts.push({
      id: turn.id,
      content,
      kind,
      assertedBy,
      tool: turn.name,
      outcome: results.get(turn.id) ?? 'The turn ended before this tool answered.',
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
    failed.push({
      id: turn.id,
      query: typeof args['query'] === 'string' ? args['query'] : '(no query recorded)',
      reason: results.get(turn.id) ?? 'The turn ended before this search answered.',
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

  const recalls = answered.flatMap(({ at, response }) => response.recalls.map((event) => ({ at, event })));
  const found = recalls.flatMap(({ event }) => event.memories);
  const unresolved = recalls.filter(({ event }) => event.receipt.coverage !== 'COVERED');
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
  const stripCount = found.length + unresolved.length + broken.length + refusals.length + attempts.length;

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
                    <p class="said">{exchange.outcome.response.text}</p>
                    {exchange.outcome.response.recalls.map((event, index) => (
                      <span class={verdictClass(event.receipt.coverage)} key={`${exchange.at}-${index}`}>
                        {(labelled(PATH_LABEL, event.receipt.retrievalPath) ?? event.receipt.retrievalPath).toUpperCase()}{' '}
                        &middot; {event.receipt.candidatesConsidered} EXAMINED &middot;{' '}
                        {event.receipt.returned} RETURNED &middot; {event.receipt.elapsedMs} MS &middot;{' '}
                        {event.receipt.coverage}
                      </span>
                    ))}
                    {/* The TURN's verdict, which is the worst any recall returned and the thing
                        `judgeAnswer` actually gates on. It used to be rendered nowhere at all, so a
                        turn whose only recall THREW showed no verdict anywhere on the page: the
                        output of the control this product is built around was invisible. */}
                    {exchange.outcome.response.coverage !== null && (
                      <span class={verdictClass(exchange.outcome.response.coverage)}>
                        TURN COVERAGE &middot; {exchange.outcome.response.coverage}
                      </span>
                    )}
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

          {/* Keys are positional throughout this rack. The obvious identifiers are not unique: the
              local model emits the call id "recall-1" on every turn, and the same memory can be
              recalled by two questions in one session, so keying on either collapses distinct
              strips into one. */}
          {found.length > 0 && <h3 class="subbay">Recalled</h3>}
          {found.map((memory, index) => (
            <RecalledStrip memory={memory} key={`${memory.id}-${index}`} />
          ))}

          {unresolved.length > 0 && <h3 class="subbay">Unknown</h3>}
          {unresolved.map(({ at, event }, index) => (
            <UnknownSlip event={event} at={clock(at)} key={`${at}-${index}`} />
          ))}

          {refusals.length > 0 && <h3 class="subbay">Refused</h3>}
          {refusals.map((refusal, index) => (
            <div key={`refusal-${index}`}>
              <span class="tag">{refusal}</span>
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
