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
 * consequence: `(PATH_LABEL[retrievalPath] ?? retrievalPath).toUpperCase()` in `Console.tsx`
 * throws `TypeError: ... is not a function`, and a page that throws during render is the blank pane
 * this console exists to argue against.
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

/** The time out of an ISO instant. The date is on the strip already; the clock is what changes. */
export const clock = (iso: string): string => iso.slice(11, 19);

/** The date out of an ISO instant, for a row whose whole point is which day it was true. */
export const day = (iso: string): string => iso.slice(0, 10);
