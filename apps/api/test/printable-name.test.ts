import { describe, expect, it } from 'vitest';
import { joinWithinBudget, printableName, TOP_LEVEL_KEY_BUDGET } from '../src/printable-name.ts';

/**
 * The two functions both Bedrock adapters use to print strings the far side chose.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE ADAPTER TESTS. Both adapters have their own tests for
 * these, and those tests read a whole sentence and check that one expected substring is in it, which
 * is the right test for "does the adapter route its names through this". It is a poor test for the
 * function's own boundaries: a listing of blocks cannot be made to end exactly on a budget, so a cap
 * of 800 and a cap of 924 produced the same sentence and the number in the source was decoration.
 * Here the inputs are chosen character by character, so the boundary is pinned rather than bracketed.
 */
describe('printableName', () => {
  it('leaves an ordinary name alone', () => {
    expect(printableName('toolUseId')).toBe('toolUseId');
  });

  // THE PROPERTY THE WHOLE FUNCTION EXISTS FOR, AND IT WAS FALSE FOR THE FIRST TWO VERSIONS. An
  // escape is only worth writing if two different names cannot produce the same output, because the
  // failure being diagnosed IS a name impersonating a declared member. A variable-width escape with
  // no delimiter is not injective: an ESC followed by the literal text "ca0" and the single character
  // U+1BCA0 both rendered `\x1bca0`. Measured, not argued. Delimiting the digits fixes that pair and
  // opens the next one, because a name can then simply CONTAIN the text `\x{1b}` and imitate the
  // escape directly, so the delimiter's own character is escaped too. Read back: a backslash
  // introduces another backslash, `x{...}`, `empty`, or the `...` of a cut, four members told apart
  // by their first character, and nothing off the wire ever reaches a lone one. Injective, with the
  // one carve-out the cut row below pins: a prefix is all a cut keeps.
  it('cannot be made to print two different names the same way', () => {
    const esc = String.fromCodePoint(0x1b);
    expect(printableName(`${esc}ca0`)).not.toBe(printableName(String.fromCodePoint(0x1bca0)));
    expect(printableName(`${esc}ca0`)).toBe('\\x{1b}ca0');
    expect(printableName(String.fromCodePoint(0x1bca0))).toBe('\\x{1bca0}');
    // The second collision, which only became reachable once the first was closed.
    expect(printableName('\\x{1b}')).not.toBe(printableName(esc));
    expect(printableName('\\x{1b}')).toBe('\\\\x{1b}');
    // And the empty name, marked with the one character no name can produce for itself.
    expect(printableName('')).toBe('\\empty');
    expect(printableName('\\empty')).not.toBe(printableName(''));
  });

  // THE CODE POINT, NOT ITS FIRST UNIT. `charCodeAt` reports the high surrogate, so every character
  // in the TAG block, which is the standard carrier for invisible text, printed as the same four
  // digits and the number an operator was told to look up named an unassigned surrogate.
  it('escapes a whole code point, and never splits a well formed pair', () => {
    expect(printableName(String.fromCodePoint(0xe0041))).toBe('\\x{e0041}');
    expect(printableName(String.fromCodePoint(0xe0042))).toBe('\\x{e0042}');
    // An astral character that reshapes nothing is left exactly as it arrived. `for...of` walks code
    // points, so adding lone surrogates to the class below cannot touch ordinary astral text.
    const grinning = String.fromCodePoint(0x1f600);
    expect(printableName(`a${grinning}b`)).toBe(`a${grinning}b`);
  });

  // A LONE SURROGATE IS NOT A CHARACTER, IT IS HALF OF ONE, and it went through raw because the class
  // named the four categories a reader would think of and stopped. Every distinct lone surrogate
  // becomes the same replacement character once the log is written as UTF-8, which is impersonation
  // again, and the record stops being well formed UTF-8 on the way.
  it('escapes each class member, one row each', () => {
    const rows: ReadonlyArray<readonly [number, string]> = [
      [0x00, '\\x{00}'],
      [0x0a, '\\x{0a}'],
      [0x0d, '\\x{0d}'],
      [0x1b, '\\x{1b}'],
      [0x200b, '\\x{200b}'],
      [0x202e, '\\x{202e}'],
      [0x2028, '\\x{2028}'],
      [0x2029, '\\x{2029}'],
      [0xd800, '\\x{d800}'],
      [0xdfff, '\\x{dfff}'],
    ];
    for (const [point, expected] of rows) {
      expect(printableName(String.fromCodePoint(point))).toBe(expected);
    }
  });

  // THE CAP STOPS BEFORE THE UNIT THAT WOULD CROSS THE LINE, which is neither of the two things it
  // could easily have been. Slicing the escaped output cuts an escape. Capping the RAW name instead
  // hands a control heavy name up to NINE times the budget, four characters of delimiter and five of
  // digits per TAG character. Eight does not divide sixty, so this row separates the three.
  it('caps on whole escapes rather than on characters', () => {
    const bidi = String.fromCodePoint(0x202e);
    expect(printableName(bidi.repeat(40))).toBe(`${'\\x{202e}'.repeat(7)}\\...`);
    // The plain case, where the budget lands between characters rather than inside an escape.
    expect(printableName('v'.repeat(200))).toBe(`${'v'.repeat(60)}\\...`);
    // Exactly at the line, with nothing to mark.
    expect(printableName('v'.repeat(60))).toBe('v'.repeat(60));
    expect(printableName('v'.repeat(61))).toBe(`${'v'.repeat(60)}\\...`);
  });

  // AND WHAT A CUT KEEPS IS ONLY A PREFIX, the carve-out the injectivity sentence needs. Names that
  // FIT the budget cannot collide, names cut at it can, and the reserved marker is the in-band
  // disclosure that a tail went unread: `\...` reads "the tail is unknown here", never "these were
  // equal". A cut output can never pass for a whole one, which the marker row below pins from the
  // hostile side.
  it('collides only past the cut, and the marker discloses it', () => {
    expect(printableName('a'.repeat(61))).toBe(printableName('a'.repeat(62)));
    expect(printableName('a'.repeat(61))).toBe(`${'a'.repeat(60)}\\...`);
    expect(printableName('a'.repeat(60))).not.toBe(printableName('a'.repeat(61)));
  });

  // AND THE MARKER IS PART OF THE ALPHABET, WHICH IS WHERE INJECTIVITY BROKE THE SECOND TIME. The
  // escape was reserved and the two markers were not, so a name could still write one for itself.
  // These two names differ, one of them carries a right-to-left override, and before the marker
  // moved behind the backslash they printed the same 60 characters. The hostile one is the reason
  // this matters: the marker hid the override completely, so the truncation itself said something
  // the far side chose, which is the exact sentence the module docblock uses about the escape.
  it('cannot be made to print a truncation the name wrote itself', () => {
    const innocent = `${'a'.repeat(57)}...`;
    const hostile = `${'a'.repeat(57)}${String.fromCodePoint(0x202e)}${'z'.repeat(20)}`;
    expect(printableName(innocent)).not.toBe(printableName(hostile));
    expect(printableName(innocent)).toBe(`${'a'.repeat(57)}...`);
    expect(printableName(hostile)).toBe(`${'a'.repeat(57)}\\...`);
    // A name that literally spells the marker is doubled, so it cannot be read as one.
    expect(printableName('\\...')).toBe('\\\\...');
    expect(printableName('\\...')).not.toBe(printableName('q'.repeat(61)));
  });
});

