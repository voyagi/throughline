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
  /** Two fields of the receipt disagree with each other. Nothing that arrived is involved. */
  | 'internal'
  /** The receipt's own count disagrees with the rows or strips that arrived beside it. */
  | 'rack';

/** One way a receipt failed to be one consistent statement, with the phrase a page prints for it. */
export interface Contradiction {
  readonly kind: ContradictionKind;
  readonly phrase: string;
}

/** A single field carrying a value that is not a measurement of the kind it claims to be. */
export const malformed = (phrase: string): Contradiction => ({ kind: 'malformed', phrase });

/** Two of the receipt's own fields disagreeing, with nothing that arrived involved. */
export const internal = (phrase: string): Contradiction => ({ kind: 'internal', phrase });

/** The receipt disagreeing with the rows or strips that arrived beside it. */
export const rack = (phrase: string): Contradiction => ({ kind: 'rack', phrase });
