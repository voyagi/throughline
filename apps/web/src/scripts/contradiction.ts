/**
 * WHY a receipt was refused, which is a different question from WHETHER it was.
 *
 * BOTH PAGES REFUSE A RECEIPT AND BOTH HAVE TO SAY WHICH TWO THINGS DISAGREED, so the vocabulary is
 * declared once and imported twice. The archive minted one sentence for all six of its rules and
 * the console did the same for all nine of its, and both sentences were false for the rules that do
 * not compare what they named: the archive told a reader its receipt contradicted the rows beside it
 * on a page where no row arrived, and the console said a receipt's own fields disagreed when one
 * field was simply not a count. Two rounds of review, one defect, both directions.
 *
 * THIS MODULE EXISTS BECAUSE `gate:dup` REFUSED THE SECOND COPY, which is the gate working. The
 * three constructors below were written out in both state modules, and two code paths that must
 * agree on a vocabulary is precisely the case this repository settles with one shared module rather
 * than with a comment asking for care.
 *
 * Three kinds, and the third is the one both wordings missed. A page that adds a fourth gets a
 * compile error in every table keyed by this union, which is the only guarantee worth having here:
 * both previous versions were short a case, and both times the missing case silently borrowed
 * another's sentence.
 */

export type ContradictionKind =
  /** ONE field carries a value that is not a measurement. Nothing is compared with anything. */
  | 'malformed'
  /**
   * Two of the body's own values cannot both be right. Nothing that arrived beside it is involved.
   *
   * "CANNOT BOTH BE RIGHT" RATHER THAN "TWO FIELDS DISAGREE", because a review found a rule this
   * kind fits where the two values are IDENTICAL and must not be: two lamps carrying one name. The
   * narrower wording described the wrong relation for it, which is the same fault as an opening
   * naming a comparison that did not happen, one notch subtler. It stays true of every other user.
   */
  | 'internal'
  /**
   * The receipt disagrees with whatever arrived beside it, which is not always a count and is not
   * always a row. One console rule of this kind has a count that agrees exactly and a verdict that
   * does not, and three of the six rack rules across the two pages fire when NOTHING arrived, so the
   * narrower wording this carried was the least true of the three definitions in the file.
   */
  | 'rack';

/** One way a receipt failed to be one consistent statement, with the phrase a page prints for it. */
export interface Contradiction {
  readonly kind: ContradictionKind;
  readonly phrase: string;
}

/**
 * A contradiction of one named kind.
 *
 * The constructors below return this rather than a bare `Contradiction`, so a page that can only
 * produce SOME of the kinds can say so in its own types. `/status` is the first: a `StatusResponse`
 * is flat, with no receipt and no rack, so a `rack` sentence there would be a branch nothing can
 * reach. Every value of `Of<K>` is still a `Contradiction`, so nothing that already reads one changes.
 */
export interface Of<Kind extends ContradictionKind> extends Contradiction {
  readonly kind: Kind;
}

/** A single field carrying a value that is not a measurement of the kind it claims to be. */
export const malformed = (phrase: string): Of<'malformed'> => ({ kind: 'malformed', phrase });

/** Two of the body's own values that cannot both be right, with nothing that arrived involved. */
export const internal = (phrase: string): Of<'internal'> => ({ kind: 'internal', phrase });

/** The receipt disagreeing with whatever arrived beside it. */
export const rack = (phrase: string): Of<'rack'> => ({ kind: 'rack', phrase });

/**
 * What a count of things is, for every page that refuses a receipt for not carrying one.
 *
 * HERE RATHER THAN ON ONE PAGE, because it was on one page and the other needed it. The console
 * refused a receipt whose `returned` was not a whole number of memories; the archive had no such rule
 * at all, so a listing reporting minus one row fell through to the rule that compares the count with
 * the rows and was told its receipt contradicted rows that were not there. Two pages that must agree
 * on what a count is agree in one module, never by each writing the same predicate.
 *
 * `Number.isFinite` is what `shapes.ts` enforces at the field level, on purpose, so `-3` and `2.5`
 * reach a page and this is where they are stopped.
 */
export const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

/**
 * Blank to a READER, so whitespace counts as nothing rather than as a value.
 *
 * HERE FOR THE REASON `isCount` IS HERE, and it arrived the same way: it lived in `status-state.ts`,
 * where it guards `server`, a lamp's `detail` and a lamp's `name`, and then `api.ts` needed the same
 * question about a failure's `detail` and, one commit later, about a failure's `error`. A predicate
 * copied into a second file is the case this repository settles with one module rather than with a
 * comment asking for care.
 *
 * FIVE CALLERS, and this list is the sort of enumeration that goes stale silently, so it is written
 * as what it is: a reader's map, not a guarantee. The guarantee is that there is one predicate.
 *
 * `shapes.ts` validates the three STATUS fields as bare strings, on purpose, so a value of pure
 * whitespace reaches a page and this is the predicate that stops it being printed as a reason. It
 * covers three of the five, and the sentence here claimed all five for one commit. The other two
 * arrive by a different route: `shapes.ts` exports a guard for the listing, one for the status body
 * and one for the agent turn, and none at all for a failure body, so a failure's `error` and
 * `detail` are typechecked inside `asFailure` rather than by a shape guard.
 */
export const isBlank = (value: string): boolean => value.trim() === '';

