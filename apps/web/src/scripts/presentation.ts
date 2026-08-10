import type { Coverage, MemoryKind } from './types.ts';

/**
 * The mappings from a wire value to the class or word that renders it.
 *
 * EXTRACTED RATHER THAN COPIED, and the reason is the same one that created
 * `@throughline/contract`. These four lived in `Console.tsx`, the archive island needs every one of
 * them, and `npm run gate:dup` refuses a second copy. It is right to: a holder colour keyed to a
 * memory kind is a decision two boards must make identically, and this repository's rule is that
 * such a decision lives in one module both import rather than in a comment asking a reader to keep
 * two lists in step.
 *
 * The concrete failure that rule prevents here is a kind added on the server rendering as a
 * COLOURLESS holder on one board and a correct one on the other, because on this design an unlit
 * holder is a claim about the memory rather than about the console.
 */

/**
 * Look a wire value up in one of these tables, safely.
 *
 * EVERY ONE OF THESE TABLES IS INDEXED BY A STRING THAT ARRIVED OVER HTTP, and `TABLE[key] ?? key`
 * does not do what it reads as. A key naming something on `Object.prototype` - `constructor`,
 * `toString`, `__proto__`, `valueOf` - resolves to an INHERITED value, which is not nullish, so the
 * `??` never fires and the caller gets a function where it expected a label. A review measured the
 * consequence: the PRE-`labelled` form `(PATH_LABEL[retrievalPath] ?? retrievalPath).toUpperCase()`,
 * on the ONE PATH reading that uppercases it in `Console.tsx`, threw `TypeError: ... is not a
 * function`, and a page that throws during render is the blank pane this console exists to argue
 * against. `Console.tsx` reads `retrievalPath` THREE times: two look a label up, at the receipt
 * strip and at the recall strip, and only the recall strip ever called `.toUpperCase()`. The third
 * compares the raw value to `'none'` and looks nothing up, so it was never exposed to this at all.
 * Naming the exclusion is the same rule a count in prose follows. THE ERA MATTERS BECAUSE THE
 * EXPRESSION IS GONE: both label readings call `labelled` now, so a reader grepping
 * `Console.tsx` for the quoted form finds nothing and cannot tell a fixed defect from a wrong
 * citation. This carried a line number until a review found the line had moved, and dropping the
 * number without dating the expression traded one unfollowable reference for another.
 *
 * THE SAME CLASS OF MISTAKE, TWICE IN ONE FILE, IS WHY THIS IS A HELPER AND NOT A FIX AT ONE SITE.
 * `isCoverage` in `shapes.ts` tests `=== true` and is immune; `isTurnView`, written an hour later in
 * the same session, tested `!== undefined` and was not. There are fourteen of these lookups across
 * three islands. A helper is the only version of this fix that cannot be applied to thirteen of them.
 *
 * OWN PROPERTIES ONLY, so an unrecognised value falls through to the caller's fallback and prints as
 * itself - which is the behaviour these tables are documented to have, and which they did not have.
 */
export function labelled<Table extends object>(
  table: Table,
  key: string | null | undefined,
): Table[keyof Table] | undefined {
  if (key === null || key === undefined) return undefined;
  // The cast is the whole reason this is one function rather than fourteen expressions: the tables
  // are keyed by closed unions, the key is a string off the wire, and TypeScript is right that those
  // do not line up. `hasOwnProperty` is what makes the lookup safe; the cast just lets it be written.
  return Object.prototype.hasOwnProperty.call(table, key)
    ? (table as Record<string, Table[keyof Table]>)[key]
    : undefined;
}

/** A holder colour per kind. `observation` deliberately has none: it is the neutral base. */
export const HOLDER: Readonly<Record<MemoryKind, string>> = {
  observation: 'holder',
  resolution: 'holder h-res',
  runbook_fact: 'holder h-run',
  rejected_hypothesis: 'holder h-rej',
  entity_fact: 'holder h-ent',
};

export const KIND_LABEL: Readonly<Record<MemoryKind, string>> = {
  observation: 'OBSERVATION',
  resolution: 'RESOLUTION',
  runbook_fact: 'RUNBOOK FACT',
  rejected_hypothesis: 'REJECTED HYPOTHESIS',
  entity_fact: 'ENTITY FACT',
};

/**
 * The verdict lamp's class.
 *
 * UNKNOWN takes the unlit class and never a colour, because a colour would be a claim somebody
 * earned by measuring. Written as a fallback rather than a third comparison so a coverage value this
 * console has not been taught renders unlit rather than as the reassuring one.
 */
export const verdictClass = (coverage: Coverage | string): string =>
  coverage === 'COVERED' ? 'verdict v-cov' : coverage === 'PARTIAL' ? 'verdict v-par' : 'verdict v-unk';

/**
 * The time out of an ISO instant. The date is on the strip already; the clock is what changes.
 *
 * A BARE SLICE, WHICH IS AN EXEMPTION AND NOT AN OVERSIGHT, so this is the claim it makes: every
 * value that reaches this function was minted by this browser rather than read off the wire. That
 * holds structurally rather than by care. `Console.tsx` is the only module that imports it, all
 * eight of its call sites read an `at`, and the only thing that writes an `at` is `Console` itself,
 * with `new Date().toISOString()` when a question is sent. Nothing on `AgentTurnResponse` carries an
 * instant to confuse it with: the one timestamp-shaped field there is `budget.day`, which no surface
 * prints.
 *
 * ITS SIBLING SAT RIGHT HERE AND WAS NOT SO LUCKY. `day` was the same bare slice, and all three of
 * ITS call sites read WIRE timestamps, so a row could print `2026-02-30`, a day that never happened,
 * and `2026-08-09T24:00:00.000Z` printed a date the engine reads as the tenth. It is now `readDay`
 * in `archive-state.ts`, which asks `instantFault` before it slices anything. Two functions one line
 * apart, identical in body, and only one of them was safe: the difference was never in the code, it
 * was in who calls it, which is exactly the kind of safety that stops being true without a warning.
 *
 * SO IF A WIRE INSTANT EVER NEEDS A CLOCK, it needs `readDay`'s treatment and not this. Widen that
 * reader rather than reaching for this one, and `/status` has already walked this road: it formats
 * its clock with `clockOf` from a `Date` it built AFTER the body passed the guard, because slicing
 * `observedAt` read the wrong instant off any timestamp carrying an offset.
 */
export const clock = (iso: string): string => iso.slice(11, 19);
