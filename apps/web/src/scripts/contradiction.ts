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
 * NO CALLER COUNT IS QUOTED HERE ANY MORE, and the number that stood here is why. It said FIVE, and
 * it was a reader's map that went stale in the ordinary course of using the predicate. What a reader
 * wants is `git grep -n 'isBlank(' -- apps/web/src`, which is a command rather than a claim. The
 * guarantee this module can keep is the one it was made for: there is ONE predicate.
 *
 * NOT EVERY SURFACE SUBSTITUTE ARRIVES THROUGH `readText`, which matters to anyone sweeping this
 * category: a `readText(` grep alone misses the ones that call this predicate directly. They do
 * that because what they produce is not a string. Some fold a blank into a NULL the cell already
 * has words for, some choose between whole sentences, and some produce only a CLASS. The sweep
 * that finds all of them is the same command the paragraph above names, for the same reason.
 *
 * NO COUNT OF THOSE IS QUOTED EITHER, AND THE ONE THAT STOOD HERE IS WHY. It gave a number and
 * named that many sites, directly underneath the argument that a caller count in this file goes
 * stale in the ordinary course of using the predicate. The commit that wrote it added another
 * direct caller in the same diff and left it off the list; the change that deleted the number
 * added several more. A figure nobody can check from this line is the thing this file keeps being
 * wrong about, and writing one in the paragraph that says so is how it happened the last time.
 *
 * `shapes.ts` validates the three STATUS fields as bare strings, on purpose, so a value of pure
 * whitespace reaches a page and this is the predicate that stops it being printed as a reason. A
 * failure's two fields arrive by a different route: `shapes.ts` exports a guard for the listing, one
 * for the status body and one for the agent turn, and none at all for a failure body, so a failure's
 * `error` and `detail` are typechecked inside `asFailure` rather than by a shape guard.
 */
export const isBlank = (value: string): boolean => value.trim() === '';