describe('joinWithinBudget', () => {
  it('returns the whole list untouched when it fits', () => {
    expect(joinWithinBudget(['ab', 'cd'], ', ', 6)).toBe('ab, cd');
    expect(joinWithinBudget([], ', ', 6)).toBe('');
    expect(joinWithinBudget(['only'], ', ', 4)).toBe('only');
  });

  // THE BOUNDARY, TO THE CHARACTER. Every earlier version of this rule was pinned only through a
  // rendered sentence, where the item widths are whatever the fixture happened to produce, so a
  // budget anywhere in a 124 wide band passed. Here one character decides it.
  it('keeps a list that exactly fills the budget and breaks on the one that does not', () => {
    expect(joinWithinBudget(['a'.repeat(10)], ',', 10)).toBe('a'.repeat(10));
    expect(joinWithinBudget(['a'.repeat(11)], ',', 10)).toBe('\\... (0 of 1 shown)');
    // AND THE SEPARATOR IS PART OF THE COST. Counting only the items lets a two item list overrun by
    // the width of the separator, which is the same one-character-too-many the row above pins.
    expect(joinWithinBudget(['ab', 'cd'], ', ', 5)).toBe('ab, \\... (1 of 2 shown)');
    expect(joinWithinBudget(['ab', 'cd'], ', ', 6)).toBe('ab, cd');
  });

  // THE ONLY LINE IN EITHER ADAPTER THAT STATES A NUMBER ABOUT THE WIRE'S OWN REPLY, so a forgeable
  // marker here does not merely hide a name, it asserts a count that is false. Measured before the
  // fix: a list well inside its budget, holding a key the far side named `... (1 of 9 shown)`,
  // rendered byte-identical to a genuine cut of nine. An operator reads a truncation that never
  // happened and a total the provider chose. Items reaching this function have all been through
  // `printableName`, so a lone backslash is unforgeable and the two cases separate.
  it('cannot be made to report a cut that did not happen', () => {
    const forged = ['ab', printableName('... (1 of 9 shown)')];
    const fits = joinWithinBudget(forged, ', ', 100);
    const cut = joinWithinBudget(['ab', 'cdefghijklmnop'], ', ', 5);
    expect(fits).not.toBe(cut);
    expect(fits).toBe('ab, ... (1 of 9 shown)');
    expect(cut).toBe('ab, \\... (1 of 2 shown)');
    // And the harder one: a key that spells the RESERVED marker is doubled on the way in.
    expect(joinWithinBudget(['ab', printableName('\\... (1 of 9 shown)')], ', ', 100)).toBe(
      'ab, \\\\... (1 of 9 shown)',
    );
  });

  // BOTH COUNTS SURVIVE THE CUT. How many arrived is the number an operator acts on, and how many of
  // them they are looking at is what stops a cut list reading as the whole of it. The marker is
  // allowed past the budget on purpose: the budget bounds what the FAR SIDE decides, and the marker
  // is the one part of the line this code chose.
  it('reports how many it showed and how many there were', () => {
    const items = Array.from({ length: 50 }, () => 'xxxx');
    const joined = joinWithinBudget(items, ', ', 40);
    expect(joined).toContain('\\... (7 of 50 shown)');
    expect(joined.startsWith('xxxx, xxxx')).toBe(true);
    // Seven items of four with six separators of two is forty exactly. An eighth would need forty six.
    expect(joined.slice(0, joined.indexOf(', \\...'))).toHaveLength(40);
  });

  // WHEN NOTHING FITS THE LINE STILL SAYS SO. Returning an empty string here would read as a reply
  // that carried nothing, which is a different finding from one this refused to print.
  it('prints the marker alone rather than nothing', () => {
    expect(joinWithinBudget(['a'.repeat(99)], ', ', 10)).toBe('\\... (0 of 1 shown)');
  });

  it('shares one budget for the sentence both adapters write', () => {
    expect(TOP_LEVEL_KEY_BUDGET).toBe(800);
  });
});
