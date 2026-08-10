import { UNRECOGNISED } from './api.ts';
import {
  internal,
  isCount,
  malformed,
  rack,
  type Contradiction,
  type ContradictionKind,
} from './contradiction.ts';
import type { FailureResponse, RecallEventView, RecallReceiptView } from './types.ts';

/**
 * What the console can honestly print for ONE recall event.
 *
 * THE SIBLING OF `archive-state.ts`, WRITTEN BECAUSE THE ARCHIVE'S FIX STOPPED AT THE ARCHIVE. That
 * page was taught to refuse a listing whose receipt argues with the rows beside it. The console
 * prints a receipt too, over a rack it never compares it to, on the page this product demonstrates
 * itself on. Closing one instance and leaving its sibling is this repository's most expensive
 * recurring mistake, and this file is the sibling.
 *
 * A PURE FUNCTION IN ITS OWN MODULE, for the reason `archive-state.ts` is one: a decision that
 * cannot be tested without mounting something does not get tested, and `Console.tsx` had no test
 * file at all when this was written.
 */

/**
 * WHICH TWO THINGS DISAGREED, because the console words the slip from it and a single wording was
 * wrong for most of the rules.
 *
 * The first version of this file called every refusal "its numbers argue with what arrived". Only
 * TWO of the nine rules read the rack at all, and two others compare two strings with no number in
 * them, so that sentence was false for seven of the nine. The loudest instance is PARTIAL over
 * nothing examined: nothing arrived, so nothing could argue with it, and the slip said the numbers
 * did. A guard that replaces a true sentence with a false one is the trade this file exists to
 * refuse, committed by this file, which is this repository's defect exactly.
 */
export type RecallStrip =
  /** The receipt agrees with itself and with what arrived. The board may rack it and print it. */
  | { readonly kind: 'shown'; readonly event: RecallEventView }
  /**
   * The receipt cannot be read as one consistent statement, so no part of it can be believed. The
   * board racks a refusal slip and prints none of its measurements.
   */
  | {
      readonly kind: 'refused';
      readonly event: RecallEventView;
      readonly failure: FailureResponse;
      readonly contradiction: ContradictionKind;
    };

/**
 * Read one recall event, or refuse it.
 *
 * REFUSED RATHER THAN REPAIRED, the same choice `archive-state.ts` made and for the same reason.
 * The tempting alternative is to keep the more cautious half and render that, but there is no
 * honest way to pick: a receipt that contradicts what came back with it gives no reason to believe
 * either half of itself. `UNRECOGNISED` is what this console already returns for an answer it
 * cannot read a result out of, and it says the one true thing available.
 */
export function readRecall(event: RecallEventView): RecallStrip {
  const contradiction = receiptContradiction(event.receipt, event.memories.length);
  if (contradiction === null) return { kind: 'shown', event };
  return {
    kind: 'refused',
    event,
    contradiction: contradiction.kind,
    failure: {
      error: UNRECOGNISED,
      detail: `${OPENING[contradiction.kind]}${contradiction.phrase}. Nothing on this strip is a result.`,
    },
  };
}

/**
 * How each kind of refusal opens, so no sentence describes a comparison that did not happen.
 *
 * ONE TABLE RATHER THAN A TERNARY, because a ternary is what shipped the last wrong sentence: it had
 * two arms for what turned out to be three cases, and the third silently borrowed the wording of the
 * second. A table keyed by the union cannot be short a case without failing the build.
 */
const OPENING: Readonly<Record<ContradictionKind, string>> = {
  malformed: 'This search answered with a receipt carrying a value that is not a measurement: ',
  internal: 'This search answered with a receipt whose own fields disagree: ',
  // "WITH WHAT ARRIVED" RATHER THAN "WITH THE STRIPS BESIDE IT", because a rack rule fires on a
  // receipt carrying nine memories when NOTHING arrived, and there are no strips beside that one.
  rack: 'This search answered with a receipt that disagrees with what arrived with it: ',
};

/** `1 memory` or `N memories`, so a contradiction reads as a sentence rather than as a bare count. */
const memoriesPhrase = (count: number): string => (count === 1 ? '1 memory' : `${count} memories`);

/**
 * Its twin, and it was missing while half the same sentence already had one.
 *
 * Rule 4 printed `it returned 3 memories out of 1 candidates examined`: the half built by
 * `memoriesPhrase` agreed with itself and the half interpolated raw did not.
 */
const candidatesPhrase = (count: number): string =>
  count === 1 ? '1 candidate examined' : `${count} candidates examined`;

