import { UNREACHABLE, UNRECOGNISED } from './api.ts';
import type { FailureResponse, MemoryListReceiptView } from './types.ts';

/**
 * What the archive page is currently able to say, as one value.
 *
 * A PURE FUNCTION IN ITS OWN MODULE, and it is here rather than inline in the island for the reason
 * `scripts/lib/advisories.mjs` was split out of its runner: a decision that cannot be tested without
 * mounting something does not get tested. `Archive.tsx` enumerated four states in a docblock and
 * then decided between them with conditions spread across two components, and an adversarial review
 * found THREE defects in exactly that seam, all of them invisible to a fully green suite:
 *
 *   - an in-flight refetch rendered the word reserved for the API not answering, with no sentence
 *     under it at all, because clearing the previous answer left `asked` true;
 *   - every API refusal, including a 429 the visitor causes by clicking filter chips, was rendered
 *     as "the API could not be reached from this browser", which is false;
 *   - the file's own headline claim about when an empty rack may be drawn contradicted the code
 *     twelve lines further down.
 *
 * So the decision is one function returning one discriminated value, and it has a test file. The
 * island renders what this says and decides nothing.
 *
 * SEVEN STATES, NOT FOUR. The four the page always meant to keep apart are still here; the review
 * found that `asking` and `refused` were being borrowed from their neighbours rather than named.
 * Every one of them gets its own word and its own sentence, because the entire argument of this
 * product is that "nothing found" and "could not look" are different claims, and a page that blurs
 * them while making that argument would be the loudest possible way to fail.
 */

export type ListingState =
  /** The static HTML, before hydration. Nobody has looked yet. */
  | { readonly kind: 'not-asked' }
  /** A request is open. Distinct from every failure: nothing has gone wrong, it is not back yet. */
  | { readonly kind: 'asking' }
  /** The API could not be reached. Says nothing about what the archive holds. */
  | { readonly kind: 'unreachable'; readonly failure: FailureResponse }
  /**
   * The request came back and no result can be read out of it. TWO EVENTS, not one: the API
   * refusing in words this console can read (rate limited, an unknown kind, an internal error), and
   * an answer this console cannot read a result out of at all, which carries `UNRECOGNISED` and may
   * be any status. `Archive.tsx` words the slip for both without claiming which one happened,
   * because the second case does not say. This comment named only the first and was the claim the
   * slip was corrected for.
   */
  | { readonly kind: 'refused'; readonly failure: FailureResponse }
  /** The API answered and reported that the listing could not be completed. */
  | { readonly kind: 'unknown'; readonly receipt: MemoryListReceiptView }
  /** The listing ran and matched nothing. The ONLY state where an empty rack is the answer. */
  | { readonly kind: 'empty'; readonly receipt: MemoryListReceiptView }
  /** The listing ran and returned rows. */
  | { readonly kind: 'rows'; readonly receipt: MemoryListReceiptView };

export interface ListingInput {
  /** True while a request is open, including a refetch after a filter change. */
  readonly pending: boolean;
  /** True once any request has completed. False only before the first one returns. */
  readonly asked: boolean;
  readonly failure: FailureResponse | null;
  readonly receipt: MemoryListReceiptView | null;
  readonly rowCount: number;
}

/**
 * Decide in one place, most specific first.
 *
 * TRACKING `pending` AT ALL is the fix for the in-flight defect, and an earlier version of this
 * comment credited the ORDER of the two tests instead. Then it over-corrected, saying the two lines
 * could be swapped without changing any outcome. THAT WAS TRUE OF THE OLD CODE AND FALSE OF THIS,
 * and the same commit that wrote the sentence is the one that falsified it. Swapping them now fails
 * `reports ASKING on a slow FIRST load rather than "nobody has looked"` with
 * `expected 'not-asked' to be 'asking'`. These two lines are ORDER DEPENDENT: `pending` has to be
 * read first, or a slow first load reports NOT ASKED while a request is open.
 *
 * An open request wins outright, including the FIRST one. It used to require `asked`, so a slow first
 * load displayed "nobody has looked" for the whole eight second timeout while a request was in flight,
 * which is a different claim from the true one. Before the effect runs nothing is pending and nothing
 * has been asked, so the static HTML is still NOT ASKED.
 *
 * An empty rack is drawn for `empty` alone; `unknown` deliberately draws none, because an empty rack
 * under UNKNOWN would mean nothing at all.
 */
