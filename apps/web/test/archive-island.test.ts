import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ListFailureCause,
  MemoryKind,
  MemoryListReceiptView,
  MemoryListResponse,
  MemoryRowView,
  MemoryState,
} from '../src/scripts/types.ts';

/**
 * THE FIRST TEST IN THIS REPOSITORY THAT RENDERS ANYTHING.
 *
 * `archive-state.test.ts` pins WHICH state the archive page is in, because that decision was pulled
 * out into a pure function after a review found three defects in it. What it does not touch is the
 * other half: the markup the island draws once it has been told. That half is roughly three hundred
 * lines of conditionals about classes, fallbacks and truncation, and until this file existed the
 * only thing that had ever checked any of it was a person driving a browser twice by hand.
 *
 * THE TRAP THIS FILE IS BUILT AROUND, because it turns the whole suite into a control that cannot
 * fail. `preact/hooks` decides once, AT MODULE LOAD, whether the host has a frame scheduler:
 *
 *     let HAS_RAF = typeof requestAnimationFrame == 'function';
 *
 * and the callback it schedules calls `cancelAnimationFrame(raf)` guarded ONLY by that same flag,
 * never by whether `cancelAnimationFrame` itself exists. (An earlier version of this sentence said
 * "with no guard of its own", which a review checked against the shipped bundle and corrected. The
 * distinction matters: installing rAF alone is what ARMS the unguarded call.) So a harness that
 * defines `requestAnimationFrame` and forgets `cancelAnimationFrame` throws
 * `ReferenceError: cancelAnimationFrame is not defined` inside preact's scheduler, the effect
 * never flushes, no fetch is ever made, and an assertion quietly reads the PRE-HYDRATION markup
 * instead of going red.
 *
 * MEASURED, AND THE FIRST MEASUREMENT WAS NOT THE FINAL ONE. Removing `cancelAnimationFrame` from
 * this file was expected to redden everything. It reddened 25 of 29, and the four survivors are the
 * reason this paragraph exists rather than a claim that the pair is load bearing.
 *
 * Preact ALSO flushes a component's pending effects synchronously inside its next render
 * (`options._render`), not only from the frame scheduler. So anything that re-renders the island
 * runs the effect anyway. Three survivors asserted an ABSENCE, which an unhydrated page satisfies
 * perfectly, and the fourth clicked a filter chip, which re-rendered and therefore issued both of
 * its own fetches with the scheduler dead. Four tests were passing on markup nobody had hydrated.
 *
 * Each was given a post-effect anchor: the three absence tests now also assert the measured verdict
 * word, and the click test asserts its first request landed BEFORE the click.
 *
 * THAT NUMBER HAS NOW BEEN WRONG TWICE, WHICH IS WHY THE RULE IS WRITTEN HERE RATHER THAN THE
 * NUMBER ALONE. It said "29 of 29" and stayed there while the file grew to 40, where the true
 * figure was 39; the survivor was a test added by the very commit that wrote the claim. Corrected,
 * it was wrong again at 42, where a newly added test asserting UNLIT values passed against an
 * unhydrated page, because unlit IS the pre-hydration state.
 *
 * Re-measured on 2026-08-09 THREE TIMES IN ONE SITTING, which is the whole argument for the rule
 * rather than the number. The contradiction tests took the file from 42 to 44 and it measured
 * **44 of 44**; the first review of that commit added a test and it measured **45 of 45**; the
 * second review found a defect in that test's own fix, which added another, and it measured
 * **46 of 46**. A number written once and left alone would have been wrong twice inside an hour,
 * after being wrong twice before that. Removing `cancelAnimationFrame` reddens 46 of 46: every test
 * in this file depends on hydration having happened.
 *
 * ANY TEST ADDED BELOW MUST BE RE-MEASURED AGAINST THAT MUTATION, and the giveaway is a test whose
 * expected values a dead page also produces: an absence, an unlit class, or the word NOT ASKED. All
 * five of the new ones assert an absence somewhere and were given a post-effect anchor for exactly
 * that reason. Give the next one an anchor too, then re-measure and correct this number.
 *
 * Two things defend against that, and the second is the one that would survive a rewrite:
 *
 *   1. Both halves of the pair are installed, and they go on `globalThis` BEFORE preact is imported,
 *      which is why the imports below are dynamic. A static `import` is hoisted above every
 *      statement in the file, so `HAS_RAF` would be computed before the assignment ran. Its value
 *      is CORRECTNESS OF DESCRIPTION rather than a load bearing defence, and saying otherwise was
 *      a claim borrowing credibility from the measurement beside it: a review converted both
 *      imports to static and the suite stayed 29 of 29 green, because `HAS_RAF` simply goes false
 *      and preact falls back to its 35ms timeout. Dynamic is kept because the file states when
 *      `HAS_RAF` is computed, and a static import would make that statement false.
 *   2. The first test asserts the page says NOT ASKED before the effect and something else after it.
 *      If the effect ever stops running, that test fails by name rather than every other test
 *      silently passing against markup nobody hydrated. THIS is the defence that was measured.
 *
 * WHAT IS STUBBED IS `fetch` AND NOTHING ELSE. The island's own client (`scripts/api.ts`) and its
 * response guard (`scripts/shapes.ts`) run for real, so a fixture that would be refused by the guard
 * is refused here too, exactly as it would be in a browser.
 */

const API_BASE = 'http://api.test';
const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** The document every mount renders into. linkedom, because it is already a root devDependency. */
const dom = parseHTML('<!doctype html><html><body></body></html>');

/**
 * The browser globals the island and preact reach for, installed before either is imported.
 *
 * linkedom supplies no frame scheduler at all (measured: both are `undefined` on its window), so
 * both halves are written here rather than borrowed. They are backed by `setTimeout` so the flush is
 * a normal macrotask a test can wait for, and `cancelAnimationFrame` is a real `clearTimeout` rather
 * than a no-op, so the handle preact hands back is genuinely retired.
 */
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

/** Every URL the island asked for, in order, so a filter change can be checked rather than assumed. */
let requested: string[] = [];

/** What the next call answers with. Set by one of the four helpers below, never left over. */
let answer: (url: string) => Promise<Response> = () =>
  Promise.reject(new Error('a test mounted the island without installing an answer'));

/**
 * Whether this test installed a fixture, and the count of calls made when it had not.
 *
 * A REVIEW PROVED THE OBVIOUS GUARD WAS DEAD. `api.ts` catches every rejection and turns it into
 * `api_unreachable`, so the error message above can never reach a screen or a test: a forgotten
 * fixture rendered the NO ANSWER slip, which is a real state with a real test, so the suite stayed
 * green and the forgetting was invisible. Measured: deleting `unreachable()` from the NO ANSWER
 * test left 29 of 29 passing. The count below is checked in `afterEach`, where a rejection cannot
 * swallow it.
 */
let answerInstalled = false;
let callsWithNoFixture = 0;

globals.fetch = (input: unknown, init?: { readonly signal?: AbortSignal }): Promise<Response> => {
  const url = String(input);
  requested.push(url);
  if (!answerInstalled) callsWithNoFixture += 1;

  // HONOURING THE SIGNAL, because `api.ts` passes one and reads an `AbortError` back as its
  // timeout sentence. A stub that ignored it would leave that path unreachable from here while
  // looking like a faithful `fetch`.
  //
  // NO `signal === undefined` BRANCH. There was one, and a review proved it dead: the only caller
  // is `call` in `api.ts`, which always passes `signal: controller.signal`. Replacing that branch
  // with a throw left the suite green, which is the definition of a branch that reads as coverage
  // and provides none. Optional chaining keeps the stub working for a caller that passes none
  // without pretending a second path is exercised.
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    answer(url).then(resolve, reject);
  });
};

