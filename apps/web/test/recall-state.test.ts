import { describe, expect, it } from 'vitest';
import { readRecall } from '../src/scripts/recall-state.ts';
import type {
  Coverage,
  RecallEventView,
  RecallReceiptView,
  RecalledMemoryView,
} from '../src/scripts/types.ts';

/**
 * The console's half of the guard the archive page got, tested as a pure function.
 *
 * `Console.tsx` had NO test file when this was written, which is why the decision was extracted
 * before it was wired in: a decision that cannot be tested without mounting something does not get
 * tested. The rendering is covered by `console-island.test.ts` beside this.
 */

/**
 * The sentence `runRecall` actually emits for each verdict.
 *
 * WRITTEN OUT BECAUSE THE SIBLING FIXTURE WAS NOT, and a review found it. `archive-state.test.ts`
 * called its receipt coherent by construction while `coverageReason` stayed on one string for all
 * three verdicts, so its UNKNOWN fixture carried a failed listing's cause beside a completed
 * listing's sentence, a body no producer sends, and a test asserted that pairing. Free text is the
 * one field no guard checks, so a wrong one is invisible forever.
 */
function recallReason(coverage: Coverage): string {
  if (coverage === 'UNKNOWN') {
    return (
      'the embedding provider failed, so the query could not be turned into a vector and neither ' +
      'retrieval path could run'
    );
  }
  if (coverage === 'PARTIAL') {
    return 'The candidate cap of 12 was reached. There may be relevant memories that were never examined.';
  }
  return 'The search compared every live row in the workspace, 12 of them.';
}

/**
 * A receipt that is COHERENT BY CONSTRUCTION, so a test that wants an incoherent one has to say so.
 *
 * Every field moves with the coverage, including the two the producer ties together and the one the
 * sibling fixture forgot. UNKNOWN comes out of `emptyUnknown`, which hardcodes a path of `none`,
 * nothing examined, nothing returned and a cause; the other two come off the success path, which
 * hardcodes a null cause and a real path.
 */
const receipt = (coverage: Coverage, overrides: Partial<RecallReceiptView> = {}): RecallReceiptView => ({
  query: 'checkout p99 went from 180 ms to 4.2 s',
  coverage,
  coverageReason: recallReason(coverage),
  coverageCause: coverage === 'UNKNOWN' ? 'embedder_failed' : null,
  retrievalPath: coverage === 'UNKNOWN' ? 'none' : 'ann_index',
  candidatesConsidered: coverage === 'UNKNOWN' ? 0 : 12,
  returned: coverage === 'UNKNOWN' ? 0 : 2,
  exclusions: [],
  degradations: [],
  elapsedMs: 7,
  ...overrides,
});

const memory = (id: string): RecalledMemoryView => ({
  id,
  kind: 'observation',
  content: 'the checkout pods were evicted at 02:14',
  similarity: 0.81,
  score: 0.74,
  freshness: 0.6,
  stale: false,
  ageDays: 3,
  halfLifeDays: 30,
  confirmations: 2,
  contradictions: 0,
  assertedBy: 'human:oncall-ana',
  incidentId: 'INC-42',
  supersededBy: null,
});

/**
 * An event whose rack matches its receipt unless a test asks otherwise.
 *
 * `memoryCount` defaults to the receipt's own `returned`, so the agreeing case is the DEFAULT and a
 * disagreement has to be written down. A receipt whose `returned` is not a count racks nothing,
 * which keeps rule 0 and rule 3 from firing on each other's fixtures.
 */
const event = (receiptValue: RecallReceiptView, memoryCount?: number): RecallEventView => {
  const racked =
    memoryCount ??
    (Number.isInteger(receiptValue.returned) && receiptValue.returned >= 0 ? receiptValue.returned : 0);
  return {
    callId: 'recall-1',
    receipt: receiptValue,
    memories: Array.from({ length: racked }, (_unused, index) => memory(`aaaaaaaa-0000-0000-0000-00000000000${index}`)),
  };
};

/** The phrase a refusal carried, or a sentinel a `toContain` cannot pass against by accident. */
const refusalDetail = (given: RecallEventView): string => {
  const strip = readRecall(given);
  // NOT AN EMPTY STRING. A falsy sentinel makes every `.not.toContain` against it vacuous, a shape
  // the sibling island file has now grown four times, the fourth introduced by the commit closing
  // the third. Throwing is the only sentinel a later assertion cannot silently pass against.
  if (strip.kind !== 'refused') {
    throw new Error(`expected this receipt to be refused, and it was shown: ${JSON.stringify(given.receipt)}`);
  }
  return strip.failure.detail;
};