export function describeListing(input: ListingInput): ListingState {
  if (input.pending) return { kind: 'asking' };
  if (!input.asked) return { kind: 'not-asked' };

  if (input.failure !== null) {
    // Only `api_unreachable` means the connection failed. Everything else is the API answering, and
    // saying otherwise misattributes the demo's own rate limit to the visitor's network.
    return input.failure.error === UNREACHABLE
      ? { kind: 'unreachable', failure: input.failure }
      : { kind: 'refused', failure: input.failure };
  }

  // A SETTLED REQUEST CARRYING NEITHER IS A REFUSAL, NOT A WAIT, and this branch is the one a review
  // caught being both wrong and documented as impossible. `getMemories` guards the response shape now,
  // so this should be unreachable through it - but "should be unreachable" is exactly the sentence
  // that was here before, asserting the same thing, while a 200 carrying `{}` produced this state and
  // the page answered "asked, waiting: nothing has gone wrong" forever.
  //
  // So the fallback no longer reassures. If this is ever reached the page says the API answered in a
  // shape it cannot read, which is true whatever produced it, and which is the honest thing to say
  // about a state nobody expected. A defensive branch that renders calm is not defensive.
  if (input.receipt === null) {
    return {
      kind: 'refused',
      failure: {
        error: UNRECOGNISED,
        detail: 'The archive answered in a shape this console cannot read, so nothing here is a result.',
      },
    };
  }

  // A RECEIPT THAT DISAGREES WITH THE ROWS BESIDE IT IS NOT A STATE OF THE ARCHIVE. Reading one as
  // though it were is how this page ends up arguing with itself, in public, on the screen a sceptic
  // opens to check the rest. `receiptContradiction` enumerates the ways, field by printed field.
  const contradiction = receiptContradiction(input.receipt, input.rowCount);
  if (contradiction !== null) {
    return {
      kind: 'refused',
      failure: {
        error: UNRECOGNISED,
        detail:
          `The archive answered with a receipt that contradicts the rows beside it: ${contradiction}. ` +
          'Nothing here is a result.',
      },
    };
  }

  if (input.receipt.coverage === 'UNKNOWN') return { kind: 'unknown', receipt: input.receipt };
  if (input.rowCount === 0) return { kind: 'empty', receipt: input.receipt };
  return { kind: 'rows', receipt: input.receipt };
}

/** `1 row` or `N rows`, so a contradiction reads as a sentence rather than as a bare count. */
const rowsPhrase = (count: number): string => (count === 1 ? '1 row' : `${count} rows`);

/**
 * Which way a receipt and the rows beside it disagree, as a phrase, or null when they agree.
 *
 * WHY A BODY CAN BE REFUSED FOR WHAT IT MEANS RATHER THAN FOR ITS TYPES. `shapes.ts` checks one
 * field at a time, by design, so it accepts a body whose fields are each valid and jointly
 * impossible. This page prints five receipt fields, and a body can make any of them argue with what
 * is on screen beside it.
 *
 * THE LIST BELOW IS THE ENUMERATION, NOT A SAMPLE, and the difference is the whole reason this
 * paragraph is written this way. The first version of this function closed three cases and called
 * them "the three ways it can happen". A review counted the printed fields and found two more, one
 * of which was the same defect the function was written to close, one row-count short: `PARTIAL`
 * with SOME rows but fewer than the bound. Closing an instance and naming it a class is this
 * repository's most expensive recurring mistake.
 *
 *   0. A bound below one, or a fractional one. The `Bound` cell prints it, and a listing that could
 *      hold no row cannot support any sentence about what matched.
 *   1. UNKNOWN carrying rows. The slip says the archive could not be read, while rows sit racked
 *      under it as though they were the archive.
 *   2. A cause without UNKNOWN. `coverageCause` names the stage that STOPPED a listing, and the
 *      producer sets one only alongside UNKNOWN. COVERED with a cause prints "the listing completed
 *      and no row in the archive matches" with "stopped by the archive query did not complete" six
 *      lines above it, which is the absence claim contradicted in the same breath.
 *   3. PARTIAL whose rows are not exactly the bound. PARTIAL is measured by asking for one row more
 *      than the bound, so a PARTIAL page always carries EXACTLY `limit` rows. Anything else prints
 *      the tag "the archive holds more than {limit} matching rows, so these are the newest of them"
 *      over a rack that is not the newest `limit` of anything. Zero rows is the loudest instance and
 *      was the only one the first version caught.
 *   4. More rows than the bound. Only reachable under COVERED once 1 and 3 are settled, and the
 *      `Bound` cell is printed directly beside the rack it contradicts.
 *   5. `returned` disagreeing with the rows. The receipt strip prints `receipt.returned` while the
 *      rack renders the array, so a body where those differ prints a count that argues with the
 *      strips below it.
 *
 * `kinds` is deliberately NOT here: a receipt whose filter disagrees with a row's kind is pinned as
 * intended behaviour by `archive-island.test.ts`, because the page's job there is to show what
 * arrived rather than to hide it. `coverageReason` is free text and not machine-checkable, and
 * `requestedAt` and `elapsedMs` are not printed at all.
 *
 * NONE OF THESE IS REACHABLE FROM THIS PROJECT'S OWN API, and each was read rather than assumed.
 * `runList` reaches UNKNOWN only through `emptyUnknownPage`, which hardcodes `memories: []`,
 * `returned: 0` and the only non-null cause in the file. Its success path hardcodes `coverageCause:
 * null` and sets PARTIAL from `rows.length > limit`, where `memories` is `rows.slice(0, limit)`, so
 * PARTIAL always carries exactly `limit` rows and `boundedLimit` now floors that bound to at least
 * one. `returned` is `memories.length` at the source, copied field for field by
 * `toMemoryListReceipt` and mapped one for one by the `/memories` handler. So this guard cannot fire
 * on a conforming answer: everything that reaches it came from something that is not this API.
 *
 * REFUSED RATHER THAN REPAIRED. The tempting alternative is to keep the more cautious half and
 * render that, but there is no honest way to pick: a receipt that contradicts its own rows gives no
 * reason to believe either half of itself. `unrecognised_response` is the verdict this file already
 * returns for a settled answer carrying no receipt, and it says the one true thing available, which
 * is that nothing on the screen is a result.
 */