/**
 * Which way a receipt and what arrived with it disagree, as a phrase, or null when they agree.
 *
 * WHY A BODY CAN BE REFUSED FOR WHAT IT MEANS RATHER THAN FOR ITS TYPES. `shapes.ts` checks one
 * field at a time, by design, so it accepts a body whose fields are each valid and jointly
 * impossible. `isNumber` there is `Number.isFinite`, which passes `-3` and `2.5` for a count of
 * rows.
 *
 * THE LIST BELOW IS BUILT FROM WHAT THE CONSOLE PRINTS, AND THE FIELDS WERE COUNTED RATHER THAN
 * RECALLED. `Console.tsx` reads exactly seven receipt fields, on the refusal slip and on the log
 * verdict span: `coverage`, `query`, `retrievalPath`, `candidatesConsidered`, `elapsedMs`,
 * `coverageCause` and `returned`. Every rule below is a pair of those, or one of them against the
 * rack. The archive's guard was written short because it enumerated the cases somebody thought of,
 * and a review counting the printed fields found more, one of which was the same defect the
 * function existed to close, one row short. (No figures here: the sentence that stood in this place
 * gave two that could not both be true, which a review caught. The lesson is the method, and the
 * method is counting the printed fields rather than listing the cases you can imagine.)
 *
 *   0. `returned` is not a count. The span prints "N RETURNED" and the slip prints "RETURNED N".
 *   1. `candidatesConsidered` is not a count. Both print it as candidates examined.
 *   2. `elapsedMs` is not a duration. Only the NEGATIVE half is refused: a fractional millisecond
 *      is a real measurement, where a fractional row is not.
 *   3. `returned` disagreeing with the rack. The span prints the count while the rack renders the
 *      array, so a body where those differ prints a number that argues with the strips below it.
 *      This is the console's version of the archive's rule 6 and it was the reported defect. (It
 *      said rule 5, which was right until a rule was inserted into that file and every reference
 *      inside it was renumbered. The one reference living in THIS file was left pointing at the old
 *      number, which is the sibling-file half of the defect both guards exist for.)
 *   4. More returned than examined. A search cannot hand back rows it never looked at.
 *   5. UNKNOWN carrying memories. The verdict says the search produced no usable result while
 *      strips sit racked under it as though they were the answer. THE SAME CORRECTION HAS NOW BEEN
 *      MADE TWICE HERE, once to this note and once to the sentence a reader actually sees: rules 3
 *      and 4 have to pass before this one is reached, so a receipt firing it always reports at least
 *      one candidate examined, and neither the note nor the phrase may say the search did not run.
 *      A correction to a comment does not correct the string beside it.
 *   6. A cause without UNKNOWN. `coverageCause` names the stage that STOPPED a search, and the
 *      producer sets one only alongside UNKNOWN. Under PARTIAL the slip prints "STOPPED BY the
 *      candidate query did not complete" six lines above "What is here is real but incomplete".
 *      Under COVERED no slip is drawn at all and the log span never prints the cause, so the reader
 *      is shown one of the two contradicting fields and cannot see the contradiction: the rule is
 *      what makes it visible rather than what describes it. (This claimed the pair would reach the
 *      reader through the log span. It would not. The archive's twin note IS true of the archive,
 *      whose Why cell prints the cause under every verdict, which is how one file's sentence went
 *      wrong while its sibling's stayed right.)
 *   7. PARTIAL with nothing examined. PARTIAL is the verdict the slip words as real but incomplete,
 *      and there is nothing real in it. This is the print side of the unclamped candidate cap that
 *      `runRecall` was fixed for in the same change: a cap of 0 made `rows.length >= cap` true at
 *      `0 >= 0` and produced exactly this receipt.
 *   8. A path of `none` without UNKNOWN. `decideCoverage`'s FIRST branch maps that path to UNKNOWN
 *      unconditionally, so the pair cannot come out of the producer's own decision function. The
 *      log span prints the path uppercased beside a verdict saying a search ran; under COVERED
 *      there is no slip, for the reason given in rule 6.
 *
 * WHAT IS DELIBERATELY NOT HERE, with the reason, because an enumeration that hides its exclusions
 * is a sample wearing an enumeration's clothes:
 *
 *   - UNKNOWN with candidates examined, and UNKNOWN with a path other than `none`. Both are things
 *     `decideCoverage` can genuinely produce: `retrievalFailed` says nothing about either field.
 *     What would be wrong is this console's own sentence, NO SEARCH RAN, so the honest fix there is
 *     the wording rather than a refusal. An UNKNOWN must never be hidden: it is the verdict this
 *     product exists to show.
 *   - COVERED with candidates examined and nothing returned. NOT a contradiction. `scoreCandidates`
 *     drops rows for validity, staleness and the similarity floor, so examined-many-returned-none
 *     is a real outcome and `exclusions` carries the reason. It is also what an unclamped bound of
 *     zero produced, and the two are indistinguishable here, which is exactly why that one had to
 *     be closed at the producer and cannot be closed on this page.
 *   - `coverageReason`, `exclusions` and `degradations`. The console reads none of them. Measured,
 *     not assumed.
 *   - `query`. THE REASON WRITTEN HERE HAS NOW BEEN WRONG TWICE, in two different ways, which is
 *     why the third version credits only what it can point at. It first said the board holds no
 *     second value to contradict this one. It does: the turn's `transcript` carries the `tool_call`
 *     that asked, and its `id` is the same id `callId` carries, so an independent copy of the
 *     question is on the page. The correction then credited `failedRecalls` for reading it, and a
 *     second review falsified that too: `failedRecalls` skips every call id that produced a
 *     receipt, so it never reads the query of any recall this note is about. The copy is in the
 *     transcript, and nothing currently compares the two. It stays out of the rules
 *     anyway, and this is a judgement rather than an oversight: the transcript's copy is what the
 *     MODEL asked for and the receipt's is what the search RAN, and those differing is a fact worth
 *     showing rather than a reason to refuse a whole result. The refusal slip prints the receipt's
 *     copy, which is a field off a receipt this guard just declared unbelievable, so it is labelled
 *     on the slip as the query the receipt claims rather than presented as the question asked.
 *
 * NONE OF THESE IS REACHABLE FROM THIS PROJECT'S OWN API, and each was read rather than assumed.
 * `runRecall` reaches UNKNOWN only through `emptyUnknown`, which hardcodes `memories: []`,
 * `returned: 0`, `candidatesConsidered: 0` and a path of `none`. Its success path hardcodes
 * `coverageCause: null`, takes `returned` from the array it returns, and now floors both bounds. So
 * this guard cannot fire on a conforming answer: anything reaching it came from something that is
 * not this API. TWO honest caveats, both found by review rather than volunteered:
 *
 *   - Rule 7. `decideCoverage`'s deadline branch could emit PARTIAL with nothing examined, and no
 *     producer sets `deadlineExceeded` today.
 *   - Rule 2. `elapsedMs` is `Date.now() - startedAt`, and `Date.now()` is not monotonic, so a
 *     clock stepped backwards mid-recall by NTP produces a negative duration on an otherwise
 *     genuine answer. It is the one input on which this guard can fire on a conforming receipt.
 *     Left as it is: a negative duration cannot be printed as a measurement either way, and the
 *     refusal says so, where the alternative is a slip reading "ELAPSED -4 ms".
 */
