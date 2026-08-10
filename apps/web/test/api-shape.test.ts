import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMemories, getStatus, postTurn } from '../src/scripts/api.ts';
import { COVERAGE_WORDS } from '../src/scripts/shapes.ts';
import type {
  AgentTurnResponse,
  MemoryListReceiptView,
  MemoryListResponse,
  MemoryRowView,
  RecallEventView,
  RecalledMemoryView,
  StatusResponse,
} from '../src/scripts/types.ts';

/**
 * The guard on every 200 this console reads, which exists because of a HIGH a review found twice.
 *
 * `call` returned `ok: true` for ANY 200 whose body parsed, so `{}`, `[]` or a renamed `receipt` all
 * arrived as a SUCCESS. Round one fixed that for `/memories` alone. Round two found two things wrong
 * with the fix: the same hole was still open at `/agent/turn` and `/status`, and the guard itself
 * checked two of the receipt's eight fields, so a receipt too thin to explain anything still reached
 * the archive as a completed listing with a bound of `undefined rows`.
 *
 * THE CASES ARE DERIVED FROM THE FIXTURES, NOT LISTED BY HAND. `Object.keys(RECEIPT)` generates one
 * case per field the fixture carries, rather than a hand-written list. That is how the previous
 * version ended up with eight cases that between them drove four of the guard's five clauses: every
 * body was caught by an earlier clause, and deleting `Array.isArray(receipt.kinds)` left all 841
 * tests green.
 *
 * WHAT THAT DOES AND DOES NOT BUY, because the first version of this paragraph overstated it and a
 * review measured the difference. Deriving from the fixture does NOT mean a field added to the
 * contract shows up here as a new failing case: these are values, the contract is types, and vitest
 * erases types without checking them. Adding a field to `MemoryRowView` and running this file leaves
 * the count unchanged.
 *
 * WHAT MAKES IT HOLD is that every fixture below is ANNOTATED with its contract type. A field added
 * to `MemoryRowView` makes `ROW` an incomplete object literal, which fails `astro check` - the `web`
 * step of `npm run verify:ship`, and the only step that reads `apps/web` at all, since the root
 * `gate:types` excludes it. So the drift is caught at BUILD time here and at build time in
 * `shapes.ts`, and in neither place by a test run. Saying so exactly is the point: the previous
 * sentence claimed a runtime guarantee that did not exist.
 */

const ok = (body: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response);

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROW: MemoryRowView = {
  id: '11111111-1111-1111-1111-111111111111',
  kind: 'resolution',
  content: 'rolling back the payment deploy fixed checkout latency',
  state: 'current',
  freshness: 0.82,
  stale: false,
  ageDays: 3.5,
  halfLifeDays: 30,
  confirmations: 1,
  contradictions: 0,
  assertedBy: 'human:oncall-ana',
  incidentId: 'INC-1042',
  supersededBy: null,
  createdAt: '2026-08-05T09:00:00.000Z',
  validFrom: '2026-08-05T09:00:00.000Z',
  validUntil: null,
  evictedAt: null,
  evictionReason: null,
};

const RECEIPT: MemoryListReceiptView = {
  kinds: [],
  limit: 50,
  returned: 1,
  coverage: 'COVERED',
  coverageReason: 'every row matching this filter fitted inside the bound',
  coverageCause: null,
  requestedAt: '2026-08-08T12:00:00.000Z',
  elapsedMs: 4,
};

const WELL_FORMED: MemoryListResponse = { server: 'throughline-api', receipt: RECEIPT, memories: [ROW] };

const WELL_FORMED_STATUS: StatusResponse = {
  server: 'throughline-api',
  observedAt: '2026-08-08T12:00:00.000Z',
  lamps: [{ name: 'Vector index', state: 'OK', detail: 'the planner used it' }],
};

/**
 * One memory as a RECALL returns it. Distinct from `ROW`: it carries the two numbers that ordered it.
 *
 * `score` and `similarity` are the reason this fixture exists at all. `Console.tsx` calls `.toFixed`
 * on both, per row, so an element that is not an object with those numbers does not render wrongly,
 * it THROWS and blanks the pane.
 */