// AFTER the globals, deliberately. See the header: a static import would be hoisted above them.
const { createElement, render } = await import('preact');
const { default: Archive } = await import('../src/islands/Archive.tsx');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** The API answers every call with one body. */
const answers = (body: unknown, status = 200): void => {
  answerInstalled = true;
  answer = () => Promise.resolve(json(body, status));
};

/** The API answers differently depending on what was asked, for the filter tests. */
const answersByUrl = (pick: (url: string) => unknown): void => {
  answerInstalled = true;
  answer = (url) => Promise.resolve(json(pick(url)));
};

/** The API cannot be reached at all. `fetch` rejects, which is what a browser does offline. */
const unreachable = (): void => {
  answerInstalled = true;
  answer = () => Promise.reject(new TypeError('fetch failed'));
};

/** The request opens and never comes back, which is the only way to observe the in-flight render. */
const neverAnswers = (): void => {
  answerInstalled = true;
  answer = () => new Promise<Response>(() => undefined);
};

/**
 * ONE CAST, AT THE BOUNDARY. linkedom's classes are structurally the DOM but nominally its own, so
 * without this every helper below would carry its own cast or its own structural interface.
 */
const asElement = (value: unknown): HTMLElement => value as HTMLElement;

const mounted: HTMLElement[] = [];

function mount(): HTMLElement {
  const container = asElement(dom.document.createElement('div'));
  dom.document.body.appendChild(container);
  render(createElement(Archive, { apiBase: API_BASE }), container);
  mounted.push(container);
  return container;
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wait until the island has finished reacting.
 *
 * Three things have to drain: preact's re-render queue (a microtask), the effect flush (this file's
 * `requestAnimationFrame`, so a macrotask), and the stubbed fetch's own promise.
 *
 * The 40ms wait is BELT AND BRACES, not load bearing, and the honest version of that sentence is
 * the measured one. preact races its rAF against a 35ms `setTimeout` fallback, so the wait covers
 * the case where the rAF path is the broken one. A review measured what happens without it: the
 * suite is still 29 of 29 green, because twelve macrotask turns already cost more than 35ms on
 * this machine. The wait is kept because "already costs more than 35ms here" is a fact about this
 * machine and not about the code, and a shorter turn on a faster one would silently reintroduce
 * the dependency. It is not evidence that the fallback path is exercised.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await tick(0);
  await tick(40);
  for (let turn = 0; turn < 4; turn += 1) await tick(0);
}

/** Mount, wait, and hand back the hydrated container. The shape almost every test below wants. */
async function mountAndSettle(): Promise<HTMLElement> {
  const container = mount();
  await settle();
  return container;
}

afterEach(() => {
  // READ AND RESET FIRST, before anything that could throw. A review pointed out that resetting
  // after the unmount loop means a throwing `render(null, container)` carries this test's count
  // into the NEXT test's name, which is a wrong-name failure of exactly the kind this file keeps
  // finding elsewhere.
  // ALL SIX RESETS FIRST, before anything that can throw. The first version of this fix moved two
  // of them and left four below the unmount loop, which a review counted: a throwing
  // `render(null, container)` would still have carried a mounted container, a stale `requested` and
  // a stale fixture flag into the next test. Accepting the premise for one statement and not for
  // its five siblings is this file's own recurring defect, applied to itself.
  const missed = callsWithNoFixture;
  const toUnmount = [...mounted];
  callsWithNoFixture = 0;
  mounted.length = 0;
  requested = [];
  answerInstalled = false;
  answer = () => Promise.reject(new Error('a test mounted the island without installing an answer'));

  // Unmounting runs the effect's cleanup, which is what sets `live = false` on an open request. A
  // container left mounted would keep answering into a detached tree and could set state during the
  // next test. Detached as well as unmounted, so the shared body does not accumulate one dead div
  // per test for the length of the file.
  for (const container of toUnmount) {
    render(null, container);
    container.remove();
  }

  // ASSERTED HERE rather than thrown from the stub, because `api.ts` catches everything a stub can
  // throw and renders it as NO ANSWER, which is a legitimate state with a legitimate test.
  expect(missed, 'this test mounted the island without installing a fixture').toBe(0);
});

const receipt = (overrides: Partial<MemoryListReceiptView> = {}): MemoryListReceiptView => ({
  kinds: [],
  limit: 50,
  returned: 1,
  coverage: 'COVERED',
  coverageReason: 'every row matching this filter fitted inside the bound',
  coverageCause: null,
  requestedAt: '2026-08-09T10:00:00.000Z',
  elapsedMs: 4,
  ...overrides,
});

const row = (overrides: Partial<MemoryRowView> = {}): MemoryRowView => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  kind: 'observation',
  content: 'the checkout pods were evicted at 02:14',
  state: 'current',
  freshness: 0.5,
  stale: false,
  ageDays: 3,
  halfLifeDays: 30,
  confirmations: 2,
  contradictions: 1,
  assertedBy: 'the on-call engineer',
  incidentId: 'INC-42',
  supersededBy: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  validFrom: '2026-08-01T09:00:00.000Z',
  validUntil: null,
  evictedAt: null,
  evictionReason: null,
  ...overrides,
});

const listing = (
  rows: readonly MemoryRowView[],
  overrides: Partial<MemoryListReceiptView> = {},
): MemoryListResponse => ({
  server: 'throughline-api',
  receipt: receipt({ returned: rows.length, ...overrides }),
  memories: rows,
});

const elements = (scope: HTMLElement, selector: string): HTMLElement[] =>
  Array.from(scope.querySelectorAll(selector)).map(asElement);

const words = (node: Element | null): string => (node?.textContent ?? '').replace(/\s+/gu, ' ').trim();

/**
 * A cell BY ITS PRINTED LABEL rather than by position.
 *
 * The strips are four and three cell rows whose order is itself a design decision, and an index
 * based lookup would go quietly green if two cells were swapped. Reading the `<b>` means a test that
 * says "the Bound cell" is checking the cell a person would point at.
 */
function cell(scope: HTMLElement, label: string): HTMLElement | null {
  for (const one of elements(scope, '.cell')) {
    if (words(one.querySelector('b')) === label) return one;
  }
  return null;
}

/**
 * The span inside a labelled cell, or a failure naming the label.
 *
 * THROWING IS THE WHOLE POINT, and a review found the version that did not. Returning `''` for an
 * absent cell makes every `.not.toContain(...)` below pass against a cell that is not there, so a
 * renamed label would turn those assertions into controls that cannot fail rather than reddening
 * them. A test that means to assert absence uses `cell` directly and expects null.
 */
function cellSpan(scope: HTMLElement, label: string): HTMLElement {
  const found = cell(scope, label)?.querySelector('span') ?? null;
  if (found === null) throw new Error(`no cell is labelled ${label}`);
  return asElement(found);
}

const cellText = (scope: HTMLElement, label: string): string => words(cellSpan(scope, label));

