import { describe, expect, it } from 'vitest';
import {
  describeListing,
  isUnlit,
  receiptOf,
  verdictWord,
  type ListingInput,
  type ListingState,
} from '../src/scripts/archive-state.ts';
import type { Coverage, MemoryListReceiptView } from '../src/scripts/types.ts';

/**
 * THE FIRST TEST OVER `apps/web`, and it exists because an adversarial review found three defects in
 * the archive page's state machine and pointed out that nothing anywhere was watching it.
 *
 * It tests a PURE FUNCTION rather than a mounted component, deliberately. The three defects were all
 * in the DECISION about which state the page is in, not in the markup, and a decision extracted into
 * a function needs no DOM, no fetch stub and no hydration to pin. What is still untested is the
 * rendering, and that gap is recorded in the handoff rather than papered over here.
 *
 * `vitest.config.ts` already matches `apps/*&#47;test/**&#47;*.test.ts`, so this file needed no config
 * change to be collected. That was worth checking rather than assuming: a test file nothing runs is
 * the purest example of a control that cannot fail.
 */

/**
 * A receipt that is COHERENT BY CONSTRUCTION, so a test that wants an incoherent one has to say so.
 *
 * THE BOUND MOVES WITH THE COVERAGE, which is not decoration. PARTIAL means the bound was reached,
 * and `runList` measures that by asking the database for one row more than the bound, so a PARTIAL
 * page always carries EXACTLY `limit` rows. A PARTIAL fixture with `limit: 50` and two rows is a
 * body the API cannot produce, and this file had one: building the default that way is precisely how
 * a suite ends up pinning a body that only a broken server could send.
 */
/**
 * The sentence `runList` actually emits for each verdict, so no fixture here pairs one verdict's
 * cause with another's reason.
 *
 * THE HEADLINE ABOVE WAS FALSE UNTIL THIS EXISTED, which is the same defect the sibling island file
 * was corrected for: half-correcting a fixture leaves it impossible in a way no guard can catch.
 * `limit`, `returned` and `coverageCause` moved with the coverage and `coverageReason` did not, so
 * `receipt('UNKNOWN')` carried cause `listing_query_failed` beside "every row matching this filter
 * fitted inside the bound", a completed listing's sentence on a listing that failed. `runList`
 * sends no such body. Free text is the one field no guard checks, so a wrong one here is invisible
 * forever, and a test below asserted that exact pairing.
 */
function listingReason(coverage: Coverage, limit: number): string {
  if (coverage === 'UNKNOWN') {
    return 'the archive query failed, so no rows were read and this page cannot say the archive is empty';
  }
  if (coverage === 'PARTIAL') {
    return (
      `the archive holds more than ${limit} rows matching this filter, so this page is the ` +
      'newest of them and not all of them'
    );
  }
  return 'every row matching this filter fitted inside the bound';
}

const receipt = (coverage: Coverage, overrides: Partial<MemoryListReceiptView> = {}): MemoryListReceiptView => {
  const limit = coverage === 'PARTIAL' ? 2 : 50;
  return {
    kinds: [],
    limit,
    returned: coverage === 'UNKNOWN' ? 0 : 2,
    coverage,
    coverageReason: listingReason(coverage, limit),
    coverageCause: coverage === 'UNKNOWN' ? 'listing_query_failed' : null,
    requestedAt: '2026-08-08T12:00:00.000Z',
    elapsedMs: 4,
    ...overrides,
  };
};

const input = (overrides: Partial<ListingInput> = {}): ListingInput => ({
  pending: false,
  asked: true,
  failure: null,
  receipt: null,
  rowCount: 0,
  ...overrides,
});