const RECALLED: RecalledMemoryView = {
  id: '22222222-2222-2222-2222-222222222222',
  kind: 'observation',
  content: 'Checkout p99 rose from 180 ms to 4.2 s four minutes after the payment deploy.',
  similarity: 0.7,
  score: 0.67,
  freshness: 1,
  stale: false,
  ageDays: 0,
  halfLifeDays: 30,
  confirmations: 0,
  contradictions: 0,
  assertedBy: 'system:demo-seed',
  incidentId: 'INC-1042',
  supersededBy: null,
};

const RECALL: RecallEventView = {
  callId: 'call-1',
  receipt: {
    query: 'have we seen this before',
    coverage: 'COVERED',
    coverageReason: 'the search ran over every live memory',
    coverageCause: null,
    retrievalPath: 'ann_index',
    candidatesConsidered: 6,
    returned: 1,
    exclusions: [],
    degradations: [],
    elapsedMs: 58,
  },
  memories: [RECALLED],
};

const WELL_FORMED_TURN: AgentTurnResponse = {
  text: 'the payment gateway pool size was the real fix',
  coverage: 'COVERED',
  refusedAnAbsenceClaim: false,
  toolCallCount: 1,
  modelId: 'local:scripted',
  transcript: [{ role: 'user', content: 'have we seen this before' }],
  recalls: [RECALL],
  budget: { used: 1, limit: 500, day: '2026-08-08' },
};

/**
 * Everything but `field`, so the case says exactly which field was removed when it fails.
 *
 * Takes `object` rather than `Record<string, unknown>` because the fixtures are annotated with their
 * contract interfaces, and an interface has no implicit index signature.
 */
const without = (source: object, field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(source).filter(([key]) => key !== field));

const refused = (result: { ok: boolean; failure?: { error: string } }) => {
  expect(result.ok).toBe(false);
  // A NAMED failure, so the page renders "the API answered in a shape it cannot read" rather than
  // waiting forever, drawing an empty archive, or lighting a holder around nothing measured.
  if (!result.ok) expect(result.failure?.error).toBe('unrecognised_response');
};

