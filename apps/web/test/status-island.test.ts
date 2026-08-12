import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it } from 'vitest';
import type { LampView, StatusResponse } from '../src/scripts/types.ts';

/**
 * THE FIRST TEST THAT RENDERS EITHER STATUS SURFACE, and it renders BOTH on purpose.
 *
 * `/status` was the last surface whose body nothing checked, and it is not one surface. `StatusBoard`
 * is the page; `Annunciator` is the same three lamps as a rail, mounted by `Board.astro` on every
 * page that does not turn it off, which is four of the five. Testing one of them is how this
 * repository's only recurring defect happens: the archive's fix stopped at the archive, then the
 * console's fix stopped at the console. So every claim about a lamp is asserted on both, from one
 * fixture, in the same test.
 *
 * WHAT THIS FILE RESTS ON, MEASURED ON THIS FILE RATHER THAN INHERITED FROM A SIBLING, and the
 * measurement corrected the paragraph that stood here. The console's island file records that
 * removing `cancelAnimationFrame` reddens 0 of its tests, because the console fetches nothing on
 * mount. Both of these islands DO fetch from a mount effect, so the obvious sentence to write was
 * that the frame scheduler pair is load bearing here. HALF OF THAT IS FALSE. Re-measured at the 18
 * tests this file now holds:
 *
 *   - removing `cancelAnimationFrame` reddens 18 OF 18;
 *   - removing `requestAnimationFrame` reddens 0 OF 18, because preact falls back to a timeout and
 *     `settle` below drains timeouts. It is installed for correctness of description, not as a
 *     defence this file leans on.
 *
 * WHAT IT ACTUALLY RESTS ON IS THE ROUND TRIP, and each surface carries its own share, which is the
 * point of mounting both. Dropping the probe out of `StatusBoard` reddens 18 OF 18, with no survivor
 * at all: the one test that used to assert only on the rail now asserts the board's slip as well.
 * Dropping it out of `Annunciator` reddens 16 OF 18, and the two survivors are the two tests that
 * assert only on the board, `does not light a lamp claiming OK with no reason beside it` and
 * `refuses a body carrying two lamps under one name`.
 *
 * ALL FOUR WERE RE-MEASURED THREE TIMES IN ONE BRANCH, at 16 tests, at 17 and again at 18, and the
 * count was not what made them stale the first two times. The dead rail figure first moved because a
 * new test was written asserting only the board, which would have made it a THIRD survivor until a
 * rail assertion was added to it, and the same check on the next new test is why the survivor list
 * is unchanged now. Naming the survivors here rather than counting them is what makes that
 * checkable: a bare figure cannot tell a lost test from a gained one, and it was the NAMES that
 * carried the third re-measurement, which found both of them still standing.
 *
 * THE THIRD TIME, THE RULE BELOW WAS SIMPLY NOT FOLLOWED, which is a way of going stale the two
 * paragraphs above do not cover. The change that added the eighteenth test left all four figures at
 * 17 and shipped, and nothing independent read it, so they were corrected a commit later instead of
 * in the change that earned them. A rule addressed to whoever grows the file is worth exactly as
 * much as the next person's memory of it, which is why the figures are measured here rather than
 * argued: 18 OF 18, 0 OF 18, 18 OF 18 and 16 OF 18, re-measured with the same two survivors named.
 *
 * EVERY ONE OF THOSE FOUR FIGURES HAS BEEN WRONG MORE THAN ONCE, and the two ways recorded in this
 * paragraph are not all of them: the third is the paragraph above, where the rule was simply not
 * run. That count was `ONCE` here until the third time made it false, in a paragraph whose whole
 * subject is figures going stale, which is the shape this file exists to catch and is not exempt
 * from. The dead-rail figure was 7, under a sentence saying the survivors were the board-only
 * assertions. Two of the four were. The other two asserted four unlit lamps on the rail, which is
 * byte-identical to what a rail that never fetched renders, and that is the hazard THE GIVEAWAY FOR
 * ANY TEST ADDED HERE names below, committed twice in the file that names it. Giving both a rail
 * sentence that exists only after a body has been read took it to 9. Then one test was added and all
 * four figures went stale in the same stroke, and two more tests did it again. The last move was not
 * a new test at all: CHANGING WHAT ONE EXISTING TEST ASSERTS took the dead-board figure from 13 to
 * 14 and removed its only survivor. The figures have been carried at 11, at 12 and at 14 tests, and
 * every move NAMED IN THIS PARAGRAPH was re-measured rather than adjusted. The move to 18 was
 * neither: it was not noticed at all until the range had already merged.
 *
 * RE-MEASURE ALL FOUR WHENEVER THIS FILE GROWS, in the change that grows it. The sibling file
 * carries the same rule over its own two figures and records having been wrong about them more
 * than once.
 *
 * NO HISTORY OF THE SIBLING'S SIZES IS QUOTED HERE ANY MORE. This said it had been re-measured
 * twice, at 8 tests, 12 and 17, while that file's own header already recorded five sizes. A recital
 * of another file's numbers goes stale every time THAT file grows, and nothing in this one moves
 * when it does, so the citation names the sibling's rule and lets the sibling carry its own count.
 *
 * THE GIVEAWAY FOR ANY TEST ADDED HERE is one whose expected values a dead page also produces. That
 * is a real hazard on this page and not a theoretical one: an unlit lamp reading UNKNOWN is what
 * BOTH the pre-hydration markup and a failed probe render, so "three unlit lamps" proves nothing at
 * all. Every test below anchors on something only a completed round trip can produce: the API's own
 * words in a lamp's reason, a named server, a formatted clock, or a slip that does not exist before
 * an answer arrives.
 *
 * WHAT IS STUBBED IS `fetch` AND TWO DOM APIS linkedom does not implement, and nothing else. The
 * islands' own client (`scripts/api.ts`), the response guard (`scripts/shapes.ts`) and the body guard
 * (`scripts/status-state.ts`) all run for real, so a body the guard refuses is refused here exactly
 * as it would be in a browser.
 */

