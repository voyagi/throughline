import { describe, expect, it } from 'vitest';
import { createFakeDatabase } from './fake-database.ts';

/**
 * The test double's own controls.
 *
 * This file exists because a review asked the question this repository asks of every gate: the
 * placeholder guard catches real mistakes in `repository.ts`, but what catches a mistake in the
 * GUARD? Nothing did. Two mutations proved it - neutering `assertPlaceholdersMatch` with an early
 * return, and widening its comparison to tolerate an off-by-one in precisely the direction its own
 * docblock claims to catch - and both left the whole suite green.
 *
 * `vitest.config.ts` states the standard being applied here: a gate whose own controls are untested
 * is a gate nobody has watched fail. That applies to a fixture that every other test trusts most of
 * all, because a fixture that quietly stops checking makes every suite that uses it read greener
 * than it is.
 */

const anyRows = () => [];

describe('createFakeDatabase placeholder guard', () => {
  // EACH CASE NAMES THE RULE IT EXPECTS TO FIRE, and that is not decoration. The first version of
  // this table asserted a bare `.rejects.toThrow()`, and planting an off-by-one TOLERANCE into the
  // count comparison left all of it green: `('SELECT $2', [1,2,3])` was still refused, but by the
  // NUMBERING rule noticing $1 was skipped, not by the count rule the case was written for. A rule
  // firing is not the same as YOUR rule firing, and only the message can tell them apart.
  it.each([
    ['more placeholders than parameters', 'SELECT $3', [1, 2], /references up to \$3 but was given 2/],
    ['more parameters than placeholders', 'SELECT $1, $2', [1, 2, 3], /references up to \$2 but was given 3/],
    ['a gap in the numbering', 'SELECT $1, $3', [1, 2, 3], /skips \$2 while referencing \$3/],
    ['parameters bound to a statement with none', 'SELECT 1', [1], /binds 1 parameter\(s\) and references none/],
  ])('refuses %s, the way a real driver would', async (_label, text, values, message) => {
    const db = createFakeDatabase(anyRows);
    await expect(db.query(text, values)).rejects.toThrow(message);
  });

  it.each([
    ['a statement whose placeholders and parameters agree', 'SELECT $1, $2', [1, 2]],
    ['a statement with neither', 'SELECT 1', []],
    ['a repeated placeholder', 'SELECT $1 WHERE x = $1', [1]],
  ])('accepts %s', async (_label, text, values) => {
    // The negative controls. Without them a guard that refused EVERY statement would satisfy the
    // cases above while making the whole fixture useless, which is a control that cannot fail.
    const db = createFakeDatabase(anyRows);
    await expect(db.query(text, values)).resolves.toEqual([]);
  });

  it('checks statements issued on a transaction client, not only on the database', async () => {
    // The reason the guard was moved into a shared `run` at all: `transaction` used to hand out an
    // empty object, so every statement `remember` and `supersede` issue was unrecorded, unchecked,
    // and unexecuted. A guard only inspects what runs through it.
    const db = createFakeDatabase(anyRows);
    await expect(
      db.transaction((client) => client.query('SELECT $3', [1, 2])),
    ).rejects.toThrow(/references up to \$3 but was given 2/);
  });

  it('records which client issued each statement', async () => {
    // `via` is the field that makes "inside the transaction" assertable. Without it the two are
    // indistinguishable in `queries`, and a statement moved out of a transaction reads identically.
    const db = createFakeDatabase(anyRows);
    await db.query('SELECT $1', [1]);
    await db.transaction((client) => client.query('SELECT $1', [2]));

    expect(db.queries.map((query) => query.via)).toEqual(['db', 'tx']);
  });
});