describe('getMemories', () => {
  it('accepts a well formed listing', () => {
    // The negative control. Without it a guard that refused EVERYTHING would pass every case below
    // while breaking the page completely, which is the shape of a control that cannot fail.
    vi.stubGlobal('fetch', () => ok(WELL_FORMED));
    return expect(getMemories('https://api.example')).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['an empty object', {}],
    ['an array', []],
    ['a renamed receipt', { server: 'x', listing: RECEIPT, memories: [] }],
    ['a missing memories list', { server: 'x', receipt: RECEIPT }],
    ['memories that is not a list', { server: 'x', receipt: RECEIPT, memories: 'none' }],
    ['a receipt that is null', { server: 'x', receipt: null, memories: [] }],
    ['a bare string', 'nothing here'],
  ])('refuses %s rather than reporting a success with no receipt', async (_label, body) => {
    vi.stubGlobal('fetch', () => ok(body));
    refused(await getMemories('https://api.example'));
  });

  // ONE CASE PER DECLARED RECEIPT FIELD. `limit`, `returned`, `coverageReason` and `coverageCause`
  // are each read by `Archive.tsx` to state or explain the verdict, and a body missing all four was
  // previously classified `empty` - the page's most confident sentence - beside blank cells.
  it.each(Object.keys(RECEIPT))('refuses a receipt with no %s', async (field) => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED, receipt: without(RECEIPT, field) }));
    refused(await getMemories('https://api.example'));
  });

  it.each(Object.keys(ROW))('refuses a row with no %s', async (field) => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED, memories: [without(ROW, field)] }));
    refused(await getMemories('https://api.example'));
  });

  // The decision compares `coverage` against the exact literal 'UNKNOWN'. Anything else lands in the
  // `empty` arm, so an API reporting that it could NOT complete the listing, in any other casing or
  // vocabulary, was rendered as "THE LISTING RAN. Nothing matched."
  // THE OTHER DIRECTION, and without it the domain check had no negative control worth the name.
  // Every accepting case used COVERED, so deleting `PARTIAL: true` from the domain left all 911
  // tests green while the archive lost the ability to show a bounded listing at all. PARTIAL is what
  // tells a reader more rows exist, and UNKNOWN is the one whose reason a reader most needs.
  it.each(['COVERED', 'PARTIAL', 'UNKNOWN'])('accepts a coverage of %s, which the contract declares', async (coverage) => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED, receipt: { ...RECEIPT, coverage } }));
    await expect(getMemories('https://api.example')).resolves.toMatchObject({ ok: true });
  });

  it('has an accepting case for every word in the domain', () => {
    // TWO INDEPENDENT STATEMENTS, deliberately, and not one derived from the other. The list above
    // is written by hand so DELETING a word fails its own case; this compares that list against the
    // domain so ADDING one fails here. Iterating the domain to test the domain would have made the
    // cases above unable to fail, which is the trap this file has already fallen into twice.
    expect(Object.keys(COVERAGE_WORDS).sort()).toEqual(['COVERED', 'PARTIAL', 'UNKNOWN']);
  });

  it.each([
    // The same prototype-key class, on the coverage domain. `isCoverage` tested `=== true` from the
    // start so these were never accepted here; the cases exist because the sibling lookup in the
    // same file was written the unsafe way an hour later, and a class of mistake with one instance
    // proven and one unexamined is not a class anybody has checked.
    ['a coverage named constructor', 'constructor'],
    ['a coverage named __proto__', '__proto__'],
    ['a coverage named toString', 'toString'],
    ['the wrong case', 'unknown'],
    ['title case', 'Unknown'],
    ['a word from another vocabulary', 'BROKEN'],
    ['an empty string', ''],
    ['a trailing space', 'COVERED '],
    ['a number', 42],
    ['null', null],
  ])('refuses a coverage of %s, outside the three words the contract declares', async (_label, coverage) => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED, receipt: { ...RECEIPT, coverage } }));
    refused(await getMemories('https://api.example'));
  });

  it.each([
    ['ids instead of rows', ['a', 'b']],
    ['nulls', [null]],
    ['numbers', [3]],
  ])('refuses memories carrying %s, which the island dereferences per row', async (_label, memories) => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED, memories }));
    refused(await getMemories('https://api.example'));
  });

  it('refuses a NaN where a measurement goes', async () => {
    // NaN survives `typeof value === 'number'` and prints as `NaN` in the cell a reader takes for a
    // measured number. The guard tests for finiteness, and this is the case that watches it.
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED, receipt: { ...RECEIPT, returned: Number.NaN } }));
    refused(await getMemories('https://api.example'));
  });

  it('sends each kind as its own parameter and none when the filter is empty', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      seen.push(url);
      return ok(WELL_FORMED);
    });

    await getMemories('https://api.example', ['resolution', 'runbook_fact']);
    await getMemories('https://api.example');

    expect(seen[0]).toBe('https://api.example/memories?kind=resolution&kind=runbook_fact');
    // No trailing `?`, because a bare question mark is a URL a proxy may or may not normalise.
    expect(seen[1]).toBe('https://api.example/memories');
  });
});

/**
 * The other two endpoints, which the first round of this fix left open.
 *
 * A `{}` on `/agent/turn` reached `Console.tsx` as an answer and `response.recalls.map` threw
 * during render: a blank pane, which is the silent absence this site argues against. A `{}` on
 * `/status` is non-null, so `StatusBoard.tsx:76` lit the holder beside three UNKNOWN fallback lamps.
 */