const API_BASE = 'http://api.test';
const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const dom = parseHTML('<!doctype html><html><body></body></html>');

const globals = globalThis as unknown as Record<string, unknown>;
globals.document = dom.document;
globals.window = dom.window;
globals.Event = dom.Event;
globals.Node = dom.Node;
globals.HTMLElement = dom.HTMLElement;
globals.requestAnimationFrame = (callback: (time: number) => void): ReturnType<typeof setTimeout> =>
  setTimeout(() => {
    callback(0);
  }, 0);
globals.cancelAnimationFrame = (handle: ReturnType<typeof setTimeout>): void => {
  clearTimeout(handle);
};

let answer: (url: string) => Promise<Response> = () =>
  Promise.reject(new Error('a test mounted a status surface without installing an answer'));
let answerInstalled = false;
let callsWithNoFixture = 0;

globals.fetch = (input: unknown, init?: { readonly signal?: AbortSignal }): Promise<Response> => {
  if (!answerInstalled) callsWithNoFixture += 1;
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    answer(String(input)).then(resolve, reject);
  });
};

// AFTER the globals, deliberately. A static import is hoisted above every statement in the file.
const { createElement, render } = await import('preact');
const { default: StatusBoard } = await import('../src/islands/StatusBoard.tsx');
const { default: Annunciator } = await import('../src/islands/Annunciator.tsx');

const answers = (bodyValue: unknown, status = 200): void => {
  answerInstalled = true;
  answer = () =>
    Promise.resolve(new Response(JSON.stringify(bodyValue), { status, headers: JSON_HEADERS }));
};

/** A probe that never gets a response at all, which is what `api_unreachable` is minted for. */
const refuses = (): void => {
  answerInstalled = true;
  answer = () => Promise.reject(new TypeError('Failed to fetch'));
};

/**
 * A probe that runs out of time.
 *
 * THE OTHER HALF OF `api_unreachable`, AND IT HAD NO TEST. `api.ts` mints the same code for a
 * rejected fetch and for its own eight second abort, and words the two apart: the abort arm says the
 * API did not answer in time, which is a page that ASKED. The board's closing paragraph used to tell
 * that visitor the page could not ask. `/status` runs six statements against the cluster behind a
 * possibly cold Lambda, so this is the ordinary slow path rather than an exotic one.
 *
 * The abort rejection is raised directly rather than by waiting out the real timer. That is the same
 * `DOMException` the `AbortController` raises, so `api.ts` takes the identical branch, and the
 * alternative is eight seconds of real time in a unit suite.
 */
const timesOut = (): void => {
  answerInstalled = true;
  answer = () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
};

const asElement = (value: unknown): HTMLElement => value as HTMLElement;

const mounted: HTMLElement[] = [];

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Drain preact's render queue, its effect flush and the stubbed fetch. See the sibling island files. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await tick(0);
  await tick(40);
  for (let turn = 0; turn < 4; turn += 1) await tick(0);
}