function receiptContradiction(
  receipt: RecallReceiptView,
  memoryCount: number,
): Contradiction | null {
  // THE KIND TRAVELS WITH THE PHRASE because the console words two sentences from it. Counted
  // rather than eyeballed, because both previous wordings were wrong by a count: THREE rules test
  // one field on its own, FOUR compare two fields of the receipt, and TWO read `memoryCount`.
  //
  // FIRST, the fields the board prints as measurements, because the comparisons under them are
  // meaningless rather than false when a count is not a count. These three compare NOTHING: one
  // field is simply not a value of the kind it claims to be.
  if (!isCount(receipt.returned)) {
    return malformed(`it reports ${receipt.returned} returned, which is not a number of memories`);
  }
  if (!isCount(receipt.candidatesConsidered)) {
    return malformed(
      `it reports ${receipt.candidatesConsidered} candidates examined, which is not a number of candidates`,
    );
  }
  if (!Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0) {
    return malformed(`it reports ${receipt.elapsedMs} ms elapsed, which is not a duration`);
  }
  if (receipt.returned !== memoryCount) {
    return rack(
      `it counts ${memoriesPhrase(receipt.returned)}, and ${memoriesPhrase(memoryCount)} arrived with it`,
    );
  }
  if (receipt.returned > receipt.candidatesConsidered) {
    return internal(
      `it returned ${memoriesPhrase(receipt.returned)} out of ` +
        candidatesPhrase(receipt.candidatesConsidered),
    );
  }
  // NOT "IT SAYS THE SEARCH DID NOT RUN", which this said and which is false on every input that can
  // reach it. Rules 3 and 4 have both passed here, so `returned === memoryCount > 0` and
  // `candidatesConsidered >= returned >= 1`: every receipt firing this rule reports at least one
  // candidate examined. The console's own test for a search that did not run is a path of `none` with
  // nothing examined, which none of them satisfies, and the slip for exactly this receipt would read
  // THE SEARCH DID NOT COMPLETE. The docblock above was corrected for this and the sentence a reader
  // sees was not.
  if (receipt.coverage === 'UNKNOWN' && memoryCount > 0) {
    return rack(`it reports no usable result, and ${memoriesPhrase(memoryCount)} arrived with it`);
  }
  if (receipt.coverageCause !== null && receipt.coverage !== 'UNKNOWN') {
    return internal(`it names a stage that stopped the search and still reports ${receipt.coverage}`);
  }
  if (receipt.coverage === 'PARTIAL' && receipt.candidatesConsidered === 0) {
    return internal('it says the search was cut short, and reports that no candidate was examined at all');
  }
  if (receipt.retrievalPath === 'none' && receipt.coverage !== 'UNKNOWN') {
    return internal(`it says no retrieval path ran and still reports ${receipt.coverage}`);
  }
  return null;
}