describe('describeListing', () => {
  it('reports NOT ASKED in the state the static HTML ships in', () => {
    // Nothing pending and nothing asked: the pre-hydration render. It is not an empty archive, and
    // the page must not say it is.
    const state = describeListing(input({ pending: false, asked: false }));
    expect(state.kind).toBe('not-asked');
    expect(verdictWord(state)).toBe('NOT ASKED');
  });

  // THE IN-FLIGHT DEFECT. A filter chip click clears the previous answer and opens a new request, so
  // `asked` is true and both `receipt` and `failure` are null. That triple used to render the word
  // reserved for the API not answering, with no sentence under it at all.
  it('reports ASKING during a refetch rather than borrowing the unreachable word', () => {
    const state = describeListing(input({ pending: true, asked: true }));
    expect(state.kind).toBe('asking');
    expect(verdictWord(state)).toBe('ASKING');
    expect(verdictWord(state)).not.toBe('NO ANSWER');
  });

  it('prefers the open request over the previous answer', () => {
    // A refetch that has not cleared the old rows yet must still read as ASKING. Reporting the stale
    // receipt would show rows under a filter the API has not applied.
    const state = describeListing(
      input({ pending: true, asked: true, receipt: receipt('COVERED'), rowCount: 2 }),
    );
    expect(state.kind).toBe('asking');
  });

  it('separates an unreachable API from one that answered and refused', () => {
    const unreachable = describeListing(
      input({ failure: { error: 'api_unreachable', detail: 'The API could not be reached.' } }),
    );
    expect(unreachable.kind).toBe('unreachable');
    expect(verdictWord(unreachable)).toBe('NO ANSWER');

    // A 429 is the API ANSWERING. Telling a visitor their connection failed, when the demo's own
    // shared bucket refused them for clicking chips, is a false statement about their network.
    const limited = describeListing(
      input({ failure: { error: 'rate_limited', detail: 'That is faster than this demo answers.' } }),
    );
    expect(limited.kind).toBe('refused');
    expect(verdictWord(limited)).toBe('RATE_LIMITED');
  });

  it.each([
    ['rate_limited', 'RATE_LIMITED'],
    ['unknown_kind', 'UNKNOWN_KIND'],
    ['internal_error', 'INTERNAL_ERROR'],
    ['unrecognised_response', 'UNRECOGNISED_RESPONSE'],
  ])('names %s in the verdict rather than blaming the connection', (error, word) => {
    const state = describeListing(input({ failure: { error, detail: 'something' } }));
    expect(state.kind).toBe('refused');
    expect(verdictWord(state)).toBe(word);
  });

  it('reports UNKNOWN when the API says the listing could not be completed', () => {
    const state = describeListing(input({ receipt: receipt('UNKNOWN'), rowCount: 0 }));
    expect(state.kind).toBe('unknown');
    expect(verdictWord(state)).toBe('UNKNOWN');
  });

  // The pair that matters most, and the reason the whole product exists.
  it('tells a listing that ran and matched nothing apart from one that could not run', () => {
    const empty = describeListing(input({ receipt: receipt('COVERED', { returned: 0 }), rowCount: 0 }));
    const broken = describeListing(input({ receipt: receipt('UNKNOWN'), rowCount: 0 }));

    expect(empty.kind).toBe('empty');
    expect(broken.kind).toBe('unknown');
    expect(empty.kind).not.toBe(broken.kind);
  });

  it('reports rows when the listing returned some', () => {
    const state = describeListing(input({ receipt: receipt('COVERED'), rowCount: 2 }));
    expect(state.kind).toBe('rows');
    expect(verdictWord(state)).toBe('COVERED');
  });

  // A BOUND THAT WAS REACHED IS NOT A FAILURE, so PARTIAL carrying rows is `rows`, exactly like any
  // other listing that ran. PARTIAL carrying NONE used to be asserted here as `empty`; it is now a
  // refusal, and the reason that row was deleted rather than edited is in the describe block below.
  it('treats PARTIAL with rows as a completed listing', () => {
    const state = describeListing(input({ receipt: receipt('PARTIAL'), rowCount: 2 }));
    expect(state.kind).toBe('rows');
    expect(verdictWord(state)).toBe('PARTIAL');
  });

  // THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong in the most expensive way a test can be:
  // it pinned a reassurance in place and called the state unreachable. `call` in `api.ts` returns
  // `ok: true` for any 200 whose body parses, so `{}` or a renamed `receipt` arrived as a success
  // with no receipt, and the page rendered "asked, waiting: nothing has gone wrong" permanently for
  // exactly the input class this page exists to expose. `getMemories` now guards the shape, and this
  // fallback refuses instead of waiting.
  it('treats a settled request carrying neither a receipt nor a failure as a refusal, not a wait', () => {
    const state = describeListing(input({ receipt: null, failure: null }));
    expect(state.kind).toBe('refused');
    expect(state.kind).not.toBe('asking');
    expect(verdictWord(state)).toBe('UNRECOGNISED_RESPONSE');
  });

  it('reports ASKING on a slow FIRST load rather than "nobody has looked"', () => {
    // An open request is a fact whatever came before it. This used to require `asked`, so a slow
    // first load claimed nobody had looked for the whole eight second timeout while a request was
    // open. The static HTML, where nothing is pending and nothing has been asked, is still NOT ASKED.
    expect(describeListing(input({ pending: true, asked: false })).kind).toBe('asking');
    expect(describeListing(input({ pending: false, asked: false })).kind).toBe('not-asked');
  });
});

