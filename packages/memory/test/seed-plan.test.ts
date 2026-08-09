import { describe, expect, it } from 'vitest';
import { decideSeed, describeSeedDecision, type SeedDecision, type SeedSurvey } from '../src/seed-plan.ts';
import type { Coverage } from '../src/types.ts';

/**
 * Every state the seed CLI can find its workspace in, and everything it says about each one.
 *
 * THIS FILE EXISTS BECAUSE THE FIX IT COVERS HAD NOTHING THAT COULD GO RED. A review restored the
 * defect verbatim and the whole suite stayed byte-identical at 993 passed, while the commit fixing
 * it quoted that number directly beneath. The decision was inside a CLI's `main()`, so testing it
 * meant opening a database.
 *
 * THE NEXT REVIEW FOUND THE SAME HOLE ONE HALF OVER. Extracting the decision left the CONSEQUENCE
 * in `main()`, and deleting `process.exitCode = 1` from either refusal left the suite at 1004
 * passed. So the second half of this file pins what each outcome prints and what it exits with.
 *
 * It carries no total. An earlier version opened by naming a number of states, and a review
 * measured it: the figure was the length of the case list rather than a count of anything about the
 * workspace. The structure is one case per branch, plus a sibling case for every pair whose ORDER
 * the function depends on, plus one case per outcome's message and exit code.
 */

const EXPECTED = 6;
const WORKSPACE = 'demo';
const target = { workspace: WORKSPACE, expectedRows: EXPECTED };

const survey = (over: Partial<SeedSurvey> = {}): SeedSurvey => ({
  rows: 6,
  superseded: 1,
  coverage: 'COVERED',
  coverageReason: 'read the whole archive',
  limit: 50,
  ...over,
});

describe('decideSeed', () => {
  it('writes into an empty workspace', () => {
    expect(decideSeed(survey({ rows: 0, superseded: 0 }), EXPECTED, false)).toEqual({
      kind: 'write',
      appending: false,
    });
  });

  it('leaves a finished seed alone', () => {
    expect(decideSeed(survey(), EXPECTED, false)).toEqual({ kind: 'finished' });
  });

  // THE FIRST PAIR THE ORDER OF TWO LINES DECIDES. A PARTIAL page carries exactly `limit` rows
  // whatever the archive holds, so `rows >= expectedRows` is `50 >= 6` and always true: with
  // `finished` tested first this workspace is called finished on the strength of one superseded row.
  it('refuses to judge a bounded page even when it looks finished', () => {
    const bounded = survey({ rows: 50, superseded: 1, coverage: 'PARTIAL' });
    expect(decideSeed(bounded, EXPECTED, false)).toEqual({ kind: 'bounded' });
  });

  it('refuses to judge a bounded page that looks unfinished too', () => {
    // Both halves of `finished` fail here, so this one passes whichever order the branches are in.
    // It is the sibling of the case above and it is here so the pair reads as a rule rather than as
    // one example: a bounded page is not judged, whatever it appears to contain.
    const bounded = survey({ rows: 50, superseded: 0, coverage: 'PARTIAL' });
    expect(decideSeed(bounded, EXPECTED, false)).toEqual({ kind: 'bounded' });
  });

  // THE SECOND PAIR, and the one a review caught being answered by the wrong line. An unreadable
  // listing arrives as an empty row list WITH an UNKNOWN receipt, so with `rows === 0` tested first
  // it is indistinguishable from an empty workspace and gets written into.
  it('refuses an unreadable listing that arrives empty', () => {
    const unreadable = survey({ rows: 0, superseded: 0, coverage: 'UNKNOWN' });
    expect(decideSeed(unreadable, EXPECTED, false)).toEqual({ kind: 'unreadable' });
  });

  it('refuses an unreadable listing that arrives with rows', () => {
    const unreadable = survey({ rows: 6, superseded: 1, coverage: 'UNKNOWN' });
    expect(decideSeed(unreadable, EXPECTED, false)).toEqual({ kind: 'unreadable' });
  });

  it('refuses an unreadable listing even under --force', () => {
    // The one place `force` does NOT win. It means "append on top of whatever is there", and on an
    // unreadable listing nobody knows what is there.
    const unreadable = survey({ rows: 0, superseded: 0, coverage: 'UNKNOWN' });
    expect(decideSeed(unreadable, EXPECTED, true)).toEqual({ kind: 'unreadable' });
  });

  // The union has exactly three members today, so `coverage !== 'COVERED'` and `coverage ===
  // 'PARTIAL'` pick out the same pages: UNKNOWN has already returned above. The allowlist spelling
  // is deliberate anyway, and this is the case that makes the difference observable. The cast builds
  // a value the type forbids on purpose, to ask what happens the day the union grows: an
  // unrecognised verdict has to be refused, not read.
  it('refuses a coverage verdict it does not recognise', () => {
    const strange = survey({ rows: 6, superseded: 1, coverage: 'RETIRED' as Coverage });
    expect(decideSeed(strange, EXPECTED, false)).toEqual({ kind: 'bounded' });
  });

  it.each([
    ['too few rows', survey({ rows: 4, superseded: 1 })],
    ['no chain', survey({ rows: 6, superseded: 0 })],
    ['neither', survey({ rows: 2, superseded: 0 })],
  ])('calls a workspace that is %s unclear rather than finished', (_label, state) => {
    // Deliberately `unclear` and not "interrupted": rows with no chain might be an abandoned seed or
    // might be memories the agent itself wrote, and nothing here distinguishes them.
    expect(decideSeed(state, EXPECTED, false)).toEqual({ kind: 'unclear' });
  });

  // `expectedRows` IS A PARAMETER AND NOT THE CONSTANT 6. A review measured that replacing it with
  // the literal left every case green, because every case passed 6. These two pass something else.
  it('measures against the expectedRows it is given, not a constant', () => {
    const eight = survey({ rows: 6, superseded: 1 });
    expect(decideSeed(eight, 8, false)).toEqual({ kind: 'unclear' });
  });

  it('calls a workspace finished once it reaches the expectedRows it is given', () => {
    const eight = survey({ rows: 8, superseded: 1 });
    expect(decideSeed(eight, 8, false)).toEqual({ kind: 'finished' });
  });

  it.each([
    ['an empty workspace', false, survey({ rows: 0, superseded: 0 })],
    ['a finished seed', true, survey()],
    ['a bounded page', true, survey({ rows: 50, coverage: 'PARTIAL' })],
    ['an unclear workspace', true, survey({ rows: 3, superseded: 0 })],
  ])('force writes into %s, appending=%s', (_label, appending, state) => {
    // The label and the flag are both printed by the name. An earlier version put the survey object
    // in the second slot, so every one of these names printed a whole object where it claimed to
    // print `appending=`.
    expect(decideSeed(state, EXPECTED, true)).toEqual({ kind: 'write', appending });
  });
});

