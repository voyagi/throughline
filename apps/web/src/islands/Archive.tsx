import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { getMemories, UNRECOGNISED, type ApiFailure } from '../scripts/api.ts';
import {
  describeListing,
  isUnlit,
  receiptOf,
  verdictWord,
  type ListingState,
} from '../scripts/archive-state.ts';
import { day, HOLDER, KIND_LABEL, labelled, verdictClass } from '../scripts/presentation.ts';
import { KindAgeCells } from './cells.tsx';
import type {
  ListFailureCause,
  MemoryKind,
  MemoryListReceiptView,
  MemoryListResponse,
  MemoryRowView,
  MemoryState,
} from '../scripts/types.ts';

/**
 * `/memory` is the archive, and this island is the part of it that is real rows.
 *
 * THIS IS THE PAGE A SCEPTIC OPENS to check that the console is not a recording, so the states below
 * are kept apart with more care than anywhere else on the site. Collapsing any two of them would
 * commit, on the product's own audit page, exactly the failure the product exists to argue against.
 *
 * WHICH STATE THE PAGE IS IN IS NOT DECIDED HERE. `scripts/archive-state.ts` decides it, in a pure
 * function with a test file, and this component renders what it is told. It was decided here once,
 * across two components, and an adversarial review found three defects in that seam with the suite
 * fully green: an in-flight refetch wearing the unreachable state's word with no sentence under it, a
 * rate-limited visitor told their browser could not reach the API, and this very docblock asserting
 * an invariant the code twelve lines below it contradicted.
 *
 * That last one is why this paragraph no longer states one. The states, what each means and when an
 * empty rack may be drawn are documented in `archive-state.ts` beside the code that decides them, and
 * the tests in `apps/web/test/archive-state.test.ts` are what keep the documentation honest. A
 * summary here would be a second description of one decision, free to drift from it, which is the
 * thing this repository keeps paying for.
 */

interface Props {
  readonly apiBase: string;
}

/**
 * What a listing could not do, in words written here rather than passed through from a server.
 *
 * A LOOKUP ON A VALUE, for the same reason the console's `CAUSE` table is one: the API sends a cause
 * code so that the sentence a visitor reads is authored in the browser. A database driver's message
 * can carry a schema, a table or a host, and this page renders onto a screen that gets recorded.
 */
const CAUSE: Readonly<Record<ListFailureCause, string>> = {
  listing_query_failed: 'the archive query did not complete',
  row_unreadable: 'a row could not be read, so rows would be missing without being named',
};

/** The stamp a row's own history earns it. `current` means unreplaced, NOT verified as correct. */
const STATE_STAMP: Readonly<Record<MemoryState, string>> = {
  current: 'stamp prot',
  superseded: 'stamp grey',
  tombstoned: 'stamp grey',
};

const STATE_LABEL: Readonly<Record<MemoryState, string>> = {
  current: 'Current',
  superseded: 'Superseded',
  tombstoned: 'Tombstoned',
};

const KINDS: readonly MemoryKind[] = [
  'observation',
  'resolution',
  'runbook_fact',
  'rejected_hypothesis',
  'entity_fact',
];

/**
 * One archive row.
 *
 * A tombstone keeps the tombstone holder whatever its kind, because "this row was removed" is the
 * louder fact and the kind is printed in the row below anyway. A superseded row keeps its KIND
 * colour and is dimmed instead: it was not removed, it was replaced, and the chain is only readable
 * if the two ends look related.
 *
 * NO SCORE COLUMN AND NO SIMILARITY COLUMN. Nothing ranked these rows, so the API sends neither, and
 * a column of plausible numbers on the one page that exists to be checked would be the worst
 * possible place to invent one. What is printed instead is freshness, which is honest here: it is
 * pure time decay against this kind's half-life, with no query involved.
 */