/**
 * THE THREE BODIES THAT CONTRADICT THEMSELVES, and why the row above was deleted rather than edited.
 *
 * `['PARTIAL with none', 0, 'empty']` was asserted in this file under a comment calling it a
 * completed listing. It pinned the page's most confident sentence, "the listing completed and no row
 * in the archive matches", onto a receipt that says the listing stopped at a bound before it
 * finished. An assertion over a false sentence is not coverage. It is the false sentence with a
 * guard posted on it, and the next person to correct the page meets a green test telling them not to.
 *
 * None of the three is reachable from this project's own API. That was read rather than assumed, and
 * the reading is written out in `receiptContradiction`. All three are reachable through `shapes.ts`,
 * which checks one field at a time and so accepts a body whose fields are each valid and jointly
 * impossible.
 */
describe('describeListing on a body that contradicts itself', () => {
  /** The detail a refusal carries, or null. Keeps the narrowing out of every assertion below. */
  const refusalDetail = (state: ListingState): string | null =>
    state.kind === 'refused' ? state.failure.detail : null;

  // Was `unknown`, which draws no rack of its own while the island racked the response's rows above
  // it anyway: a slip reading "it could not read the archive" with the archive apparently under it.
  it('refuses UNKNOWN carrying rows rather than seating them under a slip that says it could not look', () => {
    const state = describeListing(input({ receipt: receipt('UNKNOWN', { returned: 2 }), rowCount: 2 }));

    expect(state.kind).toBe('refused');
    expect(verdictWord(state)).toBe('UNRECOGNISED_RESPONSE');
    // THE RACK OPENING, PINNED WHOLE, and it was pinned NOWHERE until a planted change to it reddened
    // nothing at all. Two `.not.toContain` assertions elsewhere in this file watch that the OTHER
    // kinds do not borrow this sentence, which is not the same as anybody asserting what it says.
    expect(refusalDetail(state)).toBe(
      'The archive answered with a receipt that contradicts what arrived with it: it says the ' +
        'listing could not be read, and 2 rows arrived with it. Nothing here is a result.',
    );
  });

  // Was `empty`, whose slip is the one sentence on this page that asserts an absence.
  it('refuses PARTIAL carrying no rows rather than calling it a completed listing', () => {
    const state = describeListing(input({ receipt: receipt('PARTIAL', { returned: 0 }), rowCount: 0 }));

    expect(state.kind).toBe('refused');
    expect(refusalDetail(state)).toContain('holds more than the bound of 2');
  });

  // THE INSTANCE THE FIRST VERSION OF THIS GUARD MISSED, and it is the same defect one row-count
  // over. PARTIAL is measured by asking for one row more than the bound, so a PARTIAL page carries
  // exactly `limit` rows; zero was merely its loudest case. A review found this by counting the
  // receipt fields the page PRINTS rather than the cases the guard already handled.
  it.each([
    ['one row under a bound of two', 1],
    ['three rows under a bound of two', 3],
  ])('refuses PARTIAL carrying %s rather than the bound itself', (_label, rowCount) => {
    const state = describeListing(input({ receipt: receipt('PARTIAL', { returned: rowCount }), rowCount }));

    expect(state.kind).toBe('refused');
    // The tag this stops: "the archive holds more than 2 matching rows, so these are the newest of
    // them", printed over a rack that is not the newest two of anything.
    expect(refusalDetail(state)).toContain('rather than the bound');
  });

  it('refuses a cause that names a stage without the verdict that stage produces', () => {
    // `coverageCause` is set by exactly one producer, `emptyUnknownPage`, which always reports
    // UNKNOWN. COVERED with a cause prints the page's absence sentence directly under a Why cell
    // reading "stopped by the archive query did not complete".
    const state = describeListing(
      input({ receipt: receipt('COVERED', { returned: 0, coverageCause: 'listing_query_failed' }), rowCount: 0 }),
    );

    expect(state.kind).toBe('refused');
    expect(refusalDetail(state)).toContain('names a stage that stopped the listing');
    // TWO RECEIPT FIELDS, and no row is involved, so the sentence may not blame the rows either.
    expect(refusalDetail(state)).toContain('a receipt whose own fields disagree');
    expect(refusalDetail(state)).not.toContain('contradicts what arrived with it');
  });

  it.each([
    ['zero', 0],
    ['a negative', -1],
    ['a fraction', 2.5],
  ])('refuses a bound of %s, which is not a number of rows', (_label, limit) => {
    // The producer floors this now, so it can only arrive from somewhere else. A listing that could
    // hold no row cannot support the sentence that no row matched, which is what a bound of zero
    // used to print: `empty`, beside a Bound cell reading "0 rows".
    const state = describeListing(input({ receipt: receipt('COVERED', { limit, returned: 0 }), rowCount: 0 }));

    expect(state.kind).toBe('refused');
    expect(refusalDetail(state)).toContain('not a number of rows');
    // THE SENTENCE, not just the phrase inside it. This page minted one opening for every rule,
    // saying the receipt contradicts the rows beside it, where most of them do not read the row
    // count at all. With `rowCount: 0` there is no row on the page for anything to contradict, so the
    // reader was told about a comparison that never happened. The console was graded HIGH for the
    // identical defect and fixed, and this file taught the console the lesson.
    expect(refusalDetail(state)).toContain('a receipt carrying a value that is not a measurement');
    expect(refusalDetail(state)).not.toContain('contradicts what arrived with it');
  });

  it.each([
    ['a negative', -1],
    ['a fraction', 2.5],
  ])('refuses a returned count of %s, which is not a number of rows', (_label, returned) => {
    // THE RULE THIS PAGE DID NOT HAVE while the console had it from the start. `shapes.ts` accepts
    // any finite `returned` on purpose, so minus one reached the rule that compares the count with
    // the rows and was refused with "it counts -1 rows, and 0 rows arrived with it": a disagreement
    // claimed with rows that had not arrived, and minus one printed as a number of rows. Both pages
    // now ask one shared predicate what a count is.
    const state = describeListing(input({ receipt: receipt('COVERED', { returned }), rowCount: 0 }));

    expect(state.kind).toBe('refused');
    expect(refusalDetail(state)).toBe(
      'The archive answered with a receipt carrying a value that is not a measurement: it reports ' +
        `${returned} returned, which is not a number of rows. Nothing here is a result.`,
    );
  });

  it('refuses more rows than the bound allowed', () => {
    const state = describeListing(input({ receipt: receipt('COVERED', { limit: 2, returned: 3 }), rowCount: 3 }));

    expect(state.kind).toBe('refused');
    // The TAIL, not the prefix. "reports a bound of 2" is also how the bound-validity rule above
    // opens, so asserting that alone would pass on either message and discriminate neither.
    expect(refusalDetail(state)).toContain('a bound of 2, and 3 rows arrived with it');
  });

  // The sibling neither of the two descriptions above covers. `ReceiptStrip` prints
  // `receipt.returned` in the Rows shown cell while the rack renders the array underneath it, so a
  // body where those two disagree prints a count that argues with the strips directly below it.
  it('refuses a receipt whose count disagrees with the rows the rack would draw', () => {
    const state = describeListing(input({ receipt: receipt('COVERED', { returned: 7 }), rowCount: 2 }));

    expect(state.kind).toBe('refused');
    expect(refusalDetail(state)).toContain('counts 7 rows');
    expect(refusalDetail(state)).toContain('2 rows arrived');
  });

  it('names the contradiction it actually found rather than any of the others', () => {
    // One generic sentence would leave a reader unable to tell which of the three arrived, and a
    // `.toContain` against a shared phrase would pass for all three while distinguishing none.
    const unknownWithRows = refusalDetail(
      describeListing(input({ receipt: receipt('UNKNOWN', { returned: 2 }), rowCount: 2 })),
    );
    const partialWithNone = refusalDetail(
      describeListing(input({ receipt: receipt('PARTIAL', { returned: 0 }), rowCount: 0 })),
    );

    // BOTH PHRASES ARE ONES PRODUCTION ACTUALLY EMITS, which a review had to point out: the first
    // version of this assertion tested for "more rows than the bound", a phrase deleted from the
    // guard in the same commit, so it could not fail by finding the wrong message.
    expect(unknownWithRows).not.toContain('holds more than the bound of');
    expect(partialWithNone).not.toContain('could not be read');
  });

  // THE FOUR CELLS THIS GUARD LEAVES ALONE, of three coverages by two row cases, enumerated rather
  // than sampled. A guard that refuses a real answer is a worse defect than the one it closes.
  //
  // The PARTIAL row carries a bound EQUAL to its row count, which is what makes it a body the API
  // can actually produce. An earlier version of this table called all four "coherent" while giving
  // PARTIAL two rows under a bound of fifty, which no listing can return: the label claimed more
  // than the fixtures did.
  it.each([
    ['COVERED with no rows', receipt('COVERED', { returned: 0 }), 0, 'empty'],
    ['COVERED with rows', receipt('COVERED', { returned: 2 }), 2, 'rows'],
    ['PARTIAL with rows', receipt('PARTIAL', { returned: 2 }), 2, 'rows'],
    ['UNKNOWN with no rows', receipt('UNKNOWN', { returned: 0 }), 0, 'unknown'],
  ])('leaves %s alone', (_label, given, rowCount, expected) => {
    expect(describeListing(input({ receipt: given, rowCount })).kind).toBe(expected);
  });
});