describe('describeSeedDecision', () => {
  // THE TABLE THAT CATCHES A DELETED EXIT CODE. Two of the three refusals are failures and one is
  // not, and until this existed all three were indistinguishable to the test suite.
  // The decision object is LAST. Put it second and every name in this table prints it in the slot
  // that claims to be the exit code, which is the defect a review found in the force table above and
  // which this table reproduced verbatim until a plant made the names visible.
  it.each([
    ['unreadable', 1, 'stderr', false, { kind: 'unreadable' } as SeedDecision],
    ['bounded', 1, 'stderr', false, { kind: 'bounded' } as SeedDecision],
    ['unclear', 1, 'stderr', false, { kind: 'unclear' } as SeedDecision],
    ['finished', 0, 'stdout', false, { kind: 'finished' } as SeedDecision],
    ['a plain write', 0, 'stdout', true, { kind: 'write', appending: false } as SeedDecision],
    ['an appending write', 0, 'stdout', true, { kind: 'write', appending: true } as SeedDecision],
  ])('reports %s as exitCode=%s on %s, writes=%s', (_label, exitCode, stream, writes, decision) => {
    // The stream is pinned here because it changed silently once. The unreadable refusal used to be
    // a throw, which reached stderr through main().catch, and moving the decision into a pure
    // function moved it to stdout without anybody choosing that.
    const report = describeSeedDecision(decision, survey(), target);
    expect(report.exitCode).toBe(exitCode);
    expect(report.stream).toBe(stream);
    expect(report.writes).toBe(writes);
  });

  it('quotes the reason the listing could not be read', () => {
    const state = survey({ rows: 0, coverage: 'UNKNOWN', coverageReason: 'the query timed out' });
    const report = describeSeedDecision({ kind: 'unreadable' }, state, target);
    expect(report.message).toContain('the query timed out');
    expect(report.message).toContain(WORKSPACE);
    expect(report.message).toContain('Nothing was written');
  });

  it('quotes the bound and the verdict that made the page unjudgeable', () => {
    const state = survey({ rows: 50, coverage: 'PARTIAL', limit: 50 });
    const report = describeSeedDecision({ kind: 'bounded' }, state, target);
    expect(report.message).toContain('PARTIAL');
    expect(report.message).toContain('bound of 50');
    expect(report.message).toContain('--force');
    expect(report.message).toContain('Nothing was written');
  });

  it('counts what is already there when it leaves a finished seed alone', () => {
    const report = describeSeedDecision({ kind: 'finished' }, survey({ rows: 6, superseded: 1 }), target);
    expect(report.message).toContain('6 row(s)');
    expect(report.message).toContain('1 superseded');
    // The only refusal that is a success still has to say how to override it.
    expect(report.message).toContain('--force to APPEND');
  });

  it('describes an unclear workspace without diagnosing it', () => {
    const state = survey({ rows: 4, superseded: 0 });
    const report = describeSeedDecision({ kind: 'unclear' }, state, target);
    expect(report.message).toContain('4 row(s)');
    expect(report.message).toContain(`${EXPECTED} rows`);
    // It offers both readings and picks neither. Naming one would be the invented certainty this
    // whole project argues against.
    expect(report.message).toContain('interrupted seed');
    expect(report.message).toContain('agent itself');
    // All three refusals carry this sentence, and until a review counted them only one was pinned.
    expect(report.message).toContain('Nothing was written');
  });

  it('announces what --force is about to add, and that it deletes nothing', () => {
    const report = describeSeedDecision({ kind: 'write', appending: true }, survey({ rows: 6 }), target);
    expect(report.message).toContain('6 row(s)');
    expect(report.message).toContain('Nothing is deleted');
  });

  it('says nothing at all before a plain write', () => {
    // The per-row lines that follow are the output for this case. A message here would be noise.
    const report = describeSeedDecision({ kind: 'write', appending: false }, survey({ rows: 0 }), target);
    expect(report.message).toBeNull();
  });
});