/**
 * An element's class, where a MISSING class attribute is a failure rather than an empty string.
 *
 * TWO DEFECTS DEEP, AND THE SECOND IS A linkedom DEVIATION WORTH KNOWING. The first version of the
 * callers ended in `?? ''`, and a review measured what that bought: stripping the class off the
 * Valid until span left the suite green, because `''` satisfies `.not.toContain('doubt')`
 * perfectly. The obvious fix, throwing when `getAttribute` returns `null`, was written and PLANTED
 * AGAINST, and the mutant survived anyway.
 *
 * The reason is measured, not guessed, and the SCOPE of it matters because the first version of
 * this paragraph overstated it. On linkedom 0.18.13, `getAttribute('class')` returns `''` for a
 * class attribute that is not there, where the DOM specifies `null`. It is **`class` alone**:
 * `style`, `title`, `href`, `aria-pressed`, `aria-live` and a `data-` attribute all return `null`
 * correctly on the same element. Saying it of `getAttribute` generally would tell the next author
 * that a `=== null` check on `aria-pressed` is dead, and it is not.
 *
 * For `class`, then, the `=== null` guard could never fire, which made it a branch that reads as
 * coverage and provides none, inside a helper written to remove exactly that. `hasAttribute`
 * reports absence correctly for every attribute and is what this uses. The `?? ''` below satisfies
 * the DOM's `string | null` type after absence has already been ruled out, and cannot be reached.
 *
 * ONE HELPER, TWO CALLERS, deliberately. The cell class and the holder class are the same decision
 * about the same kind of value, and this repository's rule is that such a decision lives in one
 * place both call rather than in two expressions that happen to agree.
 */
function classOf(element: HTMLElement, what: string): string {
  if (!element.hasAttribute('class')) throw new Error(`${what} has no class attribute`);
  return element.getAttribute('class') ?? '';
}

const cellClass = (scope: HTMLElement, label: string): string =>
  classOf(cellSpan(scope, label), `the cell labelled ${label}`);

/** The receipt strip, which is the one inside the live region. Row cells share the same labels. */
const receiptStrip = (container: HTMLElement): HTMLElement => {
  const live = container.querySelector('[aria-live]');
  if (live === null) throw new Error('the receipt strip is not in the document');
  return asElement(live);
};

const strips = (container: HTMLElement): HTMLElement[] => elements(container, '.rack > .strip');

/**
 * The nth racked strip, or a failure naming which one was missing.
 *
 * THROWING RATHER THAN RETURNING `undefined` is the point, though NOT for the reason first written
 * here. That sentence claimed `.not.toContain(...)` would PASS against `undefined`. A review
 * measured it under this project's vitest 4 and it does not: it fails with "the given combination
 * of arguments (undefined and string) is invalid". The real reasons are that this names WHICH
 * strip was missing instead of failing somewhere downstream, and that the same shape one level
 * down, an empty string rather than `undefined`, genuinely is vacuous. See `cellClass`.
 */
function stripAt(container: HTMLElement, index: number): HTMLElement {
  const found = strips(container)[index];
  if (found === undefined) throw new Error(`no strip was racked at index ${index}`);
  return found;
}

/**
 * The holder is the strip's first child span, and its class is a claim about the memory.
 *
 * Goes through `classOf` for the same reason `cellClass` does. Every caller today compares with
 * `.toBe`, so an empty string would redden anyway, but the next caller to write `.not.toContain`
 * would inherit a vacuous assertion and nothing would say so.
 */
function holderClass(strip: HTMLElement): string {
  const holder = strip.querySelector('span');
  if (holder === null) throw new Error('the strip has no holder to carry a class');
  return classOf(asElement(holder), 'the strip holder');
}

/**
 * The one slip on the page, or null when there is none.
 *
 * EXACTLY ONE OR NONE, ASSERTED HERE SO ALL THREE READERS INHERIT IT. The guard was added to
 * `slipClosing` alone, which left `slipWords` and `slipDetail` taking the first match of two, and a
 * fix that closes one instance and leaves its siblings is the shape this whole file documents. It is
 * defensive rather than a live bug: `Archive.tsx` renders one `Slip` per state today. `Console.tsx`
 * has three slip sites, which is why its twin asserts the same thing.
 */
function slip(container: HTMLElement): HTMLElement | null {
  const found = [...container.querySelectorAll('.empty')];
  if (found.length > 1) throw new Error(`this page has ${found.length} slips, so "the" slip is ambiguous`);
  return found.length === 0 ? null : asElement(found[0]);
}

/**
 * The WHOLE slip's words, where an absent slip is a failure rather than an empty string.
 *
 * THE FOURTH TIME THIS FILE HAS MET THE SAME SHAPE, and the first three are documented above in
 * `cellClass`, `slipDetail` and `stripAt`. `words()` is `(node?.textContent ?? '')`, so
 * `words(slip(container))` yields `''` when there is no slip at all, and every `.not.toContain(...)`
 * written against it passes on a page that never rendered one. The commit that closed the third
 * instance opened this one on its own new test, which is this repository's defect shape exactly: a
 * fix that closes an instance and leaves the category.
 *
 * A test that means to assert the slip is ABSENT still uses `slip` directly and expects null, which
 * is the honest way to say it.
 */
function slipWords(container: HTMLElement): string {
  const found = slip(container);
  if (found === null) throw new Error('there is no slip on this page to read');
  return words(found);
}

/**
 * The slip's FIRST paragraph.
 *
 * THIS EXISTS BECAUSE THE WHOLE-SLIP READ WAS TOO COARSE TO TELL TWO STATES APART. Every refusal
 * slip ends with a fixed paragraph, and the unreachable one contains the words "could not be
 * reached". So a test asserting the whole slip contains that phrase passes whatever the API
 * actually said, including when it said something else entirely. The timeout test caught it: it
 * rendered the correct timeout sentence and still matched the phrase it was asserting against.
 *
 * IT IS THE API'S OWN SENTENCE FOR `unreachable` AND `refused` ONLY, which is narrower than the
 * headline this docblock first carried. Those two states render `state.failure.detail` first. For
 * `asking`, `not-asked`, `unknown` and `empty` the first paragraph is prose the page wrote, and for
 * `rows` there is no slip at all, which is the state where the throw below actually fires. That is
 * SEVEN states, and the first version of this list enumerated six: the producer was short one
 * member in the paragraph whose whole job was accurate narrowing. Both callers are on the two
 * states where the narrow claim holds.
 *
 * THROWS RATHER THAN RETURNING `''`, because the commit that added this converted `cellClass` and
 * `holderClass` to throw for exactly that reason and then introduced a fresh falsy sentinel two
 * hundred lines further down. A review counted it.
 */
function slipDetail(container: HTMLElement): string {
  const found = slip(container);
  if (found === null) throw new Error('there is no slip on this page to read a detail from');
  const paragraph = found.querySelector('.slip p');
  if (paragraph === null) throw new Error('the slip has no paragraph to read a detail from');
  return words(paragraph);
}

/**
 * The slip's LAST paragraph, which is the sentence the page wrote rather than the one the API sent.
 *
 * IT EXISTS BECAUSE A NEGATIVE CANNOT GUARD A CLAIM, ONLY A WORDING. A review found two assertions
 * added by the very commit that articulated the rule: `.not.toContain('was reachable')`, against a
 * substring no rendered string in `apps/web/src` contains, so neither could fail on any input. Worse
 * than vacuous, they were misleading, because the claim they meant to guard has now been
 * reintroduced in FRESH WORDING three generations running, and a fourth rewrite would pass them.
 *
 * Asserting this paragraph WHOLE is the only form that makes a rewrite visible: any new sentence,
 * however phrased, fails until somebody reads it and decides it is true.
 *
 * THROWS, like `slipWords` and `slipDetail`, and for the reason documented on both.
 */
function slipClosing(container: HTMLElement): string {
  // THE ONE SLIP, through the shared reader, which is where the exactly-one check now lives. It was
  // added here alone and left `slipWords` and `slipDetail` taking the first match of two: a fix that
  // closed one instance and left its siblings, in the file that documents that shape four times.
  const found = slip(container);
  if (found === null) throw new Error('there is no slip on this page to read a closing sentence from');
  const paragraphs = elements(found, '.slip p');
  const last = paragraphs.at(-1);
  if (last === undefined) throw new Error('the slip has no paragraph to read a closing sentence from');
  return words(last);
}

