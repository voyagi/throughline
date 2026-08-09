import { describe, expect, it } from 'vitest';
import {
  describeListing,
  isUnlit,
  receiptOf,
  verdictWord,
  type ListingInput,
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

const receipt = (coverage: Coverage, overrides: Partial<MemoryListReceiptView> = {}): MemoryListReceiptView => ({
  kinds: [],
  limit: 50,
  returned: coverage === 'UNKNOWN' ? 0 : 2,
  coverage,
  coverageReason: 'every row matching this filter fitted inside the bound',
  coverageCause: coverage === 'UNKNOWN' ? 'listing_query_failed' : null,
  requestedAt: '2026-08-08T12:00:00.000Z',
  elapsedMs: 4,
  ...overrides,
});

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

  // A BOUND THAT WAS REACHED IS NOT A FAILURE. PARTIAL with rows is `rows`; PARTIAL with none is
  // `empty`, which is the state a sub-1 `?limit=` used to produce before the clamp was fixed.
  it.each([
    ['PARTIAL with rows', 2, 'rows'],
    ['PARTIAL with none', 0, 'empty'],
  ])('treats %s as a completed listing', (_label, rowCount, expected) => {
    const state = describeListing(input({ receipt: receipt('PARTIAL'), rowCount }));
    expect(state.kind).toBe(expected);
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
    expect(receiptOf(state)?.coverageReason).toBe(
      'every row matching this filter fitted inside the bound',
    );
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