function ArchiveStrip({ memory }: { memory: MemoryRowView }) {
  const tombstoned = memory.state === 'tombstoned';
  const holder = tombstoned ? 'holder h-tomb' : (labelled(HOLDER, memory.kind) ?? 'holder');
  const retired = memory.state === 'current' ? '' : ' retired';

  return (
    <div class={memory.stale ? `strip cocked${retired}` : `strip${retired}`}>
      {/* Guarded like every lookup on this page: a kind the server adds later renders a holder with
          no colour, and on this design a colourless holder is a claim about the memory. */}
      <span class={holder}></span>
      <div>
        <div class="row r-main">
          <div class="cell">
            <b>Content</b>
            <span class={memory.stale || tombstoned ? 'say doubt' : 'say'}>{memory.content}</span>
          </div>
          <div class="cell">
            <b>State</b>
            <span class={labelled(STATE_STAMP, memory.state) ?? 'stamp grey'}>
              {labelled(STATE_LABEL, memory.state) ?? memory.state}
            </span>
          </div>
        </div>

        <div class="row r-four">
          <KindAgeCells kind={memory.kind} ageDays={memory.ageDays} halfLifeDays={memory.halfLifeDays} />
          <div class="cell">
            <b>Freshness</b>
            {/* Flagged, never hidden. A stale row a human can see is safer than one that quietly
                vanished, which is why the strip is cocked rather than dropped. */}
            <span class={memory.stale ? 'val doubt' : 'val'}>
              {memory.freshness.toFixed(2)}
              {memory.stale ? ' stale' : ''}
            </span>
          </div>
        </div>

        <div class="row r-three">
          <div class="cell">
            <b>Asserted by</b>
            <span class="val">{memory.assertedBy}</span>
          </div>
          <div class="cell">
            <b>Incident</b>
            <span class={memory.incidentId === null ? 'val doubt' : 'val'}>
              {memory.incidentId ?? 'none recorded'}
            </span>
          </div>
          <div class="cell">
            <b>Confirmed / argued with</b>
            {/* Both numbers, always. Contradiction subtracts more than confirmation adds, so showing
                only the flattering one would misrepresent the ranking. */}
            <span class="val">
              {memory.confirmations} / {memory.contradictions}
            </span>
          </div>
        </div>

        <div class="row r-three">
          <div class="cell">
            <b>Valid from</b>
            <span class="val">{day(memory.validFrom)}</span>
          </div>
          <div class="cell">
            <b>Valid until</b>
            {/* An open interval is a FACT, not a missing value, so it reads as still current rather
                than as an empty cell. */}
            <span class={memory.validUntil === null ? 'val' : 'val doubt'}>
              {memory.validUntil === null ? 'still current' : day(memory.validUntil)}
            </span>
          </div>
          <div class="cell">
            <b>Superseded by</b>
            <span class={memory.supersededBy === null ? 'val' : 'val doubt'}>
              {/* The id is truncated because a UUID at full width pushes every other cell off a
                  phone, and the first segment is enough to match one strip to another by eye. */}
              {memory.supersededBy === null ? 'nothing' : `${memory.supersededBy.slice(0, 8)}…`}
            </span>
          </div>
        </div>

        {memory.state === 'tombstoned' && (
          <div class="row r-main">
            <div class="cell">
              <b>Tombstoned</b>
              {/* The row is STILL HERE. That is the whole argument: eviction leaves a tombstone, so
                  the archive stays auditable rather than becoming shorter. */}
              <span class="say doubt">
                {memory.evictedAt === null ? 'no date recorded' : day(memory.evictedAt)}
                {' · '}
                {memory.evictionReason ?? 'no reason recorded'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The kinds in a receipt, as words. Falls back to the raw value so an unknown kind still prints. */
const kindWords = (kinds: readonly MemoryKind[]): string =>
  kinds.map((one) => labelled(KIND_LABEL, one) ?? one).join(', ');

/**
 * Which filter to name, and it is read off the RECEIPT whenever there is one.
 *
 * The button that was pressed and the filter the API applied are two different facts, and this cell
 * reports the second. They agree today; a version where they did not would show the pressed button
 * while racking rows the server chose, which is the same class of lie as a stale rack under a new
 * heading.
 */
function filterLabel(receipt: MemoryListReceiptView | null, pressed: MemoryKind | null): string {
  if (receipt === null) return pressed === null ? 'every kind' : (labelled(KIND_LABEL, pressed) ?? pressed);
  return receipt.kinds.length === 0 ? 'every kind' : kindWords(receipt.kinds);
}

/** The kind filter. `aria-pressed` carries the state for a screen reader; paper carries it visually. */
function FilterChips({
  pressed,
  onPick,
}: {
  readonly pressed: MemoryKind | null;
  readonly onPick: (kind: MemoryKind | null) => void;
}) {
  return (
    <div class="filters" role="group" aria-label="Filter the archive by kind">
      <button
        type="button"
        class={pressed === null ? 'chip on' : 'chip'}
        aria-pressed={pressed === null}
        onClick={() => onPick(null)}
      >
        Every kind
      </button>
      {KINDS.map((one) => (
        <button
          type="button"
          key={one}
          class={pressed === one ? 'chip on' : 'chip'}
          aria-pressed={pressed === one}
          onClick={() => onPick(one)}
        >
          {KIND_LABEL[one]}
        </button>
      ))}
    </div>
  );
}

/**
 * The listing's own receipt, above the rows and never below them or absent.
 *
 * A reader has to be able to see whether the listing ran before reading anything into how many
 * strips are racked. There is NO total and no denominator: nobody counted the archive, so nothing
 * here may print "of N", and PARTIAL is how a reader learns more exist.
 */
function ReceiptStrip({
  state,
  pressed,
}: {
  readonly state: ListingState;
  readonly pressed: MemoryKind | null;
}) {
  // WHICH STATE the page is in comes from `archive-state.ts`, which has a test file. What is left
  // here is presentation: which class an unlit cell takes, and what a cell says when there is no
  // receipt to read. Those are still decisions and they are still untested, so this comment no longer
  // claims the component decides nothing - it did claim that, immediately above two conditionals, in
  // the file rewritten to remove exactly that kind of false headline.
  const unlit = isUnlit(state);
  const receipt = receiptOf(state);
  return (
    <div class="strip">
      <span class={unlit ? 'holder h-tomb' : 'holder h-res'}></span>
      <div>
        <div class="row r-four">
          <div class="cell">
            <b>Verdict</b>
            <span class={receipt === null ? 'verdict v-unk' : verdictClass(receipt.coverage)}>
              {verdictWord(state)}
            </span>
          </div>
          <div class="cell">
            <b>Rows shown</b>
            <span class={unlit ? 'val doubt' : 'val'}>
              {receipt === null ? (state.kind === 'asking' ? 'asking' : 'none yet') : receipt.returned}
            </span>
          </div>
          <div class="cell">
            <b>Bound</b>
            <span class={unlit ? 'val doubt' : 'val'}>{receipt === null ? 'unknown' : `${receipt.limit} rows`}</span>
          </div>
          <div class="cell">
            <b>Filter</b>
            <span class="val">{filterLabel(receipt, pressed)}</span>
          </div>
        </div>

        {receipt !== null && (
          <div class="row r-main">
            <div class="cell">
              <b>Why</b>
              <span class={receipt.coverage === 'COVERED' ? 'say' : 'say doubt'}>
                {receipt.coverageReason}
                {receipt.coverageCause === null
                  ? ''
                  : ` · stopped by ${labelled(CAUSE, receipt.coverageCause) ?? receipt.coverageCause}`}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** One slip, in a dashed empty frame. The wrapper every state below shares. */
function Slip({
  title,
  verdict,
  children,
}: {
  readonly title: string;
  readonly verdict: string;
  readonly children: ComponentChildren;
}) {
  return (
    <div class="empty">
      <span class="holder"></span>
      <div class="slip">
        <span class="k">{title}</span>
        <div class="v">{verdict}</div>
        {children}
      </div>
    </div>
  );
}

/**
 * ONE SENTENCE PER STATE, and the state is decided in `archive-state.ts` rather than here.
 *
 * A slip renders for every state except `rows`, and the empty rack is the answer in `empty` alone.
 * `unknown` deliberately draws no rack, because an empty rack under UNKNOWN would mean nothing at all.
 *
 * `asking` and `refused` each earn their own sentence, which is the fix for two review findings: the
 * first was borrowing the unreachable state's word with no sentence at all, and the second was
 * telling a rate-limited visitor that their browser could not reach the API.
 */
function StateSlip({ state }: { readonly state: ListingState }) {
  switch (state.kind) {
    case 'rows':
      return null;

    case 'not-asked':
      return (
        <Slip title="Nothing has been asked yet" verdict="VERDICT: NOT ASKED.">
          <p>
            This page is built as static HTML long before anyone asks the database anything, so before
            it loads the honest answer is that nobody has looked. It is not an empty archive.
          </p>
        </Slip>
      );

    case 'asking':
      return (
        <Slip title="Asked, waiting" verdict="VERDICT: NOT BACK YET.">
          <p>
            The archive has been asked and has not answered yet. Nothing has gone wrong and nothing
            here is a result.
          </p>
        </Slip>
      );

    case 'unreachable':
      return (
        <Slip title="Refusal slip" verdict="THE ARCHIVE DID NOT ANSWER. VERDICT: UNKNOWN.">
          <p>{state.failure.detail}</p>
          <p>
            Nothing here says the archive is empty. The API could not be reached from this browser,
            which is a fact about the connection and not about the memory.
          </p>
        </Slip>
      );

    // TWO SENTENCES UNDER ONE STATE, because the state covers two genuinely different events. A
    // body that names its own error is the API refusing in words this console can read.
    // `UNRECOGNISED` is everything else, and the important thing about it is what it does NOT say.
    //
    // THE FIRST VERSION OF THIS BRANCH ASSERTED IT MEANT A 200, AND THAT WAS WRONG. `api.ts` mints
    // `UNRECOGNISED` at three sites and one of them sits on the `!response.ok` path, so a 429 from
    // a gateway or a 502 carrying HTML arrives here too. The branch written to stop this page
    // telling a visitor the API had refused a 200 it answered normally went on to tell a
    // rate-limited visitor that the API had NOT refused: the same false sentence pointing the other
    // way, opened by the edit that closed it, which is this repository's recurring defect committed
    // against its own fix.
    //
    // So NEITHER arm names who refused unless the answer named it. The console cannot tell them
    // apart, the detail line above already prints the status when there was one, and the claim both
    // arms keep is the only one that matters here: nothing on this screen says the archive is empty.
    case 'refused': {
      const unreadable = state.failure.error === UNRECOGNISED;
      return (
        <Slip
          title="Refusal slip"
          verdict={
            unreadable
              ? 'THIS CONSOLE COULD NOT READ THE ANSWER. VERDICT: UNKNOWN.'
              : `THE API REFUSED: ${state.failure.error.toUpperCase()}.`
          }
        >
          <p>{state.failure.detail}</p>
          <p>
            {unreadable
              ? 'The archive was reachable and it answered. This console could not read a result out of that answer, which is a fact about the response and not about the memory. Nothing here says the archive is empty.'
              : 'The API answered and refused, which is a different thing from not answering: the archive was reachable. Nothing here says it is empty.'}
          </p>
        </Slip>
      );
    }

    case 'unknown':
      return (
        <Slip title="Refusal slip" verdict="THE LISTING DID NOT COMPLETE. VERDICT: UNKNOWN.">
          <p>
            The API answered and reported that it could not read the archive
            {state.receipt.coverageCause === null
              ? ''
              : `: ${labelled(CAUSE, state.receipt.coverageCause) ?? 'an unnamed stage failed'}`}
            . An empty rack under this verdict would mean nothing at all, so there is none.
          </p>
        </Slip>
      );

    default:
      return (
        <Slip title="Nothing matched" verdict={`VERDICT: ${state.receipt.coverage}. THE LISTING RAN.`}>
          <p>
            This one IS an empty result rather than a failure: the listing completed and no row in the
            archive matches
            {state.receipt.kinds.length === 0 ? ' it' : ` the kind ${kindWords(state.receipt.kinds)}`}.
            That is a different sentence from every other slip on this page, and the difference is the
            product.
          </p>
        </Slip>
      );
  }
}

export default function Archive({ apiBase }: Props) {
  const [listing, setListing] = useState<MemoryListResponse | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [asked, setAsked] = useState(false);
  const [pending, setPending] = useState(false);
  const [kind, setKind] = useState<MemoryKind | null>(null);

  useEffect(() => {
    let live = true;
    // The previous answer is CLEARED before the new request, so a filter change cannot leave the
    // old rows on screen under the new filter's heading. That would be a rack of rows that do not
    // match what the page says it is showing.
    //
    // `pending` is tracked SEPARATELY from `asked`, and that separation is a review finding rather
    // than tidiness: clearing the answer while leaving `asked` true produced a state the page
    // labelled with the word reserved for the API not answering, with no sentence under it.
    setListing(null);
    setFailure(null);
    setPending(true);
    void getMemories(apiBase, kind === null ? [] : [kind]).then((result) => {
      if (!live) return;
      if (result.ok) setListing(result.value);
      else setFailure(result.failure);
      setAsked(true);
      setPending(false);
    });
    return () => {
      live = false;
    };
  }, [apiBase, kind]);

  const rows = listing?.memories ?? [];
  const state = describeListing({
    pending,
    asked,
    failure,
    receipt: listing?.receipt ?? null,
    rowCount: rows.length,
  });
  const receipt = receiptOf(state);

  return (
    <div class="archive">
      <div class="bayhead">
        <span class="bayno">Bay 1</span>
        <h2 class="baylabel">The archive, as it is right now</h2>
        <p class="baynote">
          Real rows from the live workspace, newest first, bounded by the API. Superseded rows and
          tombstones are shown rather than filtered out, because they are the two things this archive
          can show you that a plain vector store cannot.
        </p>
      </div>

      <FilterChips pressed={kind} onPick={setKind} />

      {/* The live region is the RECEIPT STRIP alone, not the whole rack. The rack can hold fifty
          strips of ten labelled cells each, and announcing all of it on every filter change is a
          worse experience than announcing nothing; the receipt is the part that says what happened.
          The other three islands scope their live regions the same way. */}
      <div class="rack">
        <div aria-live="polite">
          <ReceiptStrip state={state} pressed={kind} />
        </div>

        {/* THE RACK IS DRAWN IN ONE STATE, which is structural rather than tidy. This mapped the
            response's rows under EVERY state, so a slip reading "the archive could not be read" had
            that same response's rows racked directly above it, and the only thing standing between
            the page and that contradiction was a chain of reasoning across three files. `rows` is
            the one state whose meaning is that the listing ran and returned these, so it is the one
            state entitled to draw them. */}
        {state.kind === 'rows'
          ? rows.map((memory) => <ArchiveStrip key={memory.id} memory={memory} />)
          : null}

        <StateSlip state={state} />

        {/* THE `rows.length > 0` CONJUNCT IS GONE, removed rather than kept as belt and braces,
            because it became impossible to falsify. A receipt reaches this line in three states
            only: `unknown` carries UNKNOWN coverage, `empty` now always carries COVERED, since
            PARTIAL with no rows is refused as a self-contradicting body before any state is named,
            and `rows` is by definition the state that has rows. So PARTIAL here means `rows`, and
            `rows` means at least one. A conjunct that cannot be made false reads as a guard while
            guaranteeing nothing, and this repository counts the mutants that survive. */}
        {receipt !== null && receipt.coverage === 'PARTIAL' && (
          <div>
            <span class="tag">
              Bounded &middot; the archive holds more than {receipt.limit} matching rows, so these are
              the newest of them
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