describe('readRecall, on receipts this API really sends', () => {
  it('shows a COVERED recall whose count matches its rack', () => {
    const strip = readRecall(event(receipt('COVERED')));
    expect(strip.kind).toBe('shown');
  });

  it('shows a COVERED recall that examined candidates and returned none of them', () => {
    // THE CASE THAT MUST NOT BE REFUSED, and the reason the unclamped bound had to be fixed at the
    // producer instead of here. `scoreCandidates` drops rows for validity, staleness and the
    // similarity floor, so twelve examined and none returned is a real and honest outcome. It is
    // also exactly what a bound of zero produced, and this page cannot tell the two apart.
    const strip = readRecall(event(receipt('COVERED', { returned: 0 })));
    expect(strip.kind).toBe('shown');
  });

  it('shows a PARTIAL recall that hit the cap', () => {
    const strip = readRecall(event(receipt('PARTIAL', { candidatesConsidered: 12, returned: 5 })));
    expect(strip.kind).toBe('shown');
  });

  it('shows the UNKNOWN receipt `emptyUnknown` builds, cause and all', () => {
    // The verdict this product exists to show. Refusing it would replace the one sentence that says
    // nobody looked with a sentence about a malformed receipt.
    const strip = readRecall(event(receipt('UNKNOWN')));
    expect(strip.kind).toBe('shown');
  });
});