type Island = typeof StatusBoard;

async function mount(island: Island): Promise<HTMLElement> {
  const container = asElement(dom.document.createElement('div'));
  dom.document.body.appendChild(container);
  render(createElement(island, { apiBase: API_BASE }), container);
  mounted.push(container);
  await settle();
  return container;
}

/** The board and the rail, from ONE fixture, so no assertion below can be made of one of them only. */
async function mountBoth(): Promise<{ board: HTMLElement; rail: HTMLElement }> {
  return { board: await mount(StatusBoard), rail: await mount(Annunciator) };
}

afterEach(() => {
  const missed = callsWithNoFixture;
  const toUnmount = [...mounted];
  callsWithNoFixture = 0;
  mounted.length = 0;
  answerInstalled = false;
  answer = () => Promise.reject(new Error('a test mounted a status surface without installing an answer'));

  for (const container of toUnmount) {
    render(null, container);
    container.remove();
  }

  expect(missed, 'this test mounted a status surface without installing a fixture').toBe(0);
});

/**
 * The class on every capability lamp's state span, in order.
 *
 * `hasAttribute` RATHER THAN A NULL CHECK. linkedom returns `''` from `getAttribute('class')` for an
 * attribute that is absent, where the DOM specifies null, so an unlit lamp and a lamp with no class
 * at all would read identically and every assertion about a class would silently accept both.
 */
function lampClasses(container: HTMLElement, selector: string): string[] {
  const lamps = [...container.querySelectorAll(`${selector} .state`)];
  if (lamps.length === 0) throw new Error(`this surface drew no lamp under ${selector}`);
  return lamps.map((one) => {
    if (!one.hasAttribute('class')) throw new Error('a lamp state carries no class attribute');
    return one.getAttribute('class') ?? '';
  });
}

/** The board's three capability lamps. The rail adds a Last looked lamp, so the two are read apart. */
const boardLamps = (board: HTMLElement): string[] => lampClasses(board, '.biglamp');
const railLamps = (rail: HTMLElement): string[] => lampClasses(rail, '.lamp');

/** Every word on a surface, whitespace collapsed. Throws rather than returning an empty string. */
function words(container: HTMLElement, selector: string): string {
  const node = container.querySelector(selector);
  if (node === null) throw new Error(`this surface has no ${selector} to read`);
  const text = node.textContent;
  if (text === null) throw new Error(`the ${selector} carries no text to read`);
  return text.replace(/\s+/gu, ' ').trim();
}

const boardWords = (board: HTMLElement): string => words(board, '.statusboard');
const railWords = (rail: HTMLElement): string => words(rail, '.annunciator');

/** A named cell's value and the class it is typeset in, which is where a reader takes the claim from. */
function cell(board: HTMLElement, label: string): { value: string; className: string } {
  const found = [...board.querySelectorAll('.cell')].find(
    (one) => (one.querySelector('b')?.textContent ?? '') === label,
  );
  if (found === undefined) throw new Error(`the board has no ${label} cell`);
  const value = found.querySelector('.val');
  if (value === null) throw new Error(`the ${label} cell has no value span`);
  if (!value.hasAttribute('class')) throw new Error(`the ${label} value carries no class attribute`);
  return {
    value: (value.textContent ?? '').replace(/\s+/gu, ' ').trim(),
    className: value.getAttribute('class') ?? '',
  };
}

/**
 * The board's refusal slip, read as its verdict and its closing sentence.
 *
 * EXACTLY ONE SLIP, asserted rather than assumed, and throwing when there is none. A "last paragraph"
 * helper that returns a falsy sentinel makes every assertion against it pass on a page that drew no
 * slip at all, which is the shape this repository has now corrected six times across two files.
 */
function slip(board: HTMLElement): { verdict: string; detail: string; closing: string } {
  const slips = [...board.querySelectorAll('.slip')];
  if (slips.length !== 1) throw new Error(`this board has ${slips.length} slips, so "the" slip is ambiguous`);
  const one = slips[0];
  const paragraphs = [...(one?.querySelectorAll('p') ?? [])];
  if (paragraphs.length !== 2) {
    throw new Error(`this slip has ${paragraphs.length} paragraphs, so its closing is ambiguous`);
  }
  const collapse = (value: string | null): string => (value ?? '').replace(/\s+/gu, ' ').trim();
  return {
    verdict: collapse(one?.querySelector('.v')?.textContent ?? null),
    detail: collapse(paragraphs[0]?.textContent ?? null),
    closing: collapse(paragraphs[1]?.textContent ?? null),
  };
}

