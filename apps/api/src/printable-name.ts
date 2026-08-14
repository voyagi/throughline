/**
 * Render a name the far side chose so it cannot reshape, forge, or hide inside the line it lands in.
 *
 * A NAME IS NOT A WORD. It is whatever bytes the body carried. Everything here is printed into an
 * operator's log, and a log line is read by a person deciding what broke. A newline inside a name
 * splits one finding across two lines, so half of it reads as a separate record and the reader loses
 * which reply the rest belonged to, which is worth more to somebody forging a log than the fault
 * itself is worth to them. Control characters are ESCAPED rather than stripped, because a key
 * differing from a declared member only by an invisible character is precisely the thing being
 * diagnosed, and a stripped one would render identical to the member it is impersonating. Format
 * characters are in the class for the same reason and not a different one: a bidi override reorders
 * what a reader sees without changing a byte, which is the newline problem with its seams hidden.
 * Line and paragraph separators end a line in most viewers and in every JS string context. Lone
 * surrogates are in because a log written as UTF-8 turns every one of them into the same replacement
 * character, which is impersonation again, and because the record stops being well-formed UTF-8.
 *
 * The class is written as property escapes because writing the ranges as unicode escape sequences
 * put the characters THEMSELVES into the source, a NUL byte among them.
 *
 * THE ENCODING IS PREFIX-FREE, WHICH IS THE WHOLE POINT AND WAS THE PART THAT WAS WRONG. A
 * variable-width escape with no delimiter lets two different names render the same: an ESC followed
 * by the literal text "ca0" and the single character U+1BCA0 both produced `\x1bca0`. Measured, not
 * argued. So the escape is delimited, and the delimiter's own character is escaped too. A backslash
 * off the wire becomes two, so nothing arriving as text can imitate an escape this function wrote.
 *
 * AND THE ESCAPE IS NOT THE ONLY THING THIS FUNCTION PRINTS, WHICH IS WHERE THE PROPERTY BROKE
 * NEXT. The alphabet was reserved for escapes and left open for the two MARKERS, so a name could
 * still write one for itself: `"a"*57 + "..."` and `"a"*57 + U+202E + more` both rendered
 * `"a"*57 + "..."`, byte for byte. Measured. The second one carried a right-to-left override and
 * the marker hid the whole of it, which is the impersonation this function exists to stop wearing
 * the clothes of the truncation. So EVERY string this code contributes now sits behind the
 * backslash, markers included. Nothing the wire sends can reach a lone one.
 *
 * Read back, the complete alphabet after a lone backslash, all four distinguished by their first
 * character: `\` is one literal backslash, `x{...}` is that code point, `empty` is the empty name,
 * and `...` is the truncation. Nothing else in the output contains an unpaired backslash, so the
 * ESCAPING is injective: two names that both fit the budget cannot print alike, and a cut output
 * can never pass for a whole one. The cut is the one stated exception, because a prefix is all it
 * keeps: two cut names print alike when they agree on everything the cut keeps, and the reserved
 * marker is the disclosure, so `\...` reads "the tail is unknown here", never "these were equal".
 * That property is the only reason this function exists, so an assertion that two escaped names
 * differ is worth nothing unless the pair could have collided. An earlier version of this paragraph
 * claimed nothing else STARTS with a backslash, which was false the moment `\empty` was added, and
 * it was repeated into a commit message from here. The version after it claimed injectivity with no
 * truncation carve-out, measured false by two names of sixty-one and sixty-two characters.
 *
 * THE CODE POINT, NOT THE FIRST UNIT OF IT. `charCodeAt` reports the high surrogate of an astral
 * character, so every character in the TAG block, which is the standard carrier for invisible text,
 * rendered as the same four digits, and the number an operator was told to look up named an
 * unassigned surrogate. `for...of` walks code points, so a well-formed pair is never split here.
 *
 * THE CAP COUNTS WHOLE ESCAPES. Slicing the escaped string can cut an escape, and the result is not
 * merely unreadable: a listing cut mid-escape ended on `\x20`, a VALID escape meaning SPACE, where
 * the wire had sent a right-to-left override. Capping the RAW name instead hands a control-heavy
 * name up to NINE times the budget, since a TAG character spends four characters on the delimiters
 * and five on the digits. Stopping before the unit that would cross the line is neither.
 */