/** A filter chip by the word printed on it. Throws rather than returning nothing, same as `stripAt`. */
function chip(container: HTMLElement, label: string): HTMLElement {
  const found = elements(container, '.chip').find((one) => words(one) === label);
  if (found === undefined) throw new Error(`no chip is labelled ${label}`);
  return found;
}

describe('the archive island, hydrated', () => {
  it('renders NOT ASKED before its effect and a measured verdict after it', async () => {
    // THE CONTROL FOR EVERY OTHER TEST IN THIS FILE. If the effect stops running, this fails here
    // by name rather than leaving the rest of the file silently asserting against static markup.
    answers(listing([row()]));
    const container = mount();

    expect(cellText(receiptStrip(container), 'Verdict')).toBe('NOT ASKED');
    // UNLIT, and the colour matters as much as the word. `shapes.ts` puts it exactly right: an
    // unlit lamp is not an OK lamp. Nothing has been measured yet, so a colour here would be a
    // claim nobody earned.
    expect(cellClass(receiptStrip(container), 'Verdict')).toBe('verdict v-unk');
    expect(cellText(receiptStrip(container), 'Rows shown')).toBe('none yet');
    expect(requested).toEqual([]);

    await settle();

    expect(cellText(receiptStrip(container), 'Verdict')).toBe('COVERED');
    expect(cellText(receiptStrip(container), 'Rows shown')).toBe('1');
    expect(requested).toEqual([`${API_BASE}/memories`]);
  });

  it('says ASKING while a request is open rather than reporting a count it does not have', async () => {
    neverAnswers();
    const container = await mountAndSettle();

    const strip = receiptStrip(container);
    expect(cellText(strip, 'Verdict')).toBe('ASKING');
    expect(cellClass(strip, 'Verdict')).toBe('verdict v-unk');
    // The distinction this cell exists for: "asking" is not "none yet", and neither is a number.
    expect(cellText(strip, 'Rows shown')).toBe('asking');
    expect(cellClass(strip, 'Rows shown')).toContain('doubt');
    expect(slipWords(container)).toContain('The archive has been asked and has not answered yet');
  });

  it('racks one strip per row and prints the content of each', async () => {
    answers(
      listing([
        row({ id: 'row-one', content: 'the first thing that was true' }),
        row({ id: 'row-two', content: 'the second thing that was true' }),
      ]),
    );
    const container = await mountAndSettle();

    expect(strips(container)).toHaveLength(2);
    expect(words(container)).toContain('the first thing that was true');
    expect(words(container)).toContain('the second thing that was true');
    // No slip at all when there are rows: `StateSlip` returns null for the `rows` state.
    expect(slip(container)).toBeNull();
  });

  it('prints freshness to two decimals and flags a stale row instead of hiding it', async () => {
    answers(listing([row({ freshness: 0.5, stale: true })]));
    const container = await mountAndSettle();

    const strip = stripAt(container, 0);
    // `0.5` reaching a page as `0.5` rather than `0.50` would be a measurement rendered at a
    // precision nobody chose, and the stale word has to be beside it rather than replacing it.
    expect(cellText(strip, 'Freshness')).toBe('0.50 stale');
    expect(cellClass(strip, 'Freshness')).toContain('doubt');
    expect(strip.getAttribute('class')).toContain('cocked');
  });

  it('leaves a fresh row uncocked and prints no stale word', async () => {
    answers(listing([row({ freshness: 0.94, stale: false })]));
    const container = await mountAndSettle();

    const strip = stripAt(container, 0);
    expect(cellText(strip, 'Freshness')).toBe('0.94');
    expect(strip.getAttribute('class')).not.toContain('cocked');
    expect(cellClass(strip, 'Freshness')).not.toContain('doubt');
  });

  it('keeps the tombstone holder whatever the kind, and keeps a superseded row its kind colour', async () => {
    answers(
      listing([
        row({ id: 'a', kind: 'resolution', state: 'tombstoned' }),
        row({ id: 'b', kind: 'resolution', state: 'superseded' }),
      ]),
    );
    const container = await mountAndSettle();

    const tombstoned = stripAt(container, 0);
    const superseded = stripAt(container, 1);
    expect(holderClass(tombstoned)).toBe('holder h-tomb');
    // Replaced, not removed: the chain is only readable if both ends still look related.
    expect(holderClass(superseded)).toBe('holder h-res');
    expect(tombstoned.getAttribute('class')).toContain('retired');
    expect(superseded.getAttribute('class')).toContain('retired');
  });

  it('prints the tombstone date and reason, and names both when either is missing', async () => {
    answers(
      listing([
        row({ id: 'a', state: 'tombstoned', evictedAt: '2026-07-02T05:00:00.000Z', evictionReason: 'the sweep' }),
        row({ id: 'b', state: 'tombstoned', evictedAt: null, evictionReason: null }),
      ]),
    );
    const container = await mountAndSettle();

    expect(cellText(stripAt(container, 0), 'Tombstoned')).toBe('2026-07-02 · the sweep');
    expect(cellText(stripAt(container, 1), 'Tombstoned')).toBe('no date recorded · no reason recorded');
  });

  it('gives a current row no tombstone cell at all', async () => {
    answers(listing([row({ state: 'current' })]));
    const container = await mountAndSettle();

    const strip = stripAt(container, 0);
    expect(cell(strip, 'Tombstoned')).toBeNull();
    expect(cellText(strip, 'State')).toBe('Current');
    expect(cellClass(strip, 'State')).toBe('stamp prot');
    // THE OTHER ARM OF `retired`. Only the superseded and tombstoned rows asserted it, so forcing
    // the suffix on unconditionally left the suite green while every CURRENT row rendered greyed as
    // though it had been replaced, on the page whose whole argument is that those must not look
    // alike. Through `classOf` like every other class read in this file, rather than raw
    // `getAttribute`, which the commit that added this line used while converting other reads away
    // from it.
    expect(classOf(strip, 'the current row strip')).toBe('strip');
  });

  it('truncates a superseding id to its first segment and says nothing when there is none', async () => {
    answers(
      listing([
        row({ id: 'a', supersededBy: 'deadbeef-1111-2222-3333-444444444444' }),
        row({ id: 'b', supersededBy: null }),
      ]),
    );
    const container = await mountAndSettle();

    // A full UUID pushes every other cell off a phone. Eight characters still match strip to strip.
    const replaced = stripAt(container, 0);
    const standing = stripAt(container, 1);
    expect(cellText(replaced, 'Superseded by')).toBe('deadbeef…');
    expect(cellText(standing, 'Superseded by')).toBe('nothing');
    // NEITHER arm of this cell's class was asserted at all until round 14 counted them. A row that
    // was replaced has to read as doubt and a row that stands has to not.
    expect(cellClass(replaced, 'Superseded by')).toBe('val doubt');
    expect(cellClass(standing, 'Superseded by')).toBe('val');
  });

  it('prints both confirmations and contradictions, never only the flattering one', async () => {
    answers(listing([row({ confirmations: 7, contradictions: 3 })]));
    const container = await mountAndSettle();

    // Contradiction subtracts more than confirmation adds, so one number alone would misrepresent it.
    expect(cellText(stripAt(container, 0), 'Confirmed / argued with')).toBe('7 / 3');
  });

  it('reads an open validity interval as a fact rather than as an empty cell', async () => {
    answers(
      listing([
        row({ id: 'a', validFrom: '2026-08-01T09:00:00.000Z', validUntil: null }),
        row({ id: 'b', validUntil: '2026-08-07T09:00:00.000Z' }),
      ]),
    );
    const container = await mountAndSettle();

    const open = stripAt(container, 0);
    const closed = stripAt(container, 1);
    expect(cellText(open, 'Valid from')).toBe('2026-08-01');
    expect(cellText(open, 'Valid until')).toBe('still current');
    expect(cellText(closed, 'Valid until')).toBe('2026-08-07');
    // BOTH ARMS, ASSERTED WHOLE. `.not.toContain('doubt')` was the only class assertion here and it
    // left the other arm open: forcing this cell to `'val'` always renders an EXPIRED interval as a
    // confident lit value, which is the inversion this page exists to argue against.
    expect(cellClass(open, 'Valid until')).toBe('val');
    expect(cellClass(closed, 'Valid until')).toBe('val doubt');
  });

  it('says no incident is recorded rather than leaving the cell blank', async () => {
    answers(listing([row({ id: 'a', incidentId: null }), row({ id: 'b', incidentId: 'INC-42' })]));
    const container = await mountAndSettle();

    const missing = stripAt(container, 0);
    const recorded = stripAt(container, 1);
    expect(cellText(missing, 'Incident')).toBe('none recorded');
    expect(cellText(recorded, 'Incident')).toBe('INC-42');
    // Both arms. Forcing this to doubt renders a RECORDED incident as if it were missing, which is
    // the same lie in the opposite direction.
    expect(cellClass(missing, 'Incident')).toBe('val doubt');
    expect(cellClass(recorded, 'Incident')).toBe('val');
  });

  it('prints a kind the console has no label for as itself, with an uncoloured holder', async () => {
    // The response guard checks `kind` as a string on purpose, so a kind the server adds later
    // reaches the page. A colourless holder is a claim about the memory, so it must not be silent.
    answers(listing([row({ kind: 'weather_report' as MemoryKind })]));
    const container = await mountAndSettle();

    const strip = stripAt(container, 0);
    expect(holderClass(strip)).toBe('holder');
    expect(cellText(strip, 'Kind')).toBe('weather_report');
  });

  it('draws the nothing-matched slip and no strips when the listing ran and matched nothing', async () => {
    answers(listing([], { coverage: 'COVERED', returned: 0 }));
    const container = await mountAndSettle();

    expect(strips(container)).toHaveLength(0);
    // The one state where an empty rack IS the answer, and it has to say so in its own words.
    expect(slipWords(container)).toContain('the listing completed and no row in the archive matches');
    expect(cellText(receiptStrip(container), 'Verdict')).toBe('COVERED');
    // The COLOUR is a claim somebody earned by measuring, so it is asserted rather than assumed.
    // A mutant that broke the COVERED arm of `verdictClass` survived until this line existed.
    expect(cellClass(receiptStrip(container), 'Verdict')).toBe('verdict v-cov');
    expect(cellText(receiptStrip(container), 'Rows shown')).toBe('0');
  });

  it('names the filtered kind in the nothing-matched sentence when one was applied', async () => {
    answers(listing([], { coverage: 'COVERED', returned: 0, kinds: ['runbook_fact'] }));
    const container = await mountAndSettle();

    expect(slipWords(container)).toContain('no row in the archive matches the kind RUNBOOK FACT');
  });

  it('refuses to call an incomplete listing an empty archive', async () => {
    answers(
      listing([], {
        coverage: 'UNKNOWN',
        returned: 0,
        coverageCause: 'listing_query_failed',
        coverageReason: 'the archive query did not complete',
      }),
    );
    const container = await mountAndSettle();

    const text = slipWords(container);
    expect(text).toContain('could not read the archive');
    expect(text).toContain('the archive query did not complete');
    // The whole point of the state: an empty rack under UNKNOWN would mean nothing at all.
    expect(text).not.toContain('no row in the archive matches');
    expect(cellText(receiptStrip(container), 'Verdict')).toBe('UNKNOWN');
    // `.toBe` RATHER THAN `.toContain`, and the difference is not pedantry. Round 14 measured it:
    // with `.toContain('v-unk')` the fallback in `verdictClass` could return `'verdict v-unk
    // v-cov'` and the suite stayed green, so an UNKNOWN lamp was free to wear the COVERED colour.
    expect(cellClass(receiptStrip(container), 'Verdict')).toBe('verdict v-unk');
  });

  // THE THREE BODIES THAT MADE THIS PAGE ARGUE WITH ITSELF. Each is a receipt that contradicts the
  // rows delivered beside it, so there is no honest sentence left to print about the archive and the
  // page says that instead. `describeListing` makes the decision and `archive-state.test.ts` pins it;
  // these three assert the page a visitor is actually handed, which is the half that used to rack
  // rows under a slip denying it could read them.
  //
  // EVERY ASSERTION OF AN ABSENCE HERE CARRIES A POST-EFFECT ANCHOR, per this file's header: an
  // unhydrated page racks no strips either, so `toHaveLength(0)` alone would pass against markup
  // nobody hydrated. The anchor is the verdict word, which exists only after a fetch has landed.
  it('racks nothing and refuses when UNKNOWN arrives carrying rows', async () => {
    answers(
      listing([row({ content: 'a row delivered with a listing that could not be read' })], {
        coverage: 'UNKNOWN',
        returned: 1,
        coverageCause: 'listing_query_failed',
      }),
    );
    const container = await mountAndSettle();

    expect(cellText(receiptStrip(container), 'Verdict')).toBe('UNRECOGNISED_RESPONSE');
    expect(strips(container)).toHaveLength(0);
    expect(words(container)).not.toContain('a row delivered with a listing that could not be read');
    expect(slipDetail(container)).toContain('it says the listing could not be read');
  });

  it('refuses PARTIAL carrying no rows rather than printing the completed-listing sentence', async () => {
    answers(listing([], { coverage: 'PARTIAL', returned: 0 }));
    const container = await mountAndSettle();

    expect(cellText(receiptStrip(container), 'Verdict')).toBe('UNRECOGNISED_RESPONSE');
    // The one sentence on this page that asserts an absence, which a listing stopped at a bound has
    // not established. This body used to produce it.
    //
    // `slipWords` RATHER THAN `words(slip(...))`, because that form returns `''` when there is no
    // slip at all and every `.not.toContain` against it then passes vacuously. This file has found
    // that falsy-sentinel shape three times already, in `cellClass`, in `slipDetail` and in
    // `stripAt`, and the fourth was written here by the commit closing the third.
    expect(slipWords(container)).not.toContain('the listing completed and no row in the archive matches');
    expect(slipDetail(container)).toContain('holds more than the bound of 50');
    // Carried from the test this replaces, which asserted the same fixture rendered a PARTIAL
    // verdict and no tag. The tag says "the archive holds more than N matching rows, so these are
    // the newest of them", and there is no "these" to point at.
    expect(container.querySelector('.tag')).toBeNull();
  });

  it('refuses a receipt whose count disagrees with the rows it delivered', async () => {
    // The Rows shown cell prints `receipt.returned` while the rack renders the array, so this body
    // would have printed 9 directly above a rack holding a single strip.
    answers(listing([row()], { returned: 9 }));
    const container = await mountAndSettle();

    expect(cellText(receiptStrip(container), 'Verdict')).toBe('UNRECOGNISED_RESPONSE');
    expect(cellText(receiptStrip(container), 'Rows shown')).toBe('none yet');
    expect(strips(container)).toHaveLength(0);
    expect(slipDetail(container)).toContain('it counts 9 rows, and 1 row arrived with it');
  });

  it('does not claim the API refused a body it answered normally', async () => {
    // The `refused` state covers two different events and the slip used to describe only one. A 200
    // carrying a self-contradicting body is this console declining to read a result out of an
    // answer the API gave normally, and "The API answered and refused" is false about it, on the
    // page whose whole argument is that those must be kept apart.
    answers(listing([], { coverage: 'PARTIAL', returned: 0 }));
    const container = await mountAndSettle();

    const text = slipWords(container);
    expect(text).toContain('THIS CONSOLE COULD NOT READ THE ANSWER');
    expect(text).toContain('could not read a result out of the answer');
    // THE SIBLING ARM'S SENTENCE, kept current on purpose. This named a phrase production stopped
    // emitting, which is a negative nothing can fail. It has to name what the OTHER arm says now.
    expect(text).not.toContain('The answer named its own refusal');
    // The claim that survives in both wordings, because it is the one that matters here.
    expect(text).toContain('Nothing here says the archive is empty');
  });

  it('does not deny that the API refused when the refusal itself was unreadable', async () => {
    // THE SIBLING OF THE TEST ABOVE, and the one its first version broke. `UNRECOGNISED` does NOT
    // imply a 200: `asFailure` mints it for any non-2xx whose body is not `{error, detail}`, so a
    // 429 from a gateway or a 502 carrying HTML reaches the same arm. The branch written to stop
    // the page claiming the API refused a 200 then told a rate-limited visitor the API had not
    // refused, which is the identical false sentence pointing the other way.
    answers({ message: 'Too Many Requests' }, 429);
    const container = await mountAndSettle();

    const text = slipWords(container);
    expect(cellText(receiptStrip(container), 'Verdict')).toBe('UNRECOGNISED_RESPONSE');
    // The status the console DOES know is printed, and it is a refusal.
    // "SOMETHING ANSWERED", because this arm takes any non 2xx whose body is not a failure shape,
    // and a 502 from a CDN reaches it without ever touching this product. The status code is the one
    // thing the console does know and it is still printed.
    expect(text).toContain('Something answered 429 in a shape this console does not recognise');
    // The negative that stood here forbade "this console refused the answer", which no production
    // path emits: a dead assertion sitting beside the live whole-paragraph pin that replaced it. It
    // is deleted rather than reworded, because a negative guards a wording and the pin guards the
    // claim.
    // THE ARCHIVE MUST NOT BE REPORTED AS REACHED. This 429 is answered by rate-limit middleware before
    // `/memories` runs, and a 502 carrying HTML need not have reached this product at all, yet both
    // land on this arm. The arm that stopped naming WHO refused went on to name WHAT was reached.
    // Asserted WHOLE, for the reason given on the sibling test below.
    expect(slipClosing(container)).toBe(
      'Something answered this request, and this console could not read a result out of the answer. ' +
        'That is a fact about the response and not about the memory. Nothing here says the archive is empty.',
    );
    expect(text).toContain('Nothing here says the archive is empty');
  });

  it('names the stage that stopped a listing in the Why cell', async () => {
    // UNKNOWN WITH NO ROWS, which is the only shape that carries a cause. This fixture used to be
    // PARTIAL with a row, and the producer sets `coverageCause` in exactly one place,
    // `emptyUnknownPage`, which always reports UNKNOWN with an empty page. A cause beside any other
    // verdict is now refused as a contradiction, so the fixture was corrected to the body a real
    // stopped listing sends rather than the guard being loosened to keep an impossible one green.
    //
    // THE REASON IS THE ONE THE PRODUCER PAIRS WITH THIS CAUSE, which the first correction got
    // wrong: it kept "the bound was reached" beside `row_unreadable`, a pairing `runList` never
    // sends, because `coverageReason` is free text nothing checks. Half-correcting a fixture leaves
    // it impossible in a way no guard can catch.
    answers(
      listing([], {
        coverage: 'UNKNOWN',
        returned: 0,
        coverageReason: 'a row could not be read, so this page would be missing rows without being able to say which',
        coverageCause: 'row_unreadable',
      }),
    );
    const container = await mountAndSettle();

    // The cause is a CODE on the wire and a sentence in the browser, so the page owns the wording.
    expect(cellText(receiptStrip(container), 'Why')).toBe(
      'a row could not be read, so this page would be missing rows without being able to say which · ' +
        'stopped by a row could not be read, so rows would be missing without being named',
    );
  });

  it('prints no stopped-by clause when the listing named no cause', async () => {
    answers(listing([row()], { coverageReason: 'every row fitted inside the bound' }));
    const container = await mountAndSettle();

    expect(cellText(receiptStrip(container), 'Why')).toBe('every row fitted inside the bound');
  });

  it('reports the API error code as the verdict when the API answered and refused', async () => {
    answers({ error: 'rate_limited', detail: 'The demo allows three questions a minute.' }, 429);
    const container = await mountAndSettle();

    const strip = receiptStrip(container);
    // A rate limit the visitor caused is NOT the API being unreachable, and the archive used to
    // tell them their browser could not reach it.
    expect(cellText(strip, 'Verdict')).toBe('RATE_LIMITED');
    // Refused is still nothing measured, so the lamp stays unlit even though the API answered.
    expect(cellClass(strip, 'Verdict')).toBe('verdict v-unk');
    expect(cellText(strip, 'Rows shown')).toBe('none yet');
    expect(cellText(strip, 'Bound')).toBe('unknown');
    const text = slipWords(container);
    expect(text).toContain('The demo allows three questions a minute.');
    expect(text).toContain('The answer named its own refusal');
    expect(text).not.toContain('could not be reached');
    // THE CLAIM THE PREVIOUS FIX OPENED, and this fixture is the exact input that falsified it.
    // `server.ts` answers 429 from rate-limit middleware that runs BEFORE `/memories` calls
    // `repository.list`, so nothing read the archive and the slip may not say it was reachable.
    // This is the likeliest refusal on the page: a visitor clicking filter chips causes it.
    //
    // ASSERTED WHOLE rather than as `.not.toContain('was reachable')`, which is how this was first
    // written and could not fail: no rendered string contains that substring, and the claim has
    // come back in fresh wording three generations running, so pinning a dead phrase guards the
    // wording and not the claim.
    expect(slipClosing(container)).toBe(
      'The answer named its own refusal, which is a different thing from no answer at all. It does ' +
        'not say the archive was read. Nothing here says the archive is empty.',
    );
  });

  it('says the browser could not reach the API when the request never lands', async () => {
    unreachable();
    const container = await mountAndSettle();

    expect(cellText(receiptStrip(container), 'Verdict')).toBe('NO ANSWER');
    expect(cellClass(receiptStrip(container), 'Verdict')).toBe('verdict v-unk');
    // The DETAIL, asserted whole. Reading the whole slip for this phrase would also match the
    // fixed paragraph every refusal slip carries, so it would pass on a timeout too.
    expect(slipDetail(container)).toBe(
      'The API could not be reached from this browser. Nothing here says the memory is empty.',
    );
    expect(slipWords(container)).toContain('Nothing here says the archive is empty');
    // The closing paragraph, which now says only what a connection failure and a timeout share.
    expect(slipWords(container)).toContain('which is a fact about this request and not about the memory');
  });

  it('refuses a 200 whose body the console cannot read rather than racking it', async () => {
    // The guard in `shapes.ts` runs for real here. A receipt too thin to explain anything must not
    // arrive as a completed listing.
    answers({ server: 'throughline-api', receipt: { coverage: 'COVERED' }, memories: [] });
    const container = await mountAndSettle();

    expect(cellText(receiptStrip(container), 'Verdict')).toBe('UNRECOGNISED_RESPONSE');
    expect(slipWords(container)).toContain('does not recognise');
    expect(strips(container)).toHaveLength(0);
  });

  // Named for the half it asserts. It used to promise "and leaves a covered one untagged" as well,
  // which is the test immediately below it.
  it('tags a bounded listing that returned rows', async () => {
    // THE BOUND EQUALS THE ROW COUNT, because PARTIAL is measured by asking for one row more than
    // the bound, so a bounded page carries exactly `limit` rows. This fixture was one row under a
    // bound of fifty, which pinned the tag "the archive holds more than 50 matching rows" over a
    // rack holding one: the contradiction this commit exists to stop, asserted as correct.
    answers(listing([row({ id: 'row-one' }), row({ id: 'row-two' })], { coverage: 'PARTIAL', limit: 2 }));
    const container = await mountAndSettle();

    expect(words(container.querySelector('.tag'))).toContain('the archive holds more than 2 matching rows');
    expect(cellClass(receiptStrip(container), 'Verdict')).toBe('verdict v-par');
  });

  it('leaves a COVERED listing untagged', async () => {
    answers(listing([row()], { coverage: 'COVERED' }));
    const container = await mountAndSettle();

    // The verdict is asserted alongside the absence ON PURPOSE. An unhydrated page has no tag
    // either, so the absence alone would pass against markup nobody hydrated.
    expect(cellText(receiptStrip(container), 'Verdict')).toBe('COVERED');
    expect(container.querySelector('.tag')).toBeNull();
  });

  it('prints the bound the API applied rather than the number of rows it returned', async () => {
    // The two numbers agree in almost every real listing, so a cell printing `returned` where it
    // means `limit` would look right forever. They are forced apart here.
    answers(listing([row()], { limit: 25 }));
    const container = await mountAndSettle();

    const strip = receiptStrip(container);
    expect(cellText(strip, 'Bound')).toBe('25 rows');
    expect(cellText(strip, 'Rows shown')).toBe('1');
    // THE LIT ARMS OF BOTH CELLS, which is H1's defect one and two cells over. The Verdict lamp was
    // fixed and these two were left, and a review measured it: forcing either class to a constant
    // left forty of forty green. Something HAS been measured here, so neither may read as doubt.
    expect(cellClass(strip, 'Bound')).toBe('val');
    expect(cellClass(strip, 'Rows shown')).toBe('val');
  });

  it('marks the bound cell as doubt when nothing has been measured', async () => {
    // The other arm of the same ternary. Nothing answered, so the bound is unknown and the cell has
    // to say so in its colour as well as its word.
    unreachable();
    const container = await mountAndSettle();

    const strip = receiptStrip(container);
    // THE ANCHOR, and this test needed one for the third time in this file. Unlit IS the
    // pre-hydration state, so "the bound is unknown and both cells read as doubt" is satisfied
    // perfectly by a page nobody hydrated. Measured: without this line, and with the frame
    // scheduler dead, this was the only passing test of forty-two. NOT ASKED and NO ANSWER are
    // what separate the two, so the verdict is what has to be asserted.
    expect(cellText(strip, 'Verdict')).toBe('NO ANSWER');
    expect(cellText(strip, 'Bound')).toBe('unknown');
    expect(cellClass(strip, 'Bound')).toBe('val doubt');
    expect(cellClass(strip, 'Rows shown')).toBe('val doubt');
  });

  it('says the API did not answer within its timeout when the request never lands', async () => {
    // THE TIMEOUT SENTENCE, which is a different claim from "could not be reached" and had no test
    // at all. The stub honours the `AbortSignal` that `api.ts` passes, and a review pointed out
    // that nothing asserted the honouring: neutering the abort listener left the suite green.
    vi.useFakeTimers();
    try {
      neverAnswers();
      const container = mount();
      // Past `STATUS_TIMEOUT_MS` in `api.ts`, so the controller aborts and the sentence changes.
      await vi.advanceTimersByTimeAsync(9_000);

      expect(cellText(receiptStrip(container), 'Verdict')).toBe('NO ANSWER');
      // The DETAIL paragraph, not the whole slip. A timeout and an unreachable API are two
      // different claims and they share the slip's closing prose.
      expect(slipDetail(container)).toBe(
        'The API did not answer within 8 seconds. Nothing here says the memory is empty.',
      );
      // THE HALF THIS TEST WAS MISSING, and the reason the defect survived being written down. The
      // shared closing paragraph asserted "The API could not be reached from this browser" under
      // BOTH events, so a slow cold start printed the timeout sentence and denied it on the next
      // line. Asserting only the detail could never catch that. This reads the WHOLE slip.
      expect(slipWords(container)).not.toContain('could not be reached');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prints the kind, age and half-life cells the two boards share', async () => {
    // `cells.tsx` is imported by both boards and was rendered by NO test in this repository until
    // this one. It exists because `gate:dup` refused the second copy of these three cells.
    answers(listing([row({ kind: 'runbook_fact', ageDays: 12, halfLifeDays: 90 })]));
    const container = await mountAndSettle();

    const strip = stripAt(container, 0);
    expect(cellText(strip, 'Kind')).toBe('RUNBOOK FACT');
    expect(cellText(strip, 'Age')).toBe('12 d');
    expect(cellText(strip, 'Half-life')).toBe('90 d');
    expect(holderClass(strip)).toBe('holder h-run');
  });

  it('stamps each state with its own word and never invents a colour for one it does not know', async () => {
    answers(
      listing([
        row({ id: 'a', state: 'superseded' }),
        row({ id: 'b', state: 'archived' as MemoryState }),
      ]),
    );
    const container = await mountAndSettle();

    const superseded = stripAt(container, 0);
    expect(cellText(superseded, 'State')).toBe('Superseded');
    expect(cellClass(superseded, 'State')).toBe('stamp grey');

    // The response guard checks `state` as a string on purpose, so a state added on the server
    // reaches the page. It prints as itself under the neutral stamp, which is odd and true.
    const unknown = stripAt(container, 1);
    expect(cellText(unknown, 'State')).toBe('archived');
    expect(cellClass(unknown, 'State')).toBe('stamp grey');
    expect(unknown.getAttribute('class')).toContain('retired');
  });

  it('prints who asserted the row', async () => {
    answers(listing([row({ assertedBy: 'system:demo-seed' })]));
    const container = await mountAndSettle();

    // Provenance is the column that tells the truth about where a row came from, so it is the last
    // cell that should ever be filled with something adjacent to it.
    expect(cellText(stripAt(container, 0), 'Asserted by')).toBe('system:demo-seed');
  });

  it('dims the content of a stale row and of a tombstoned one, and leaves a current row plain', async () => {
    answers(
      listing([
        row({ id: 'a', stale: true }),
        row({ id: 'b', state: 'tombstoned' }),
        row({ id: 'c' }),
      ]),
    );
    const container = await mountAndSettle();

    expect(cellClass(stripAt(container, 0), 'Content')).toBe('say doubt');
    expect(cellClass(stripAt(container, 1), 'Content')).toBe('say doubt');
    expect(cellClass(stripAt(container, 2), 'Content')).toBe('say');
  });

  it('lights the receipt holder once something has been measured and leaves it dark before', async () => {
    answers(listing([row()]));
    const container = mount();

    expect(holderClass(receiptStrip(container))).toBe('holder h-tomb');
    await settle();
    expect(holderClass(receiptStrip(container))).toBe('holder h-res');
  });

  it('marks the Why cell as doubt unless the listing was covered', async () => {
    // A bound of one with one row, for the same reason as the tag test above: PARTIAL carries
    // exactly `limit` rows, and the default bound of fifty made this a body no listing can send.
    answers(listing([row()], { coverage: 'PARTIAL', limit: 1, coverageReason: 'the bound was reached' }));
    const container = await mountAndSettle();

    expect(cellClass(receiptStrip(container), 'Why')).toBe('say doubt');
  });

  it('leaves the Why cell plain on a covered listing', async () => {
    answers(listing([row()], { coverage: 'COVERED' }));
    const container = await mountAndSettle();

    expect(cellClass(receiptStrip(container), 'Why')).toBe('say');
  });

  it('says an unnamed stage failed when the cause is one it has no sentence for', async () => {
    // The safe direction, and the sibling of this fallback in the Why cell does NOT take it: that
    // one prints the raw wire value. Recorded rather than changed here, because it is production
    // behaviour and this commit changes none.
    answers(
      listing([], {
        coverage: 'UNKNOWN',
        returned: 0,
        coverageCause: 'quota_exhausted' as ListFailureCause,
      }),
    );
    const container = await mountAndSettle();

    const text = slipWords(container);
    expect(text).toContain('an unnamed stage failed');
    expect(text).not.toContain('quota_exhausted');
  });

  it('names the pressed kind in the filter cell while its refetch is still open', async () => {
    // The one branch of `filterLabel` that reads the PRESSED button: there is no receipt yet
    // because the previous answer was cleared when the new request opened.
    answers(listing([row()], { kinds: ['entity_fact'] }));
    const container = await mountAndSettle();

    // THE THREE PRE-CLICK ASSERTIONS ARE WHAT SEPARATE TWO STATES: "the receipt was cleared by a
    // new request", which is the branch this test names, from "no receipt ever arrived", which is a
    // different one. Measured: remove all three and swap the fixture for `neverAnswers`, and the
    // suite is 42 green, so without them the test passes while no receipt ever arrives.
    //
    // WHAT FOLLOWS IS A TABLE AND NOTHING ELSE, and that is deliberate. Every defect found here has
    // been in a sentence rather than in the table. Sentences are not re-driven by anything. The
    // table is, because every cell names the commit it was measured at, and it has never had a
    // wrong cell at the three commits it has been driven at. If a future round finds an error in a
    // sentence here, DELETE IT rather than rewriting it.
    //
    // Mutating the fixture above, each cell driven at the commit named:
    //
    //   delete it entirely   a4fa1df: 1 failed of 40, ONLY the `callsWithNoFixture` guard spoke.
    //                        5a19e33: 1 failed of 42, the Filter assertion spoke FIRST.
    //   empty its rows       a4fa1df: 40 green.   5a19e33: 42 green. STILL SURVIVES.
    //   swap `neverAnswers`  a4fa1df: 40 green.   5a19e33: 1 failed of 42, Filter assertion.
    //
    //   `requested` line removed, at `13f5429`: the failing set is UNCHANGED across all three rows
    //   above, plus the `cancelAnimationFrame` mutation and a duplicated fetch.
    //
    //   duplicated fetch in the effect, at `13f5429`, with BOTH `requested` assertions removed from
    //   this test: this test PASSES and exactly two others fail. With them intact the pre-click line
    //   is what reports it. The Filter cell reads ENTITY FACT either way, because both fetches
    //   return the same body.
    expect(requested).toEqual([`${API_BASE}/memories`]);
    expect(cellText(receiptStrip(container), 'Filter')).toBe('ENTITY FACT');
    expect(cellText(receiptStrip(container), 'Verdict')).toBe('COVERED');

    neverAnswers();
    chip(container, 'RESOLUTION').dispatchEvent(new dom.Event('click'));
    await settle();

    expect(requested).toEqual([`${API_BASE}/memories`, `${API_BASE}/memories?kind=resolution`]);
    expect(cellText(receiptStrip(container), 'Verdict')).toBe('ASKING');
    expect(cellText(receiptStrip(container), 'Filter')).toBe('RESOLUTION');
  });

  it('titles every failure slip a refusal slip', async () => {
    answers({ error: 'internal_error', detail: 'Something went wrong.' }, 500);
    const container = await mountAndSettle();

    expect(words(container.querySelector('.slip .k'))).toBe('Refusal slip');
    // "THE API" is gone from this verdict: a proxy can answer 500 in the API's place, and this
    // console cannot tell which did. The code the answer carried is all it knows.
    expect(words(container.querySelector('.slip .v'))).toBe('REFUSED: INTERNAL_ERROR.');
  });

  it('reads the filter cell off the receipt rather than off the pressed chip', async () => {
    // The button that was pressed and the filter the API applied are two different facts, and this
    // cell reports the second. Nothing was pressed here and the receipt still names a kind.
    answers(listing([row()], { kinds: ['entity_fact'] }));
    const container = await mountAndSettle();

    expect(cellText(receiptStrip(container), 'Filter')).toBe('ENTITY FACT');
  });

  it('names every kind a multi-kind receipt reports', async () => {
    answers(listing([row()], { kinds: ['entity_fact', 'runbook_fact'] }));
    const container = await mountAndSettle();

    expect(cellText(receiptStrip(container), 'Filter')).toBe('ENTITY FACT, RUNBOOK FACT');
  });

  it('calls an unfiltered listing every kind rather than no kind', async () => {
    answers(listing([row()], { kinds: [] }));
    const container = await mountAndSettle();

    // An empty kinds list means EVERY kind, which is not "no kind matched".
    expect(cellText(receiptStrip(container), 'Filter')).toBe('every kind');
    // The unhydrated page ALSO says "every kind", because nothing has been pressed yet. Without
    // this line the assertion above would pass against markup nobody hydrated.
    expect(cellText(receiptStrip(container), 'Verdict')).toBe('COVERED');
  });

  it('asks again with the pressed kind and moves aria-pressed onto that chip', async () => {
    answersByUrl((url) =>
      url.includes('kind=resolution') ? listing([row({ kind: 'resolution' })], { kinds: ['resolution'] }) : listing([row()]),
    );
    const container = await mountAndSettle();

    // BEFORE the click, and this line is not decoration. A click re-renders, and preact flushes a
    // component's pending effects synchronously inside its next render, so the click alone would
    // issue both fetches even with the frame scheduler dead. Measured: with
    // `cancelAnimationFrame` removed this test PASSED while twenty-five others went red. Asserting
    // the first request landed during `settle` is what makes it depend on hydration rather than on
    // the click doing preact's scheduling for it.
    expect(requested).toEqual([`${API_BASE}/memories`]);

    const everyKind = chip(container, 'Every kind');
    const resolution = chip(container, 'RESOLUTION');
    expect(everyKind.getAttribute('aria-pressed')).toBe('true');
    // The UNPRESSED arm, which nothing asserted: forcing every chip to `'chip on'` left the suite
    // green, so the paper could show all six kinds pressed at once.
    expect(classOf(everyKind, 'the every-kind chip')).toBe('chip on');
    expect(classOf(resolution, 'the resolution chip')).toBe('chip');

    resolution.dispatchEvent(new dom.Event('click'));
    await settle();

    expect(requested).toEqual([`${API_BASE}/memories`, `${API_BASE}/memories?kind=resolution`]);
    expect(resolution.getAttribute('aria-pressed')).toBe('true');
    expect(classOf(resolution, 'the resolution chip')).toBe('chip on');
    expect(classOf(everyKind, 'the every-kind chip')).toBe('chip');
    expect(everyKind.getAttribute('aria-pressed')).toBe('false');
    expect(cellText(receiptStrip(container), 'Filter')).toBe('RESOLUTION');
  });

  it('scopes the live region to the receipt strip and not to the whole rack', async () => {
    // A rack can hold fifty strips of ten labelled cells. Announcing all of it on every filter
    // change is worse than announcing nothing, and the receipt is the part that says what happened.
    answers(listing([row(), row({ id: 'second' })]));
    const container = await mountAndSettle();

    const live = receiptStrip(container);
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(elements(live, '.strip')).toHaveLength(1);
    expect(strips(container)).toHaveLength(2);
    expect(words(live)).not.toContain('the checkout pods were evicted');
  });
});