describe('getStatus', () => {
  it('accepts a well formed status', () => {
    vi.stubGlobal('fetch', () => ok(WELL_FORMED_STATUS));
    return expect(getStatus('https://api.example')).resolves.toMatchObject({ ok: true });
  });

  it.each(Object.keys(WELL_FORMED_STATUS))('refuses a status with no %s', async (field) => {
    vi.stubGlobal('fetch', () => ok(without(WELL_FORMED_STATUS, field)));
    refused(await getStatus('https://api.example'));
  });

  it('refuses an empty object rather than lighting a holder around nothing measured', async () => {
    vi.stubGlobal('fetch', () => ok({}));
    refused(await getStatus('https://api.example'));
  });

  it('refuses a lamp that is not a lamp', async () => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED_STATUS, lamps: ['Vector index'] }));
    refused(await getStatus('https://api.example'));
  });

  it('accepts a lamp state this console does not recognise, which renders unlit', async () => {
    // DELIBERATE, and the direction is the argument. An unknown lamp state falls through
    // `classFor` to the unlit class and prints its own word, which is doubt - the safe reading.
    // Refusing the whole page for one unrecognised lamp would turn a legible partial answer into
    // no answer. `coverage` gets the opposite treatment because its unknown values land in the
    // page's most CONFIDENT arm rather than its most doubtful one.
    const lamps = [{ name: 'Vector index', state: 'MAYBE', detail: 'a word from a later version' }];
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED_STATUS, lamps }));
    await expect(getStatus('https://api.example')).resolves.toMatchObject({ ok: true });
  });
});

