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
