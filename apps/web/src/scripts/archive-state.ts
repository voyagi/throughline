import { UNREACHABLE } from './api.ts';
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
  /** The API ANSWERED and refused: rate limited, an unknown kind, an internal error. */
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
        error: 'unrecognised_response',
        detail: 'The archive answered in a shape this console cannot read, so nothing here is a result.',
      },
    };
  }

  if (input.receipt.coverage === 'UNKNOWN') return { kind: 'unknown', receipt: input.receipt };
  if (input.rowCount === 0) return { kind: 'empty', receipt: input.receipt };
  return { kind: 'rows', receipt: input.receipt };
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
