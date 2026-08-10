import { describe, expect, it } from 'vitest';
import { HOLDER, KIND_LABEL, labelled, verdictClass } from '../src/scripts/presentation.ts';

/**
 * The label lookup, which every board on this console runs on values that arrived over HTTP.
 *
 * IT HAD NO TEST OF ITS OWN when it was written, which is the same gap that produced the defect it
 * exists to fix. `TABLE[key] ?? key` reads as "the label, or the raw value", and it is not: a key
 * naming something on `Object.prototype` resolves to an INHERITED value, which is not nullish, so
 * the `??` never fires and the caller is handed a function. Measured in `Console.tsx`, where
 * `(PATH_LABEL[retrievalPath] ?? retrievalPath).toUpperCase()` throws `... is not a function` and
 * takes the pane down with it.
 *
 * Fourteen call sites depend on this returning `undefined` for anything the table does not OWN.
 */

/** Every own name on `Object.prototype`. The lookup must find none of them. */
const PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);

describe('labelled', () => {
  it('returns the value for a key the table owns', () => {
    // The negative control. A helper that returned undefined for everything would satisfy every
    // case below while blanking every label on the site.
    expect(labelled(KIND_LABEL, 'resolution')).toBe('RESOLUTION');
    expect(labelled(HOLDER, 'entity_fact')).toBe('holder h-ent');
  });

  it.each(PROTOTYPE_NAMES)('returns undefined for the inherited name %s', (name) => {
    expect(labelled(KIND_LABEL, name)).toBeUndefined();
    expect(labelled(HOLDER, name)).toBeUndefined();
  });

  it('finds all twelve of them inherited, so the case above is not vacuous', () => {
    // If `Object.prototype` ever stopped carrying these, the table above would be empty and every
    // case in it would pass while testing nothing.
    expect(PROTOTYPE_NAMES.length).toBeGreaterThanOrEqual(12);
    expect(PROTOTYPE_NAMES).toContain('constructor');
    expect(PROTOTYPE_NAMES).toContain('__proto__');
    // And the hazard is real: a bare lookup really does find them.
    expect((KIND_LABEL as Record<string, unknown>)['constructor']).toBeDefined();
  });

  it.each(['', '0', 'length', 'RESOLUTION', 'resolution ', 'Resolution', 'unknown_kind'])(
    'returns undefined for %j, which the table does not own',
    (key) => {
      expect(labelled(KIND_LABEL, key)).toBeUndefined();
    },
  );

  it('returns undefined for null and undefined rather than throwing', () => {
    // `coverageCause` is `string | null` on the wire and is passed straight in at two call sites.
    expect(labelled(KIND_LABEL, null)).toBeUndefined();
    expect(labelled(KIND_LABEL, undefined)).toBeUndefined();
  });
});

describe('verdictClass', () => {
  // Kept beside the lookup because it is the other half of the same rule: a coverage word this
  // console has not been taught renders UNLIT rather than as the reassuring one.
  it.each([
    ['COVERED', 'verdict v-cov'],
    ['PARTIAL', 'verdict v-par'],
    ['UNKNOWN', 'verdict v-unk'],
    ['constructor', 'verdict v-unk'],
    ['covered', 'verdict v-unk'],
    ['', 'verdict v-unk'],
  ])('renders %j as %s', (coverage, expected) => {
    expect(verdictClass(coverage)).toBe(expected);
  });
});