const RESHAPES_A_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/** How much of one name reaches the log. Names are bounded, and the lines holding them have their own. */
const NAME_BUDGET = 60;

/**
 * The two things this code says for itself, both behind the reserved backslash.
 *
 * A wire backslash always doubles, so a lone one is this code speaking and cannot be forged. Before
 * that, a name ending in three dots was indistinguishable from a truncated one, and a key named
 * `... (1 of 9 shown)` made a list that had NOT been cut report a count the far side chose.
 */
const TRUNCATED = '\\...';
const cutMarker = (shown: number, total: number): string => `${TRUNCATED} (${shown} of ${total} shown)`;

/**
 * How much of a "top level keys were:" list reaches the log.
 *
 * Shared rather than declared twice because BOTH adapters write that sentence about a body the
 * provider sent, and the pair of them having one rule with two copies is what this module exists to
 * end. Budgets belonging to one adapter's own shapes stay in that adapter.
 */
export const TOP_LEVEL_KEY_BUDGET = 800;

export function printableName(name: string): string {
  // A key really can be the empty string, and it rendered as a blank stretch mid-sentence that read
  // as a rendering fault rather than as the finding. Marked with a backslash, which is the one
  // character no name can produce for itself, so a key literally called "\empty" stays distinct.
  if (name.length === 0) return '\\empty';
  let printable = '';
  for (const character of name) {
    // `?? 0` NARROWS THE TYPE AND NEVER RUNS. `for...of` yields code points, so it cannot produce an
    // empty string, and `codePointAt(0)` returns undefined only past the end: measured across lone
    // surrogates and a REVERSED surrogate pair, it was defined every time. This used to be a visible
    // `point === undefined ? character` branch, which read as coverage, provided none, and had the
    // RAW character as its fallback, so the one impossible path was the unescaped one. If it ever
    // did run it would now escape rather than pass through, which is the safe direction.
    const point = character.codePointAt(0) ?? 0;
    const unit = RESHAPES_A_LINE.test(character)
      ? `\\x{${point.toString(16).padStart(2, '0')}}`
      : character === '\\'
        ? '\\\\'
        : character;
    if (printable.length + unit.length > NAME_BUDGET) return `${printable}${TRUNCATED}`;
    printable += unit;
  }
  return printable;
}

/**
 * Join already-rendered items, stopping BEFORE the one that would cross the budget.
 *
 * The same rule as the name cap, one level out, and for the same measured reason. Slicing the joined
 * string cuts an ITEM, and when that item is an escaped name it cuts an ESCAPE, which is how a
 * right-to-left override came out as a space. A name is bounded but a reply carries as many blocks
 * as the body says, so without this the wire still decides how long the record is: a thousand of the
 * shortest unreadable block wrote 12,537 characters, and a line that long is usually cut by
 * something downstream that says nothing about having cut it, so the finding looks delivered and is
 * gone. Both counts survive the cut, because how many there were is what an operator acts on.
 *
 * THE MARKER IS RESERVED, WHICH MATTERS MORE HERE THAN ONE LEVEL DOWN. This is the only line in
 * either adapter that states a NUMBER about the wire's own reply, so an unreserved marker let a key
 * named `... (1 of 9 shown)` assert a count in a list that was never cut. Items arriving here have
 * all been through `printableName` or are literals this code chose, which is what makes a lone
 * backslash unforgeable, and is worth re-checking if a sixth caller ever appears.
 */
export function joinWithinBudget(
  items: readonly string[],
  separator: string,
  budget: number,
): string {
  let width = 0;
  let shown = 0;
  for (const item of items) {
    const cost = item.length + (shown === 0 ? 0 : separator.length);
    if (width + cost > budget) break;
    width += cost;
    shown += 1;
  }
  if (shown === items.length) return items.join(separator);
  const marker = cutMarker(shown, items.length);
  const kept = items.slice(0, shown).join(separator);
  return kept.length > 0 ? `${kept}${separator}${marker}` : marker;
}