/**
 * One free text string a surface is about to print, or a substitute saying what is true instead.
 *
 * THE PREDICATE ABOVE ALREADY EXISTED AND THE PAGES DID NOT ASK IT, which is the whole of the defect
 * this closes. `shapes.ts` checks `coverageReason`, `query`, `retrievalPath`, `kind` and a row's
 * `state` as bare strings, deliberately and for the reason written there, so pure whitespace passes
 * every guard between the wire and a cell. `coverageCause`, `incidentId`, `supersededBy` and
 * `evictionReason` are `nullOr(isString)`, which is the same hole with a second door: every cell
 * reading them keyed on `=== null` alone, so a blank took the arm meant for a real value.
 *
 * A cell labelled QUERY with nothing after it does not read as a missing value to anybody: it reads
 * as a page that failed to render, on the one product whose argument is that a reader can check what
 * it did.
 *
 * A SUBSTITUTE RATHER THAN A REFUSAL, and the direction matches every other reader in this module's
 * orbit. `readDay` marks one cell rather than refusing a listing, `readLamp` unlights one lamp
 * rather than refusing a status body, and one blank string is worth exactly one substituted cell.
 *
 * THE SUBSTITUTE BELONGS TO THE CALLER because only the caller knows what its cell claims. "none
 * recorded" is true under QUERY and says nothing under Why, and a shared sentence would have to be
 * vague enough to be true in both places, which is how a substitute stops being a measurement.
 *
 * THE ROW STRIPS ARE IN NOW, AND THE DECISION THEY WERE WAITING FOR IS SUBSTITUTE AND MARK.
 * `content` and `assertedBy` on the row strips of both pages were held out of this on purpose,
 * because a memory whose body is blank raises a question no refusal slip raises: whether the page
 * should rack that row at all. It should, and the reason is a mechanism rather than a preference.
 *
 * DROPPING THE ROW WOULD MAKE EACH PAGE MANUFACTURE THE CONTRADICTION IT EXISTS TO DETECT. The
 * archive hands `readListing` the number of rows it is about to rack and the console hands
 * `readRecall` the number of memories it is about to rack, and both refuse the receipt when that
 * number disagrees with the `returned` the API counted. So a page that dropped a blank bodied row
 * would refuse a receipt that was telling the truth, and print a disagreement it had just created
 * itself, on the one product whose argument is that a reader can check what it did. The archive's
 * tombstone doctrine says the same thing from the other side: an evicted row stays racked so the
 * archive is auditable rather than shorter, and a blank body is a worse reason to disappear than an
 * eviction, not a better one.
 *
 * SO ONE BLANK STRING IS WORTH ONE SUBSTITUTED CELL HERE TOO, and the class follows the words, which
 * is what each page's Incident cell already does. The row is left saying exactly what it can
 * support: this memory arrived with no content, nobody is named as asserting it, and neither cell
 * is wearing the confident class while it says so.
 *
 * BOTH SUBSTITUTES CAN COLLIDE WITH A REAL VALUE, WHICH IS ACCEPTED HERE RATHER THAN UNNOTICED. A
 * row whose `assertedBy` really is the string `nobody named` prints the same words as one that
 * arrived with none, and a body reading `This memory arrived with no content.` does the same. THE
 * CLASS SEPARATES THEM ON ONE OF THE TWO AND NOT THE OTHER, which is worth knowing before trusting
 * either: provenance takes the doubt class only when the field is blank, so there the class is the
 * discriminator, while the content cell takes that class when the field is blank OR the row is
 * stale OR it is tombstoned. On a stale row the words and the class are both exactly what a
 * substitution produces, and nothing on the cell says which of the two happened.
 *
 * THE COLLISION IS REACHABLE FROM THIS API'S OWN PRODUCER, and the sentence that stood here said the
 * opposite. It claimed no producer could currently cause it, on the grounds that the write schemas
 * trim both fields and refuse them empty. THAT REASONING CONFUSES EMPTY WITH CHOSEN.
 * `rememberSchema.content`, `supersedeSchema.content` and the shared `assertedBy` in
 * `apps/api/src/agent/tools.ts` are each `z.string().trim().min(1)`, which refuses a blank and
 * accepts any non blank string, including the two this module substitutes. A model calling
 * `remember` with a content of `This memory arrived with no content.` is writing a memory the
 * schema is happy with, and the row it produces is the ambiguous one.
 *
 * THE STALE ROW IS WHERE IT ACTUALLY BITES, which the paragraph above already established and the
 * deleted sentence then contradicted two lines later. A stale row carrying that content as its real
 * body renders the same words AND the same `say doubt` class as a blank bodied row, so on that one
 * cell there is nothing left to tell them apart. A false impossibility claim is worse here than no
 * claim, because it hands the next reader a reason not to address something that can happen.
 *
 * THE LAMP'S `state` IS THE ONE SUBSTITUTE ON THESE SURFACES THAT DOES NOT HAVE THIS PROBLEM, and
 * the difference is instructive: an unrecognised state gets a NOTE that quotes the word back, so a
 * lamp whose state really is `no state sent` reads differently from one that arrived blank. A table
 * cell has nowhere to put that note.
 *
 * SO THE OPEN AMBIGUITY IS ONE CELL AND NOT TWO, AND THIS SAID TWO. Provenance carries its own
 * discriminator already: both boards read `isBlank(assertedBy) ? 'val doubt' : 'val'`, so a row
 * asserting the literal string `nobody named` takes the CONFIDENT class while a blank one does not.
 * The words collide there and the class does not. That is the split stated three paragraphs up, and
 * the conclusion then widened straight past it, which is the same self contradiction inside one
 * docblock that this whole change was written to correct. What is left with nothing to separate it
 * is the CONTENT cell on a stale or tombstoned row, where the doubt class is produced either way.
 *
 * A `given` TWIN IS THEREFORE REDUNDANT ON PROVENANCE AND IS NOT PROPOSED THERE. If the remaining
 * cell is worth closing, the twin belongs on `content` alone, the way `name` has one. It is NOT
 * done here, and the reason is scope rather than impossibility.
 *
 * THIS HAS BEEN TOO SHORT THREE TIMES, AND EVERY TIME A REVIEW MEASURED IT. The first version named
 * two fields and stood over eight unguarded ones: the row's `kind` in `cells.tsx`, which BOTH boards
 * import, the row's `state`, the receipt's `kinds`, `incidentId` on both pages, `supersededBy`,
 * `evictionReason`, a refusal chip's own words, and a write attempt's `kind`. The second version
 * guarded those eight and then claimed the unguarded set had been COUNTED, while two more stood
 * outside it: `AgentTurnResponse.text` and the verbatim receipt record. The third said nothing else
 * printed a received string unguarded, and a lamp's `state` did, on two islands at once.
 *
 * `text` IS STILL THE ONE THAT MATTERED, AND THE SENTENCE SAYING SO NEEDED NARROWING. It called
 * `text` the only free text field on this API the loop does not author, which is not true: a row's
 * `content` and `assertedBy` are not authored by the loop either, they are read back out of the
 * store. What is true is the part that bit. `text` is the only one the loop neither authors NOR
 * validates: `rememberSchema` and `supersedeSchema` trim `content` and `assertedBy` and refuse them
 * empty, and the repository refuses a blank `assertedBy` once more before the write, while
 * `judgeAnswer` deliberately does not police the length of an answer. So a blank `text` is the one
 * blank on these boards this API's own producer can emit, and the row fields are the ordinary case:
 * they need a wire that is not this API, exactly like everything else guarded here.
 *
 * DO NOT READ THE DATABASE AS A SECOND GUARANTEE ON THOSE TWO. `content_is_present` and
 * `provenance_is_present` both test `length(...) > 0`, and three spaces have length three, so
 * whitespace satisfies both constraints. What keeps a blank `content` out of the store is the
 * schema at the tool boundary, by itself. `assertedBy` has the repository's own trim behind it as
 * well, which is the asymmetry: two fields that look identical from a cell are not identically held.
 *
 * SO THIS PARAGRAPH NAMES ITS METHOD RATHER THAN ITS CONCLUSION, which is what three wrong
 * conclusions bought. The sweep is every interpolation of a dotted field under
 * `apps/web/src/islands`, each one resolved to the value behind it rather than grepped for the
 * guarded form, because both misses that got through were fields nobody thought to look at. Say
 * what that form does NOT reach, so the next reader widens it rather than trusting it: a bare local,
 * a template literal, and an interpolation carrying its own `??` arm are all outside it, and each of
 * those was read here by other means.
 *
 * WHAT IS OUTSIDE THE CATEGORY IS NAMED RATHER THAN COUNTED. `Exchange.question` is the operator's
 * own typing and never crossed the wire. Everything else that form reaches resolves to a number, a
 * key, a coverage verdict `isCoverage` has already narrowed to the three the contract declares, a
 * string an EQUALITY FILTER has already narrowed to named literals, or a string some reader has
 * already put through this predicate: `readLamp` and `readDay` for the status and archive values,
 * `asFailure` for a failure's two fields, and the console's own `writeAttempts`, `failedRecalls`
 * and `ReceiptRecord` for the transcript's. (That last one is the reader, not `receipts`, which
 * only collects: naming the collector would send a checker to a function with no guard in it.)
 *
 * THE EQUALITY FILTER IS THE FIFTH MECHANISM AND THE LIST WAS WRITTEN WITHOUT IT, which matters
 * because the list is the thing a checker works from. `entry.tool` is printed on the console's
 * write attempt strip and it is a received transcript string: no reader puts it through this
 * predicate, and it is not a number, a key or a verdict. What makes it safe is that `writeAttempts`
 * skips every turn whose `name` is neither `remember` nor `supersede`, so the only values that can
 * reach that cell are two literals this repository wrote itself. A guard by exclusion is still a
 * guard, and an enumeration that does not know the shape of one either reports it as a hole or
 * walks past the next field held the same way. A reader doubting any of this should re-run the
 * sweep rather than trust the sentence.
 *
 * TWO PAGES SHARING ONE SUBSTITUTE WORD FOR WORD IS DELIBERATE, not a copy that drifted. The
 * substitute belongs to the CELL, and where two cells on two pages make the identical claim about
 * the identical field, the honest sentence is the identical sentence. It is `gate:dup` invisible at
 * this size, so this paragraph is the only thing recording that it was a decision.
 */
export const readText = (value: string, substitute: string): string => (isBlank(value) ? substitute : value);

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