describe('postTurn', () => {
  it('accepts a well formed turn', () => {
    vi.stubGlobal('fetch', () => ok(WELL_FORMED_TURN));
    return expect(postTurn('https://api.example', 'hello')).resolves.toMatchObject({ ok: true });
  });

  it.each(Object.keys(WELL_FORMED_TURN))('refuses a turn with no %s', async (field) => {
    vi.stubGlobal('fetch', () => ok(without(WELL_FORMED_TURN, field)));
    refused(await postTurn('https://api.example', 'hello'));
  });

  it('refuses an empty object rather than throwing during render', async () => {
    vi.stubGlobal('fetch', () => ok({}));
    refused(await postTurn('https://api.example', 'hello'));
  });

  it.each([
    ['a transcript of strings', { transcript: ['user said hello'] }],
    ['a recall with no receipt', { recalls: [{ callId: 'c1', memories: [] }] }],
    ['a recall whose receipt has no coverage', { recalls: [{ ...RECALL, receipt: {} }] }],
    ['a recall whose memories are not a list', { recalls: [{ ...RECALL, memories: 1 }] }],
  ])('refuses %s, which the console walks', async (_label, patch) => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED_TURN, ...patch }));
    refused(await postTurn('https://api.example', 'hello'));
  });

  // THE HOLE THE FIRST VERSION OF THE GUARD LEFT, one list over from where it closed the same one.
  // `recalls[].memories` was `Array.isArray` and nothing more, so ids or nulls were accepted, and
  // `Console.tsx` keys by `memory.id` and calls `score.toFixed` and `similarity.toFixed` per row.
  // Those throw. A blank pane is the silent absence this whole console argues against.
  it.each([
    ['ids instead of memories', ['22222222-2222-2222-2222-222222222222']],
    ['nulls', [null]],
    ['numbers', [3]],
  ])('refuses a recall carrying %s, which the memory pane dereferences per row', async (_label, memories) => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED_TURN, recalls: [{ ...RECALL, memories }] }));
    refused(await postTurn('https://api.example', 'hello'));
  });

  // BUDGET HAD A MAP AND NO RUNTIME CONTROL: replacing all three of its checks with `() => true`
  // left 961 tests green. Compile-time presence held, which is not the same thing as a test.
  it.each(Object.keys(WELL_FORMED_TURN.budget))('refuses a budget with no %s', async (field) => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED_TURN, budget: without(WELL_FORMED_TURN.budget, field) }));
    refused(await postTurn('https://api.example', 'hello'));
  });

  it('accepts a budget whose used is null, which the contract declares', async () => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED_TURN, budget: { ...WELL_FORMED_TURN.budget, used: null } }));
    await expect(postTurn('https://api.example', 'hello')).resolves.toMatchObject({ ok: true });
  });

  it.each(Object.keys(RECALLED))('refuses a recalled memory with no %s', async (field) => {
    const memories = [without(RECALLED, field)];
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED_TURN, recalls: [{ ...RECALL, memories }] }));
    refused(await postTurn('https://api.example', 'hello'));
  });

  // THE RECALL RECEIPT, whose fields a docblock twice described as printed and never dereferenced.
  // `Console.tsx` calls `.toUpperCase()` on `retrievalPath`, so a receipt carrying only
  // `coverage` was accepted and threw during render. One case per declared field.
  it.each(Object.keys(RECALL.receipt))('refuses a recall receipt with no %s', async (field) => {
    vi.stubGlobal('fetch', () =>
      ok({ ...WELL_FORMED_TURN, recalls: [{ ...RECALL, receipt: without(RECALL.receipt, field) }] }),
    );
    refused(await postTurn('https://api.example', 'hello'));
  });

  // THE OTHER LIST THE CONSOLE WALKS. `role` alone was the whole check, and the transcript pane in
  // `Console.tsx` reads `content.length`, so a `tool_result` with no content was accepted and threw.
  // Named rather than cited by line, for the reason `shapes.ts` gives beside the same reader.
  it.each([
    ['a tool_result with no content', { role: 'tool_result', id: 't1', name: 'recall' }],
    ['a tool_call with no id', { role: 'tool_call', given: 'x', name: 'recall', args: {} }],
    // The sibling of the case above, and NOT because this console renders `given`. It does not, and
    // the contract says so in as many words. It is checked the way every declared string on every
    // shape in `shapes.ts` is checked, which is the whole of the reason: presence is all or nothing
    // there, for rows and lamps just as much as for this.
    ['a tool_call with no given', { role: 'tool_call', id: 't1', name: 'recall', args: {} }],
    ['a user turn with no content', { role: 'user' }],
    ['a refusal with no content', { role: 'refusal' }],
    ['a role this console does not know', { role: 'narrator', content: 'once upon a time' }],
    // EVERY ONE OF THESE WAS ACCEPTED, with no field but `role`, until the lookup asked for an OWN
    // property. `TURN_ROLE_CHECKS['constructor']` resolves to something inherited from
    // `Object.prototype`, which is not undefined, and `Object.entries()` of it is empty - so the
    // field loop had nothing to check and returned true. The `narrator` case above could never have
    // caught it: the broken guard refused that one correctly, which is exactly how a control ends up
    // green over a hole.
    ['a role named constructor', { role: 'constructor' }],
    ['a role named __proto__', { role: '__proto__' }],
    ['a role named toString', { role: 'toString' }],
    ['a role named valueOf', { role: 'valueOf' }],
    ['a role named hasOwnProperty', { role: 'hasOwnProperty' }],
    ['a turn whose content is a number', { role: 'assistant', content: 7 }],
  ])('refuses %s', async (_label, turn) => {
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED_TURN, transcript: [turn] }));
    refused(await postTurn('https://api.example', 'hello'));
  });

  it.each([
    ['user', { role: 'user', content: 'have we seen this' }],
    ['assistant', { role: 'assistant', content: 'yes, once' }],
    ['refusal', { role: 'refusal', content: 'I will not claim absence' }],
    ['tool_call', { role: 'tool_call', id: 't1', given: 'toolu_01', name: 'recall', args: { query: 'x' } }],
    ['tool_result', { role: 'tool_result', id: 't1', name: 'recall', content: '{}' }],
  ])('accepts a well formed %s turn', async (_label, turn) => {
    // The negative controls for the role map. Without them a check that refused every turn would
    // satisfy all six cases above while emptying the transcript pane on every real answer.
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED_TURN, transcript: [turn] }));
    await expect(postTurn('https://api.example', 'hello')).resolves.toMatchObject({ ok: true });
  });

  it('accepts a null coverage, which is what a turn that never recalled reports', async () => {
    // The contract declares `Coverage | null` here, and null is the honest value for a turn where
    // the model answered without searching. Refusing it would refuse a correct answer.
    vi.stubGlobal('fetch', () => ok({ ...WELL_FORMED_TURN, coverage: null }));
    await expect(postTurn('https://api.example', 'hello')).resolves.toMatchObject({ ok: true });
  });
});