describe('readRecall, on receipts that argue with what arrived', () => {
  it('refuses a returned count that is not a count', () => {
    expect(refusalDetail(event(receipt('COVERED', { returned: 2.5 })))).toContain('which is not a number of memories');
    expect(refusalDetail(event(receipt('COVERED', { returned: -1 })))).toContain('reports -1 returned');
  });

  it('refuses a candidate count that is not a count', () => {
    expect(refusalDetail(event(receipt('COVERED', { candidatesConsidered: -3 })))).toContain(
      'which is not a number of candidates',
    );
  });

  it('refuses a negative elapsed time and allows a fractional one', () => {
    // Only the negative half. A fractional millisecond is a real measurement where a fractional row
    // is not, and refusing it would refuse a receipt nothing is wrong with.
    expect(refusalDetail(event(receipt('COVERED', { elapsedMs: -4 })))).toContain('which is not a duration');
    expect(readRecall(event(receipt('COVERED', { elapsedMs: 7.5 }))).kind).toBe('shown');
  });

  it('refuses a count that disagrees with the rack beside it', () => {
    // THE REPORTED DEFECT. The log printed `receipt.returned` while the board racked
    // `event.memories`, and nothing compared them.
    expect(refusalDetail(event(receipt('COVERED', { returned: 9 }), 1))).toContain(
      'it counts 9 memories, and 1 memory arrived with it',
    );
  });

  it('refuses more returned than were ever examined, and counts the candidate in words', () => {
    // HALF THIS SENTENCE PLURALISED AND HALF DID NOT: `memoriesPhrase` built the first half and the
    // second was interpolated raw, so it read "out of 1 candidates examined".
    expect(refusalDetail(event(receipt('COVERED', { candidatesConsidered: 1, returned: 3 }), 3))).toContain(
      'it returned 3 memories out of 1 candidate examined',
    );
  });

  it('refuses UNKNOWN carrying memories without claiming no search ran', () => {
    // THE VERDICT SAYS NO USABLE RESULT while strips sit racked under it as though they were the
    // answer, which is the exact confusion this product exists to remove.
    //
    // AND IT MAY NOT SAY THE SEARCH DID NOT RUN, which is what it used to say. Rules 3 and 4 have
    // both passed by the time this one is reached, so `candidatesConsidered >= returned >= 1` on
    // every input that can fire it: this fixture reports twelve examined. The console's own slip for
    // this very receipt reads THE SEARCH DID NOT COMPLETE, because a search did run.
    //
    // BOTH OVERRIDES ARE LOAD BEARING, and the first two attempts at this fixture proved it by
    // failing. Left at the UNKNOWN defaults the count rule fires first, because `returned` is 0 and
    // two memories arrived; given `returned: 2` alone the examined rule fires, because nothing was
    // examined. Either would have passed a test naming a rule that need not exist. The reachable
    // shape of THIS contradiction is a receipt consistent in every other way that still says the
    // search never ran.
    expect(refusalDetail(event(receipt('UNKNOWN', { returned: 2, candidatesConsidered: 12 }), 2))).toBe(
      'This search answered with a receipt that disagrees with what arrived with it: it reports no ' +
        'usable result, and 2 memories arrived with it. Nothing on this strip is a result.',
    );
  });

  it('refuses a stage that stopped the search beside a verdict that says nothing stopped', () => {
    expect(
      refusalDetail(event(receipt('COVERED', { coverageCause: 'candidate_query_failed' }))),
    ).toContain('names a stage that stopped the search and still reports COVERED');
  });

  it('refuses PARTIAL over nothing examined at all', () => {
    // THE PRINT SIDE of the unclamped candidate cap. A cap of 0 made `rows.length >= cap` true at
    // `0 >= 0`, and the slip worded it as a search cut short with something real in it.
    expect(
      refusalDetail(event(receipt('PARTIAL', { candidatesConsidered: 0, returned: 0 }))),
    ).toContain('reports that no candidate was examined at all');
  });

  it('refuses a path of none beside a verdict that a search ran', () => {
    // `decideCoverage`'s first branch maps that path to UNKNOWN unconditionally, so this pair
    // cannot come out of the producer's own decision function.
    expect(refusalDetail(event(receipt('COVERED', { retrievalPath: 'none' })))).toContain(
      'says no retrieval path ran and still reports COVERED',
    );
  });

  it('says whether the receipt argued with the rack or with itself', () => {
    // THE WORDING WAS ONE SENTENCE FOR ALL NINE RULES and a review falsified it: exactly two read
    // the rack, and two of the rest compare two strings with no number in them. The loudest case is
    // PARTIAL over nothing examined, where nothing arrived at all, so "its numbers argue with what
    // arrived" describes a comparison that never happened. The console words its slip from this.
    const againstRack = readRecall(event(receipt('COVERED', { returned: 9 }), 1));
    const againstItself = readRecall(event(receipt('PARTIAL', { candidatesConsidered: 0, returned: 0 })));
    if (againstRack.kind !== 'refused' || againstItself.kind !== 'refused') {
      throw new Error('both of these receipts must be refused for this test to mean anything');
    }

    // PINNED WHOLE, BOTH OF THEM. A negative guards a wording and not a claim, and the negative that
    // stood here forbade "strips beside it", a phrase since removed from every opening in the file,
    // which would have left it passing over any wording at all. The openings are the sentence a
    // reader is given, so they are asserted as sentences.
    expect(againstRack.contradiction).toBe('rack');
    expect(againstRack.failure.detail).toBe(
      'This search answered with a receipt that disagrees with what arrived with it: it counts 9 ' +
        'memories, and 1 memory arrived with it. Nothing on this strip is a result.',
    );
    expect(againstItself.contradiction).toBe('internal');
    expect(againstItself.failure.detail).toBe(
      'This search answered with a receipt whose own fields disagree: it says the search was cut ' +
        'short, and reports that no candidate was examined at all. Nothing on this strip is a result.',
    );
  });

  it('separates a field that is not a measurement from two fields that disagree', () => {
    // THE THIRD KIND, and the one both previous wordings missed. Rules 0, 1 and 2 test a single
    // field and compare NOTHING, so "its own fields disagree" was false for them: the fields agreed
    // and one value was not a count. This is also the only refusal reachable on a conforming answer,
    // through a clock stepped backwards, so it is the sentence most likely to be read in anger.
    const malformed = readRecall(event(receipt('COVERED', { elapsedMs: -4 })));
    if (malformed.kind !== 'refused') throw new Error('a negative duration must be refused');

    expect(malformed.contradiction).toBe('malformed');
    expect(malformed.failure.detail).toContain('carrying a value that is not a measurement');
    expect(malformed.failure.detail).toContain('it reports -4 ms elapsed');
    expect(malformed.failure.detail).not.toContain('whose own fields disagree');
    // A `not.toContain('strips beside it')` stood here and went dead in the same change that pinned
    // its twin whole one test above, because that phrase left every opening in the file. Deleted
    // rather than reworded: the positive on the line above already catches a reversion.
  });

  it('names the refusal with the code this console already uses for an unreadable answer', () => {
    const strip = readRecall(event(receipt('COVERED', { returned: 9 }), 1));
    if (strip.kind !== 'refused') throw new Error('expected a refusal');
    expect(strip.failure.error).toBe('unrecognised_response');
    expect(strip.failure.detail).toContain('Nothing on this strip is a result');
    // The event travels with the refusal, so the board can still say WHICH search was refused.
    expect(strip.event.receipt.query).toBe('checkout p99 went from 180 ms to 4.2 s');
  });
});