/**
 * The shape `Date.prototype.toISOString` produces for the years 0000 to 9999, which is what the
 * contract declares every instant on it to be.
 *
 * NOT "the exact shape", and the word cost a review. Measured on node v22.22.0: `new Date(8.64e15)`
 * prints `+275760-09-13T00:00:00.000Z` and `new Date(-8.64e15)` prints `-271821-04-20T00:00:00.000Z`,
 * so at the extremes `toISOString` produces an expanded year this pattern refuses. Neither is
 * reachable from a `new Date()`, so the rule over-refuses nothing real, but the claim had to be
 * narrowed to the range it is actually true for.
 */
const CONTRACT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Which of the three ways a declared instant fails to be one. */
export type InstantFault =
  /** Not the shape the contract declares. Every non-ISO form a page might be handed lands here. */
  | 'shape'
  /** The contract's shape, naming no time at all. A month of 13 and an hour of 25 reach here. */
  | 'time'
  /** A time the engine reads as a DIFFERENT instant from the one written. */
  | 'exists';

/**
 * Which way a declared instant is not one, or null when it is.
 *
 * HERE FOR THE REASON `isCount` AND `isBlank` ARE HERE, and it arrived the same way, which makes it
 * the third instance of one migration. It lived in `status-state.ts`, where it guards `observedAt`,
 * and then the archive needed the same question about the three instants it prints per row. A
 * predicate copied into a second file is the case this repository settles with one module rather
 * than with a comment asking for care, and `gate:dup` refuses the second copy.
 *
 * THE ROUTE IS WHAT THE THREE SHARE, NOT THE ORIGIN, and the origins are named because a reader
 * should not have to assume one file fed all of them. `isCount` came from `recall-state.ts`, where
 * it guarded a receipt's counts. `isBlank` came from `status-state.ts`. This came from
 * `status-state.ts` too. Each was written for one page, a second page turned out to need exactly
 * it, and this module is where they meet. (A rewrite briefly made this paragraph plural, which
 * made it claim all three had guarded `observedAt`. Only this one ever did.)
 *
 * THE ORDER OF THESE THREE IS LOAD BEARING AND IT IS WHY THEY ARE ONE FUNCTION RATHER THAN THREE
 * EXPORTS. Measured on node v22.22.0: `new Date(NaN).toISOString()` THROWS a RangeError, and
 * `2026-13-45T00:00:00.000Z` has the contract's exact shape while `Date.parse` returns NaN for it.
 * So a caller running the round trip before the parse rule throws during render on that value, which
 * is the blank pane this console exists to argue against. As three separate predicates the ordering
 * was a property of each caller, correct in the only caller there was and waiting for the second one.
 * As one function there is no order left for a caller to get wrong.
 *
 * A ROUND TRIP RATHER THAN A CALENDAR CHECK for the third rule, and the difference is a whole
 * finding. The rule this replaced pulled the year, month and day off the front with a second regex
 * and rebuilt them, which asked whether the written DAY exists and never asked anything about the
 * time. Measured: `2026-08-09T24:00:00.000Z` has the contract's exact shape, `Date.parse` accepts
 * it, and `2026-08-09` is a day that exists, so every rule passed it. The engine reads it as the
 * TENTH. `toISOString` is the contract's own producer, so asking whether a value survives a parse
 * and a re-print asks the only question that matters, and it cannot have siblings: there is no
 * second field to forget, because every field is compared at once.
 *
 * THE ARGUMENT THAT LEFT THE HOLE IS WORTH KEEPING, because it is the reasoning failure rather than
 * the code one. An earlier version validated the calendar date with a regex anchored at four digits
 * and argued the loose format was fine, because an offset does name a real instant in another
 * notation. That argument is true, and it is what let three forms straight past: `+002026-02-30T…`
 * is conforming expanded-year ISO, `Date.parse` accepts it, it rolls to the second of March, and it
 * never reached the calendar check because it does not open with a digit. `February 30 2026 UTC`
 * does the same. A true argument for the wrong rule is the shape to watch for here.
 *
 * THE ACCEPT SIDE IS MEASURED, NOT ASSUMED, because a rule that refuses is only as good as what it
 * still lets through. Measured against the rule it replaced over 25 values at `f572c95`: exactly two
 * verdicts changed, `2026-08-09T24:00:00.000Z` and `2026-12-31T24:00:00.000Z`, both from shown to
 * refused. Every real instant in that set still shows, including the leap days `2024-02-29`,
 * `2000-02-29` and `0000-02-29`, and `9999-12-31T23:59:59.999Z`. The other end of the shape's range
 * is `0000-01-01T00:00:00.000Z`, because the pattern opens with four digits and takes no sign, and
 * it was measured separately rather than in that set of 25.
 *
 * IT REFUSES NOTHING REAL, AND THERE ARE NOW TWO PRODUCERS RATHER THAN ONE. `server.ts` builds
 * `observedAt` from `capabilities.observedAt.toISOString()`, and `http/contract.ts` builds a row's
 * `createdAt`, `validFrom`, `validUntil` and `evictedAt` the same way off a `Date`. Both are this
 * function's own producer, so nothing either sends can fail it. What it guards against is the wire
 * being something other than those two, which is the only reason `shapes.ts` exists at all.
 */
export function instantFault(value: string): InstantFault | null {
  if (!CONTRACT_INSTANT.test(value)) return 'shape';
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) return 'time';
  return new Date(millis).toISOString() === value ? null : 'exists';
}