function receiptContradiction(receipt: MemoryListReceiptView, rowCount: number): string | null {
  // FIRST, because the two rules that DO compare against this bound, PARTIAL-not-the-bound and
  // too-many-rows, are meaningless rather than false when it is not a whole number of rows. (The
  // first version of this comment said every rule below compares against it. Two of the five do.)
  if (!Number.isInteger(receipt.limit) || receipt.limit < 1) {
    return `it reports a bound of ${receipt.limit}, which is not a number of rows a listing could return`;
  }
  if (receipt.coverage === 'UNKNOWN' && rowCount > 0) {
    return `it says the listing could not be read, and ${rowsPhrase(rowCount)} arrived with it`;
  }
  if (receipt.coverageCause !== null && receipt.coverage !== 'UNKNOWN') {
    return `it names a stage that stopped the listing and still reports ${receipt.coverage}`;
  }
  if (receipt.coverage === 'PARTIAL' && rowCount !== receipt.limit) {
    return (
      `it says the archive holds more than the bound of ${receipt.limit}, and ` +
      `${rowsPhrase(rowCount)} arrived with it rather than the bound`
    );
  }
  if (rowCount > receipt.limit) {
    return `it reports a bound of ${receipt.limit}, and ${rowsPhrase(rowCount)} arrived with it`;
  }
  if (receipt.returned !== rowCount) {
    return `it counts ${rowsPhrase(receipt.returned)}, and ${rowsPhrase(rowCount)} arrived with it`;
  }
  return null;
}

/**
 * The word in the verdict cell.
 *
 * `asking` gets ASKING and never the unreachable word, which was the whole defect. The THREE states
 * that carry a receipt - `unknown`, `empty` and `rows` - print the coverage the API sent rather than a
 * word chosen here, so the cell cannot disagree with the receipt beside it. (An earlier version of
 * this sentence said two, having forgotten `unknown`, which is the one whose reason a reader most
 * needs.)
 */
export function verdictWord(state: ListingState): string {
  switch (state.kind) {
    case 'not-asked':
      return 'NOT ASKED';
    case 'asking':
      return 'ASKING';
    case 'unreachable':
      return 'NO ANSWER';
    case 'refused':
      // The API's own code, so a reader can tell RATE_LIMITED from a server fault. The sibling
      // console already does this; the archive dropped the distinction.
      return state.failure.error.toUpperCase();
    default:
      return state.receipt.coverage;
  }
}

/** True when the receipt strip should render unlit: nothing measured has arrived. */
export function isUnlit(state: ListingState): boolean {
  return state.kind !== 'rows' && state.kind !== 'empty' && state.kind !== 'unknown';
}

/** The receipt this state carries, if any. Keeps the island from re-deriving it. */
export function receiptOf(state: ListingState): MemoryListReceiptView | null {
  return state.kind === 'unknown' || state.kind === 'empty' || state.kind === 'rows'
    ? state.receipt
    : null;
}