describe('isUnlit', () => {
  it.each([
    ['not-asked', input({ pending: false, asked: false }), true],
    ['asking', input({ pending: true, asked: true }), true],
    ['unreachable', input({ failure: { error: 'api_unreachable', detail: 'x' } }), true],
    ['refused', input({ failure: { error: 'rate_limited', detail: 'x' } }), true],
    ['unknown', input({ receipt: receipt('UNKNOWN') }), false],
    ['empty', input({ receipt: receipt('COVERED', { returned: 0 }) }), false],
    ['rows', input({ receipt: receipt('COVERED'), rowCount: 2 }), false],
  ])('reads %s as unlit=%s', (_label, given, expected) => {
    // Unlit means nothing MEASURED has arrived. The three states carrying a receipt are lit even when
    // the receipt says UNKNOWN, because an answer that reports a failure is still an answer.
    expect(isUnlit(describeListing(given))).toBe(expected);
  });
});

describe('receiptOf', () => {
  // ALL THREE receipt-carrying states, because a review planted a `receiptOf` that dropped the
  // UNKNOWN one and 822 of 822 stayed green: the old test asserted `rows` alone. Dropping the UNKNOWN
  // receipt would blank the Why row on the one verdict whose reason a reader most needs.
  it.each([
    ['rows', input({ receipt: receipt('COVERED'), rowCount: 2 })],
    ['empty', input({ receipt: receipt('COVERED', { returned: 0 }), rowCount: 0 })],
    ['unknown', input({ receipt: receipt('UNKNOWN'), rowCount: 0 })],
  ])('returns the receipt for %s', (_label, given) => {
    const state = describeListing(given);
    expect(receiptOf(state)).not.toBeNull();
    // IDENTITY, not a string compare. This asserted one hardcoded reason for all three states,
    // which is what pinned the impossible UNKNOWN fixture green. Identity proves it returned THIS
    // receipt rather than some other one, catches the planted `receiptOf` that dropped the UNKNOWN
    // case, and cannot drift when a fixture's wording changes.
    expect(receiptOf(state)).toBe(given.receipt);
  });

  it.each([
    ['not-asked', input({ pending: false, asked: false })],
    ['asking', input({ pending: true, asked: true })],
    ['unreachable', input({ failure: { error: 'api_unreachable', detail: 'x' } })],
    ['refused', input({ failure: { error: 'rate_limited', detail: 'x' } })],
  ])('returns null for %s, which carries no receipt', (_label, given) => {
    expect(receiptOf(describeListing(given))).toBeNull();
  });
});