/** True when the board drew no slip, which is the only honest state before anything has gone wrong. */
const hasSlip = (board: HTMLElement): boolean => board.querySelector('.slip') !== null;

const lamp = (name: string, state: string, detail: string): LampView =>
  ({ name, state, detail }) as LampView;

const OK_BODY: StatusResponse = {
  server: 'throughline-api',
  observedAt: '2026-08-09T20:04:05.123Z',
  lamps: [
    lamp('Vector index', 'OK', 'The planner chooses the vector index for the recall query.'),
    lamp('Embeddings', 'DEGRADED', 'The column holds 1536 dimensions and the embedder produces 1024.'),
    lamp('MCP transport', 'UNKNOWN', 'No verification channel is configured, so nobody has looked.'),
  ],
};

describe('both status surfaces, hydrated from one body', () => {
  it('lights the lamps the probe reported, on the page and on the rail alike', async () => {
    answers(OK_BODY);
    const { board, rail } = await mountBoth();

    // THE ANCHOR: the API's own words. A dead page renders three unlit lamps saying nobody looked,
    // so a class assertion alone would pass on one.
    expect(boardWords(board)).toContain('The planner chooses the vector index for the recall query.');
    expect(railWords(rail)).toContain('The planner chooses the vector index for the recall query.');
    expect(boardLamps(board)).toEqual(['state s-ok', 'state s-deg', 'state s-unk']);
    expect(railLamps(rail)).toEqual(['state s-ok', 'state s-deg', 'state s-unk', 'state s-ok']);
    expect(hasSlip(board)).toBe(false);
  });

  it('names the server and the instant it was observed, in the class that means a measurement', async () => {
    answers(OK_BODY);
    const { board, rail } = await mountBoth();

    expect(cell(board, 'Answering')).toEqual({ value: 'throughline-api', className: 'val' });
    expect(cell(board, 'Last looked')).toEqual({ value: '2026-08-09T20:04:05.123Z', className: 'val' });
    expect(cell(board, 'Probe')).toEqual({ value: 'answered', className: 'val' });
    expect(railWords(rail)).toContain('20:04:05Z');
    expect(railWords(rail)).toContain('These lamps were lit by a probe at that time.');
  });

  it('refuses an offset instant outright rather than letting the rail slice a clock out of it', async () => {
    // THIS TEST USED TO ASSERT THE CONVERSION. The rail built its clock with
    // `observedAt.slice(11, 19) + 'Z'`, which reads 22:04:05 off this string and labels it Z, a
    // different instant from the one reported and in the lit class. `clockOf` fixed that by deriving
    // from the parsed instant. The body is now refused one step earlier, because the contract
    // declares `.toISOString()` output and the argument for accepting other notations is what let an
    // expanded-year timestamp past the calendar check. `clockOf` stays: it reads the instant rather
    // than string positions, so it cannot drift if that shape rule is ever loosened again.
    answers({ ...OK_BODY, observedAt: '2026-08-09T22:04:05+02:00' });
    const { board, rail } = await mountBoth();

    // THE NEGATIVE THAT STOOD HERE IS DELETED RATHER THAN REWORDED. It read
    // `expect(railWords(rail)).not.toContain('22:04:05Z')`, and once the body is refused the rail
    // renders `clockOf` over the BROWSER's own clock, so the only way it could ever fail was the one
    // second a day on which UTC reads 22:04:05. Nothing in production can put that string there from
    // this body any more: the slice is gone and a refused body never reaches `clockOf`. A rail that
    // never fetched at all passed it identically. This file asserts the rail by its sentence rather
    // than by the absence of a clock, here and again in the test that refuses a probe time whose day
    // the engine would silently move.
    expect(railWords(rail)).toContain(
      'This page asked, an answer came back, and it could not be read as one statement.',
    );
    expect(slip(board).detail).toContain('which is not a timestamp in the form this contract declares');
  });

  it('refuses a body whose probe time is not a time, and leaves every lamp unlit', async () => {
    answers({ ...OK_BODY, observedAt: 'whenever' });
    const { board, rail } = await mountBoth();

    expect(boardLamps(board)).toEqual(['state s-unk', 'state s-unk', 'state s-unk']);
    expect(railLamps(rail)).toEqual(['state s-unk', 'state s-unk', 'state s-unk', 'state s-unk']);
    // THE ANCHOR, ON BOTH. Four unlit lamps is exactly what a rail that never fetched renders, so
    // the class assertion above proves nothing on its own and this test survived a dead rail until a
    // review pointed at it. The sentences below exist only after a body has arrived and been read.
    expect(boardWords(board)).not.toContain('The planner chooses the vector index');
    expect(railWords(rail)).toContain(
      'This page asked, an answer came back, and it could not be read as one statement.',
    );
    expect(slip(board)).toEqual({
      verdict: 'THE ANSWER COULD NOT BE READ. VERDICT: UNKNOWN.',
      detail:
        'The status endpoint answered with a body carrying a value that is not a measurement: it ' +
        'reports "whenever" as when the probe ran, which is not a timestamp in the form this ' +
        'contract declares. No lamp here is lit from it.',
      closing:
        'The lamps above stay unlit. Something did answer, and this page did ask: what came back is ' +
        'not one statement, so no part of it is reported here as a measurement.',
    });
  });

  it('stops saying nobody has looked once the probe has looked and nothing answered', async () => {
    // THE DEFECT, ON BOTH SURFACES AT ONCE. Each carried one pending sentence and went on printing it
    // after a probe had failed: on the board directly above a slip saying the probe did not answer,
    // and on the rail one lamp away from its own sentence saying it tried and could not.
    refuses();
    const { board, rail } = await mountBoth();

    expect(boardWords(board)).not.toContain('Nobody has asked the cluster yet');
    expect(railWords(rail)).not.toContain('Nobody has asked the cluster yet');
    expect(boardWords(board)).toContain(
      'This page asked and nothing answered, so nothing here has been measured.',
    );
    expect(railWords(rail)).toContain(
      'The console tried to reach the API and could not, so the lamps above are still unlit.',
    );
    expect(cell(board, 'Probe')).toEqual({ value: 'did not answer', className: 'val doubt' });
    expect(cell(board, 'Last looked')).toEqual({ value: 'tried, nothing answered', className: 'val doubt' });
    expect(cell(board, 'Answering')).toEqual({ value: 'nobody', className: 'val doubt' });
    expect(slip(board).verdict).toBe('THE PROBE DID NOT ANSWER. VERDICT: UNKNOWN.');
  });

  it('does not tell a visitor whose probe timed out that this page could not ask', async () => {
    // THE COMMONER HALF OF `api_unreachable` AND IT HAD NO TEST AT ALL. The slip's closing paragraph
    // said the page "could not ask" while the API's own sentence directly above it said the request
    // ran out of time, and while three lamps below said this page asked. One page, one event, three
    // sentences, two of them agreeing and one of them not.
    timesOut();
    const { board, rail } = await mountBoth();

    expect(slip(board).detail).toBe(
      'The API did not answer within 8 seconds. Nothing here says the memory is empty.',
    );
    expect(slip(board).closing).toBe(
      'The lamps above stay unlit. None of them turned green, and none of them turned amber: this ' +
        'page asked and no answer came back, so it cannot tell you the index is missing either way.',
    );
    expect(boardWords(board)).toContain(
      'This page asked and nothing answered, so nothing here has been measured.',
    );
    // A SECOND VACUOUS NEGATIVE, DELETED IN THE SAME PASS AS THE FIRST. It forbade
    // `only that it could not ask`, and a grep of `apps/web/src` at `766e3b3` finds that phrase in
    // ZERO places. The count written here first said two, which was the count of the SHORTER
    // neighbour `could not ask`, and both of those are comments in `StatusBoard.tsx`. Grepping a
    // substring and reporting its count as the count for the string that matters is how a
    // justification ends up wrong in the same pass that deletes something for being wrong. The
    // assertion could never have fired, and the closing it was meant to guard is pinned whole by the
    // `slip(board).closing` assertion in this test.
    expect(railWords(rail)).toContain(
      'The console tried to reach the API and could not, so the lamps above are still unlit.',
    );
  });

  it('separates the API declining to report from the API not answering at all', async () => {
    // A 429 off this demo's own daily ceiling is the API ANSWERING, and telling that visitor the
    // probe did not answer misattributes the product's own limit to their network.
    answers({ error: 'rate_limited', detail: 'The demo allows 50 status probes a day.' }, 429);
    const { board, rail } = await mountBoth();

    expect(cell(board, 'Probe')).toEqual({ value: 'answered and refused', className: 'val doubt' });
    // THE ROW THAT CONTRADICTED ITSELF. This cell said "tried, no answer" beside a Probe cell saying
    // the request was answered and refused, above a slip saying the same, all in one row.
    expect(cell(board, 'Last looked')).toEqual({ value: 'tried, refused', className: 'val doubt' });
    // THE THIRD CELL IN THE SAME ROW, which read "nothing yet" beside the two above it.
    expect(cell(board, 'Answering')).toEqual({ value: 'answered, but named nobody', className: 'val doubt' });
    expect(slip(board).verdict).toBe('THE PROBE WAS REFUSED. VERDICT: UNKNOWN.');
    expect(slip(board).detail).toBe('The demo allows 50 status probes a day.');
    expect(railWords(rail)).toContain(
      'The API answered and declined to report, so the lamps above are still unlit.',
    );
  });

  it('says why a refusal gave no reason, rather than printing an empty paragraph under the verdict', async () => {
    // THE SIBLING OF THE TEST ABOVE, and the sixth instance of the blank printed string. The board
    // prints `view.failure.detail` directly under the verdict, and `asFailure` forwarded a wire
    // `detail` verbatim whenever it was a string, whitespace included. So a refusal carrying no
    // reason drew THE PROBE WAS REFUSED over an empty first paragraph, and the reader lost the only
    // sentence saying why.
    //
    // THE CODE IS KEPT, which is the half worth pinning. Falling through to `unrecognised_response`
    // would have been the smaller edit and it would have thrown away `error`, so this visitor would
    // be told the answer was unreadable rather than that they were refused. The verdict below is
    // what proves the code survived.
    answers({ error: 'rate_limited', detail: '   ' }, 429);
    const { board, rail } = await mountBoth();

    expect(slip(board).verdict).toBe('THE PROBE WAS REFUSED. VERDICT: UNKNOWN.');
    expect(slip(board).detail).toBe(
      'Something answered 429 with "rate_limited" and gave no reason.',
    );
    // THE RAIL IS WHAT PROVES THE CODE SURVIVED. Both surfaces branch on `error`, so had this fallen
    // through to `unrecognised_response` the rail would say the answer could not be read instead of
    // that the API declined. Asserting only the board would have left this test surviving a dead
    // rail, which is the shape a review already found twice in this file.
    expect(railWords(rail)).toContain(
      'The API answered and declined to report, so the lamps above are still unlit.',
    );
  });

  it('treats a refusal that names no code at all as unreadable, rather than printing a blank verdict', async () => {
    // THE SIBLING FIELD, and guarding only `detail` was this repository's whole recurring shape
    // committed inside the fix for it. `FailureResponse` has two printed fields. A blank `error` is
    // printed uppercased as a verdict by three surfaces, so it drew `REFUSED:    .` at a reader, and
    // the substitution written for the blank `detail` would have quoted the blank code into its own
    // sentence.
    //
    // IT FALLS THROUGH RATHER THAN BEING SUBSTITUTED, and the asymmetry with `detail` is deliberate.
    // A code is what every surface branches on, so an empty one is not a code that lost its
    // sentence, it is a body that named no failure. The verdict below is the proof: it is the
    // unreadable one, not the refused one.
    answers({ error: '   ', detail: '   ' }, 429);
    const { board, rail } = await mountBoth();

    expect(slip(board).verdict).toBe('THE ANSWER COULD NOT BE READ. VERDICT: UNKNOWN.');
    expect(slip(board).detail).toBe('Something answered 429 in a shape this console does not recognise.');
    expect(railWords(rail)).toContain(
      'Something answered in a shape this rail could not read, so the lamps above are still unlit.',
    );
  });

  it('prints an unrecognised lamp state as itself, unlit, without touching its neighbours', async () => {
    answers({
      ...OK_BODY,
      lamps: [lamp('Vector index', 'ok', 'The planner chooses the vector index.'), ...OK_BODY.lamps.slice(1)],
    });
    const { board, rail } = await mountBoth();

    expect(boardWords(board)).toContain('ok');
    expect(boardWords(board)).toContain('This board does not know the state "ok", so the lamp is not lit.');
    expect(railWords(rail)).toContain('This board does not know the state "ok", so the lamp is not lit.');
    // THE NEIGHBOURS ARE UNTOUCHED. Refusing a whole status page for one odd word would turn a
    // legible partial answer into no answer, which `shapes.ts` records as a decision.
    expect(boardLamps(board)).toEqual(['state s-unk', 'state s-deg', 'state s-unk']);
    expect(hasSlip(board)).toBe(false);
  });

  it('draws words in the chip on both surfaces when a lamp arrives with no state', async () => {
    // AN EMPTY CHIP ON TWO PAGES AT ONCE, which is why this is asserted on the board AND the rail
    // rather than on whichever one was open. `readLamp` is the single reading both surfaces print,
    // so a blank reaching it reached both, exactly as one blank kind emptied a cell on the console
    // rack and the archive rack together. The phrase asserted here appears in no note, so it can
    // only have come from the chip.
    answers({
      ...OK_BODY,
      lamps: [lamp('Vector index', '   ', 'The planner chooses the vector index.'), ...OK_BODY.lamps.slice(1)],
    });
    const { board, rail } = await mountBoth();

    expect(boardWords(board)).toContain('no state sent');
    expect(railWords(rail)).toContain('no state sent');
    expect(boardWords(board)).toContain('This lamp arrived with no state, so there is nothing here to light it on.');
    expect(boardLamps(board)[0]).toBe('state s-unk');
    expect(railLamps(rail)[0]).toBe('state s-unk');
    // THE NEIGHBOURS ARE UNTOUCHED, for the reason the unrecognised-state test gives.
    expect(hasSlip(board)).toBe(false);
  });

  it('does not light a lamp on either surface when the body names no capability for it', async () => {
    answers({ ...OK_BODY, lamps: [lamp('  ', 'OK', 'The planner chooses it.'), ...OK_BODY.lamps.slice(1)] });
    const { board, rail } = await mountBoth();

    // A LIT GREEN LAMP OVER AN EMPTY HEADING is what this rendered before, on both surfaces.
    expect(boardLamps(board)[0]).toBe('state s-unk');
    expect(railLamps(rail)[0]).toBe('state s-unk');
    expect(boardWords(board)).toContain('This lamp arrived with no name');
    expect(boardWords(board)).toContain(
      'A lamp that names no capability cannot report on one, so it is not lit.',
    );
    expect(railWords(rail)).toContain(
      'A lamp that names no capability cannot report on one, so it is not lit.',
    );
    // The neighbours are untouched, which is the whole reason this is per lamp.
    expect(boardLamps(board)[1]).toBe('state s-deg');
    expect(hasSlip(board)).toBe(false);
  });

  it('refuses a probe time whose day the engine would silently move, before either surface shows it', async () => {
    // THE COMMENT THAT STOOD HERE IS CORRECTED, and it was the twin of one already corrected in
    // `status-state.ts`. It said the two surfaces would disagree about the DAY, the board showing
    // the thirtieth of February while the rail showed a clock taken from the second of March. Only
    // the board prints a day at all, and a roll of the date never moves the time of day, so the rail
    // would have printed `20:04:05Z` either way. The defect is the board alone presenting a calendar
    // day that does not exist in the class that means a measurement. The hour case below is the one
    // where the two surfaces really do print different characters.
    answers({ ...OK_BODY, observedAt: '2026-02-30T20:04:05.123Z' });
    const { board, rail } = await mountBoth();

    // NOT "the board never prints that string": the slip QUOTES it, labelled as the value that is
    // not a day, which is what every malformed refusal on this page does. This assertion was written
    // as that negative first and the test caught it. The claim is about the cell that means a
    // measurement, so that is what is asserted, and the rail is asserted by its sentence rather than
    // by the absence of a clock, which would have rested on the browser's own time not matching.
    expect(cell(board, 'Last looked')).toEqual({ value: 'tried, unreadable answer', className: 'val doubt' });
    expect(railLamps(rail)).toEqual(['state s-unk', 'state s-unk', 'state s-unk', 'state s-unk']);
    expect(railWords(rail)).toContain(
      'This page asked, an answer came back, and it could not be read as one statement.',
    );
    expect(slip(board).detail).toBe(
      'The status endpoint answered with a body carrying a value that is not a measurement: it ' +
        'reports "2026-02-30T20:04:05.123Z" as when the probe ran, which is not an instant that ' +
        'exists as written. No lamp here is lit from it.',
    );
  });

  it('refuses an hour of 24, which both surfaces showed until the rule stopped reading the date alone', async () => {
    // THE SIBLING THE CALENDAR CHECK NEVER LOOKED AT, and it is the only form on which the two
    // surfaces really did print different characters from one field. Measured on node v22.22.0 at
    // `f572c95`: this string has the contract's exact shape, `Date.parse` accepts it, and the
    // written date `2026-12-31` is a day that exists, so all three rules passed it. The engine reads
    // it as `2027-01-01T00:00:00.000Z`. The board printed `2026-12-31T24:00:00.000Z` verbatim under
    // LAST LOOKED in class `val`, and the rail lit its Last looked lamp `state s-ok` showing
    // `00:00:00Z`, which is neither the hour written nor a year the reader was shown anywhere.
    answers({ ...OK_BODY, observedAt: '2026-12-31T24:00:00.000Z' });
    const { board, rail } = await mountBoth();

    // The slip is the assertion that carries this test. The unlit lamps and the doubt class are
    // states a board that never fetched also renders, so on their own they would pin nothing.
    expect(slip(board).detail).toBe(
      'The status endpoint answered with a body carrying a value that is not a measurement: it ' +
        'reports "2026-12-31T24:00:00.000Z" as when the probe ran, which is not an instant that ' +
        'exists as written. No lamp here is lit from it.',
    );
    expect(cell(board, 'Last looked')).toEqual({ value: 'tried, unreadable answer', className: 'val doubt' });
    expect(railWords(rail)).toContain(
      'This page asked, an answer came back, and it could not be read as one statement.',
    );
  });

  it('does not light a lamp claiming OK with no reason beside it', async () => {
    answers({ ...OK_BODY, lamps: [lamp('Vector index', 'OK', '   '), ...OK_BODY.lamps.slice(1)] });
    const { board } = await mountBoth();

    expect(boardLamps(board)[0]).toBe('state s-unk');
    expect(boardWords(board)).toContain(
      'This lamp arrived with no reason beside it, so there is nothing here to stand on.',
    );
    expect(boardWords(board)).toContain('A lamp with no reason is not a measurement, so it is not lit.');
  });

  it('refuses a body that reports a probe and names nothing it looked at', async () => {
    answers({ ...OK_BODY, lamps: [] });
    const { board, rail } = await mountBoth();

    // THE RAIL WOULD OTHERWISE DRAW A LONE LIT TIMESTAMP with nothing beside it, which is the rail
    // reporting the clock as a success: the one error its own comment says it exists to prevent. The
    // lamp count catches that shape, but four unlit lamps is also what a dead rail draws, so the
    // sentence is asserted too. It is the second of the two tests a review found surviving one.
    expect(railLamps(rail)).toEqual(['state s-unk', 'state s-unk', 'state s-unk', 'state s-unk']);
    expect(railWords(rail)).toContain(
      'This page asked, an answer came back, and it could not be read as one statement.',
    );
    expect(boardLamps(board)).toEqual(['state s-unk', 'state s-unk', 'state s-unk']);
    expect(slip(board).detail).toBe(
      'The status endpoint answered with a body whose own fields disagree: it reports a probe at ' +
        '2026-08-09T20:04:05.123Z and names nothing at all that was looked at. No lamp here is lit ' +
        'from it.',
    );
  });

  it('refuses a body carrying two lamps under one name', async () => {
    answers({
      ...OK_BODY,
      lamps: [lamp('Vector index', 'OK', 'One.'), lamp('Vector index', 'DEGRADED', 'Two.')],
    });
    const { board } = await mountBoth();

    expect(boardLamps(board)).toEqual(['state s-unk', 'state s-unk', 'state s-unk']);
    expect(slip(board).detail).toBe(
      'The status endpoint answered with a body whose own fields disagree: it sends two lamps a ' +
        'reader cannot tell apart by name, "Vector index" and "Vector index". No lamp here is lit ' +
        'from it.',
    );
  });

  it('refuses a 200 whose body is not a status response at all', async () => {
    // `api.ts` mints the failure here rather than this page's guard, and a reader is told the same
    // thing either way: an answer arrived and no result can be read out of it.
    answers({ server: 'throughline-api' });
    const { board, rail } = await mountBoth();

    expect(cell(board, 'Probe')).toEqual({ value: 'answered unreadably', className: 'val doubt' });
    // THE SIBLING CELL SAYS THE SAME THING. It read "tried, no answer" here while the cell beside it
    // said something answered, in adjacent cells of one row.
    expect(cell(board, 'Last looked')).toEqual({ value: 'tried, unreadable answer', className: 'val doubt' });
    expect(slip(board).verdict).toBe('THE ANSWER COULD NOT BE READ. VERDICT: UNKNOWN.');
    // "SOMETHING ANSWERED", because `unrecognised_response` is minted for any non 2xx whose body is
    // not a failure shape, which includes a CDN 502 that never reached this product.
    expect(railWords(rail)).toContain(
      'Something answered in a shape this rail could not read, so the lamps above are still unlit.',
    );
  });
});
