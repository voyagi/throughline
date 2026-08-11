import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentTurnResponse,
  CoverageCause,
  MemoryKind,
  RecallEventView,
  RecallReceiptView,
  RecalledMemoryView,
  RetrievalPath,
} from '../src/scripts/types.ts';

/**
 * THE FIRST TEST THAT RENDERS THE CONSOLE, which is the page this product demonstrates itself on.
 *
 * `archive-island.test.ts` exists because a review found three defects in the archive's rendering
 * and nothing was watching it. The console was in the same position and worse: it is the screen a
 * sceptic opens first, it prints a receipt over a rack it never compared it to, and no test in this
 * repository had ever mounted it.
 *
 * THE SIBLING FILE'S CONTROL IS NOT THIS FILE'S CONTROL, and that was measured rather than
 * inherited. `archive-island.test.ts` rests on the frame scheduler pair, because the archive fetches
 * from a mount effect and preact decides at module load whether the host has one. Removing
 * `cancelAnimationFrame` from THIS file reddens NONE of its tests, and the exact figure is measured
 * below rather than twice. Copying the sibling's paragraph would have put a false claim at the top
 * of a new file on the strength of it being true next door, which is the failure this repository
 * keeps finding in its own prose. `Console.tsx` uses `useRef` and `useState` and no `useEffect` at
 * all, so preact never reaches the frame scheduler here.
 *
 * Both halves are still installed, before preact is imported, which is why the imports below are
 * dynamic. Their value here is correctness of description and readiness for the first test that
 * does use an effect, not a defence this file leans on.
 *
 * WHAT THIS FILE ACTUALLY RESTS ON is the round trip. The console fetches NOTHING on mount: it
 * answers a submitted question, so nothing exists to assert until a form that only exists after
 * render has been driven and an answer has come back through `api.ts` and `shapes.ts`. MEASURED on
 * 2026-08-11: dropping the submit dispatch out of `ask`, which is the whole of what a dead island
 * does, reddens 38 OF 38 by name. Every test here depends on a completed round trip. Removing the
 * `cancelAnimationFrame` install still reddens 0 OF 38, re-measured in the same run.
 *
 * BOTH NUMBERS HAVE NOW BEEN WRITTEN AT FIVE SIZES, at 8 tests, at 12, at 17, at 31 and at 38, and
 * NOT every one of those was a measurement of the tree it was published on. A number written once
 * and left alone is exactly what the sibling file records being wrong about four times, and this
 * file has now been wrong twice. The 17 stood while thirteen tests were added under it. The 31 was
 * true of the PARENT tree and was published by a commit that took the file to 33 in the same diff,
 * so it was false the moment it was typed, and it survived the merge because nothing independent
 * read that commit. A REVIEW caught both, rather than this file's own GIVEAWAY rule, which is the
 * argument for measuring in the same run that adds the tests rather than trusting anyone to
 * remember.
 *
 * THE GIVEAWAY FOR ANY TEST ADDED HERE is one whose expected values a dead page also produces: an
 * absence, an unlit class, or the untouched "No strips on this board yet". Give it a post-answer
 * anchor, then re-measure BOTH mutations and correct both numbers.
 *
 * WHAT IS STUBBED IS `fetch` AND TWO DOM APIS linkedom does not implement, and nothing else. The
 * island's own client (`scripts/api.ts`), its response guard (`scripts/shapes.ts`) and the
 * contradiction guard (`scripts/recall-state.ts`) all run for real, so a body the guard refuses is
 * refused here exactly as it would be in a browser.
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

/**
 * linkedom implements no scrolling, and `Console.tsx` scrolls the log after every answer.
 *
 * A MISSING BROWSER API RATHER THAN A FIX TO THE CODE UNDER TEST, the same standing as the frame
 * scheduler above. The call is optional-chained on the REF and not on the method, so without this
 * the handler throws after its state updates land: the board would render correctly and the test
 * would fail on an unhandled rejection, which reads as a defect in the island rather than a gap in
 * the environment.
 */
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;

let requested: string[] = [];
let answer: (url: string) => Promise<Response> = () =>
  Promise.reject(new Error('a test drove the console without installing an answer'));
let answerInstalled = false;
let callsWithNoFixture = 0;

globals.fetch = (input: unknown, init?: { readonly signal?: AbortSignal }): Promise<Response> => {
  const url = String(input);
  requested.push(url);
  if (!answerInstalled) callsWithNoFixture += 1;
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    answer(url).then(resolve, reject);
  });
};

// AFTER the globals, deliberately. A static import is hoisted above every statement in the file.
const { createElement, render } = await import('preact');
const { default: Console } = await import('../src/islands/Console.tsx');

const answers = (body: unknown, status = 200): void => {
  answerInstalled = true;
  answer = () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: JSON_HEADERS }));
};

const asElement = (value: unknown): HTMLElement => value as HTMLElement;

const mounted: HTMLElement[] = [];

function mount(): HTMLElement {
  const container = asElement(dom.document.createElement('div'));
  dom.document.body.appendChild(container);
  render(createElement(Console, { apiBase: API_BASE }), container);
  mounted.push(container);
  return container;
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Drain preact's render queue, its effect flush and the stubbed fetch. See the sibling file. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await tick(0);
  await tick(40);
  for (let turn = 0; turn < 4; turn += 1) await tick(0);
}

/**
 * Ask the console a question the way a visitor does, through the form it renders.
 *
 * TYPED AND SUBMITTED RATHER THAN CALLED. The handler reads the draft out of component state, and
 * state only holds a draft if the controlled input's `onInput` ran, so this drives the same path a
 * person does. A test that reached into the component would prove less than the empty board does.
 */
async function ask(container: HTMLElement, question: string): Promise<void> {
  const field = asElement(container.querySelector('#say')) as unknown as { value: string } & HTMLElement;
  field.value = question;
  field.dispatchEvent(new dom.Event('input'));
  await settle();
  asElement(container.querySelector('form.composer')).dispatchEvent(new dom.Event('submit'));
  await settle();
}

afterEach(() => {
  const missed = callsWithNoFixture;
  const toUnmount = [...mounted];
  callsWithNoFixture = 0;
  mounted.length = 0;
  requested = [];
  answerInstalled = false;
  answer = () => Promise.reject(new Error('a test drove the console without installing an answer'));

  for (const container of toUnmount) {
    render(null, container);
    container.remove();
  }

  expect(missed, 'this test drove the console without installing a fixture').toBe(0);
});

/**
 * Every word in one pane, whitespace collapsed, where a missing pane is a FAILURE.
 *
 * NO FALSY SENTINEL, and this was written with one. `(node.textContent ?? '')` is the shape the
 * sibling island file has now been corrected for four times: an empty string makes every
 * `.not.toContain` against it pass on a page that rendered nothing. It was inert here only because
 * `querySelector` returning null throws first, which is an accident of these two selectors rather
 * than a property of the helper, and the fourth instance next door was introduced the same way.
 */
function paneWords(container: HTMLElement, selector: string): string {
  const pane = container.querySelector(selector);
  if (pane === null) throw new Error(`this page has no ${selector} pane to read`);
  const text = pane.textContent;
  if (text === null) throw new Error(`the ${selector} pane carries no text to read`);
  return text.replace(/\s+/gu, ' ').trim();
}

/** The board pane, which is where the strips and the refusal slips are racked. */
const boardWords = (container: HTMLElement): string => paneWords(container, '.rack.live');

/** The R/T log, which is where the receipt's numbers and the turn's verdict are printed. */
const logWords = (container: HTMLElement): string => paneWords(container, '.log');

/** How many memory strips the rack drew. `.strip.posted` is a recalled memory or a write attempt. */
const strips = (container: HTMLElement): number => container.querySelectorAll('.rack.live .strip').length;

/**
 * The words inside a labelled cell's span, which are not the words the PANE reads.
 *
 * JSX EATS THE WHITESPACE between a `<b>` label and the `<span>` beside it, so the pane reads
 * `Content(no content supplied)` with no gap, and an assertion written the way a person would say it
 * fails against a page rendering perfectly. The slip fields are unaffected because each keeps its
 * value on the SAME LINE as the label or carries an explicit `{' '}`, which a review had to correct
 * here: the first version credited the `{' '}` alone, and only the four fields this change touched
 * have one. The strip cells have neither. Reading the span keeps each assertion about the VALUE, and
 * scoping it to the label stops a substitute that two cells share from vouching for the wrong one.
 * A missing cell and a missing span both throw, for the reason `paneWords` throws: a helper that
 * returns `''` turns every assertion built on it into one that cannot fail.
 */
function cellWords(container: HTMLElement, label: string): string {
  for (const one of container.querySelectorAll('.cell')) {
    const name = (one.querySelector('b')?.textContent ?? '').replace(/\s+/gu, ' ').trim();
    if (name !== label) continue;
    const span = one.querySelector('span');
    if (span === null) throw new Error(`the cell labelled ${label} has no span to read`);
    return (span.textContent ?? '').replace(/\s+/gu, ' ').trim();
  }
  throw new Error(`no cell is labelled ${label}`);
}

/**
 * The class on a labelled cell's span, which on this design is a claim and not decoration.
 *
 * THIS FILE HAD NO WAY TO READ A CLASS AND THE GAP WAS MEASURED: a review counted zero occurrences
 * of the word `doubt` in this file while the console had just been given a `val doubt` arm on its
 * Incident cell, so that arm shipped pinned by nothing and reverting it reddened no test. The
 * archive's twin file HAS one, which is why the same guard is pinned there and was not pinned here.
 *
 * `hasAttribute` RATHER THAN A NULL CHECK, for the reason `verdictClasses` gives: linkedom returns
 * `''` from `getAttribute('class')` for an attribute that is absent, so a span with no class at all
 * would otherwise satisfy every assertion written against an empty one.
 */
function cellClass(container: HTMLElement, label: string): string {
  for (const one of container.querySelectorAll('.cell')) {
    const name = (one.querySelector('b')?.textContent ?? '').replace(/\s+/gu, ' ').trim();
    if (name !== label) continue;
    const span = one.querySelector('span');
    if (span === null) throw new Error(`the cell labelled ${label} has no span to read`);
    if (!span.hasAttribute('class')) throw new Error(`the cell labelled ${label} carries no class attribute`);
    return (span.getAttribute('class') ?? '').replace(/\s+/gu, ' ').trim();
  }
  throw new Error(`no cell is labelled ${label}`);
}

/**
 * The class on every verdict chip in the log, which is where a reader takes the claim from.
 *
 * `hasAttribute` RATHER THAN A NULL CHECK. linkedom returns `''` from `getAttribute('class')` for an
 * attribute that is absent, where the DOM specifies null, so an unlit chip and a chip with no class
 * at all read identically and every assertion about a class silently accepts both.
 */
function verdictClasses(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.log .verdict')].map((one) => {
    if (!one.hasAttribute('class')) throw new Error('a verdict chip carries no class attribute');
    return one.getAttribute('class') ?? '';
  });
}

/**
 * The class on the TURN COVERAGE chip alone.
 *
 * NOT "no chip in the log is green", which is what this started as and was wrong: a turn can carry
 * a refused receipt beside a perfectly good one, and that good one's chip is entitled to its own
 * COVERED class. The claim under test is about the TURN's chip, so the assertion has to be too.
 */
function turnChipClass(container: HTMLElement): string {
  const chip = turnChip(container);
  if (!chip.hasAttribute('class')) throw new Error('the TURN COVERAGE chip carries no class attribute');
  return chip.getAttribute('class') ?? '';
}

/**
 * The WHOLE sentence on the TURN COVERAGE chip.
 *
 * BECAUSE A NEGATIVE GUARDED IT AND THE NEGATIVE WENT DEAD. The chip's trailing clause has now been
 * rewritten twice, and the assertion watching it forbade the PREVIOUS wording: the same commit that
 * replaced `A REFUSED RECEIPT FED IT` left a `.not.toContain` for that exact string, which no
 * production path can emit any more, while the clause that replaced it was asserted nowhere at all.
 * A third rewrite would have passed unread. Pinned whole, so any rewrite fails until somebody reads
 * it and decides it is true.
 */
function turnChipText(container: HTMLElement): string {
  return (turnChip(container).textContent ?? '').replace(/\s+/gu, ' ').trim();
}

/** The one chip the turn's own verdict is printed on. Throws rather than returning nothing. */
function turnChip(container: HTMLElement): Element {
  const chip = [...container.querySelectorAll('.log .verdict')].find((one) =>
    (one.textContent ?? '').includes('TURN COVERAGE'),
  );
  if (chip === undefined) throw new Error('the log has no TURN COVERAGE chip');
  return chip;
}

/**
 * The LAST paragraph of the board's refusal slip, which is the sentence the page wrote.
 *
 * ASSERTED WHOLE for the reason the archive file's `slipClosing` gives: a negative guards a wording
 * and not a claim, and the claim on these slips has been rewritten three times. A review pointed
 * out that the commit which applied that rule to the archive rewrote three console paragraphs and
 * pinned none of them. Throws rather than returning an empty string, so no assertion against it can
 * pass on a page that drew no slip.
 */
function slipClosing(container: HTMLElement): string {
  // EXACTLY ONE SLIP, asserted rather than assumed. This board can rack several at once, and a
  // "last paragraph" read across two of them would silently be a different slip's sentence.
  const slips = [...container.querySelectorAll('.rack.live .slip')];
  if (slips.length !== 1) throw new Error(`this board has ${slips.length} slips, so "the" slip is ambiguous`);
  const paragraphs = [...(slips[0]?.querySelectorAll('p') ?? [])];
  const last = paragraphs.at(-1);
  if (last === undefined) throw new Error('the slip has no paragraph to read a closing sentence from');
  return (last.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

const memory = (id: string, overrides: Partial<RecalledMemoryView> = {}): RecalledMemoryView => ({
  id,
  kind: 'observation',
  content: `the checkout pods were evicted at 02:1${id}`,
  similarity: 0.81,
  score: 0.74,
  freshness: 0.6,
  stale: false,
  ageDays: 3,
  halfLifeDays: 30,
  confirmations: 2,
  contradictions: 0,
  assertedBy: 'human:oncall-ana',
  incidentId: 'INC-42',
  supersededBy: null,
  ...overrides,
});

/** A receipt that agrees with the rack it is given, unless a test overrides a field to break it. */
const receipt = (returned: number, overrides: Partial<RecallReceiptView> = {}): RecallReceiptView => ({
  query: 'checkout latency',
  coverage: 'COVERED',
  coverageReason: 'The search compared every live row in the workspace, 12 of them.',
  coverageCause: null,
  retrievalPath: 'ann_index',
  candidatesConsidered: 12,
  returned,
  exclusions: [],
  degradations: [],
  elapsedMs: 7,
  ...overrides,
});

const recall = (
  memoryCount: number,
  overrides: Partial<RecallReceiptView> = {},
  rowOverrides: Partial<RecalledMemoryView> = {},
): RecallEventView => ({
  callId: 'recall-1',
  receipt: receipt(memoryCount, overrides),
  memories: Array.from({ length: memoryCount }, (_unused, index) => memory(String(index), rowOverrides)),
});

const turn = (recalls: readonly RecallEventView[]): AgentTurnResponse => ({
  text: 'We have seen this before.',
  coverage: 'COVERED',
  refusedAnAbsenceClaim: false,
  toolCallCount: 1,
  modelId: 'local-deterministic',
  transcript: [],
  recalls,
  budget: { used: 1, limit: 50, day: '2026-08-09' },
});

/**
 * A turn whose WRITE arguments and whose tool answer are all whitespace.
 *
 * A FACTORY AND NOT A CONSTANT, for the reason this file's own afterEach exists: a module level
 * object is shared, so the first test to touch it decides what the second one sees. `kind` is
 * supplied deliberately, so the only cell reading "not supplied" is the one under test.
 */
const blankWriteTurn = (): AgentTurnResponse => ({
  ...turn([]),
  transcript: [
    {
      role: 'tool_call',
      id: 'w1',
      given: 'w1',
      name: 'remember',
      args: { content: '   ', assertedBy: '  ', kind: 'observation' },
    },
    { role: 'tool_result', id: 'w1', name: 'remember', content: '   ' },
  ],
});

/**
 * A write attempt whose KIND is blank while its other arguments are good.
 *
 * SEPARATE FROM `blankWriteTurn` ON PURPOSE. That one supplies a real kind so the only cell reading
 * "not supplied" is the one it tests. This one blanks the kind alone, so a fix that folded blank
 * into null everywhere and a fix that missed `kind` cannot both pass.
 */
const blankKindWriteTurn = (): AgentTurnResponse => ({
  ...turn([]),
  transcript: [
    {
      role: 'tool_call',
      id: 'w2',
      given: 'w2',
      name: 'remember',
      args: { content: 'the pods were evicted', assertedBy: 'human:ana', kind: '   ' },
    },
    { role: 'tool_result', id: 'w2', name: 'remember', content: 'stored' },
  ],
});

/**
 * A turn that asked for a recall with a blank query, got a blank answer, and no receipt at all.
 *
 * `recalls` stays empty on purpose: `failedRecalls` keys off a `tool_call` id that never comes back,
 * which is the only route to the slip these two tests read.
 */
const blankRecallTurn = (): AgentTurnResponse => ({
  ...turn([]),
  transcript: [
    { role: 'tool_call', id: 'r1', given: 'r1', name: 'recall', args: { query: '   ' } },
    { role: 'tool_result', id: 'r1', name: 'recall', content: '  ' },
  ],
});

describe('the console island, hydrated', () => {
  it('posts nothing before a question and racks a strip after one', async () => {
    // THE ANCHOR THIS FILE RESTS ON. The console fetches nothing on mount, so the empty board is
    // also what a DEAD island renders. Asserting the transition is what makes the difference
    // observable: if hydration ever stops, the second half fails by name instead of every other
    // test in this file silently passing against markup nobody hydrated.
    answers(turn([recall(1)]));
    const container = mount();

    expect(boardWords(container)).toContain('No strips on this board yet');
    expect(requested).toEqual([]);

    await ask(container, 'have we seen this checkout latency before');

    expect(requested).toEqual([`${API_BASE}/agent/turn`]);
    expect(boardWords(container)).not.toContain('No strips on this board yet');
    expect(strips(container)).toBe(1);
  });

  it('prints the receipt numbers in the log beside the strips they describe', async () => {
    answers(turn([recall(2)]));
    const container = await mountAndAsk('anything');

    expect(strips(container)).toBe(2);
    expect(logWords(container)).toContain('12 EXAMINED');
    expect(logWords(container)).toContain('2 RETURNED');
    expect(logWords(container)).toContain('COVERED');
  });

  it('refuses a recall whose count argues with the strips beside it', async () => {
    // THE DEFECT THIS UNIT CLOSES. The log printed `receipt.returned` while the board racked
    // `event.memories`, and nothing compared them, so a body claiming nine could rack one.
    answers(turn([{ callId: 'recall-1', receipt: receipt(9), memories: [memory('0')] }]));
    const container = await mountAndAsk('anything');

    expect(strips(container)).toBe(0);
    expect(boardWords(container)).toContain('RECEIPT REFUSED');
    expect(boardWords(container)).toContain('it counts 9 memories, and 1 memory arrived with it');
    expect(boardWords(container)).toContain('Nothing here says the memory is empty');
    // THIS one really does disagree with what arrived, so the rack wording is the true one here.
    expect(boardWords(container)).toContain('disagrees with what arrived with it');
    expect(logWords(container)).toContain('IT DISAGREES WITH WHAT ARRIVED');
  });

  it('does not blame the count on the rack rule whose count agrees exactly', async () => {
    // THE SECOND RACK RULE, AND THE CHIP USED TO NAME THE ONE THING THAT WAS FINE ABOUT IT. An
    // UNKNOWN verdict over memories that arrived is reached only after the count rule has passed, so
    // `returned` matches the rack exactly and what disagrees is the verdict. The chip read ITS COUNT
    // DISAGREES WITH THE STRIPS over a receipt whose count did not.
    answers(turn([recall(2, { coverage: 'UNKNOWN' })]));
    const container = await mountAndAsk('anything');

    // The positive is the whole guard. A `not.toContain('it says the search did not run')` stood
    // here and was vacuous the moment it was written, because the same commit removed that phrase
    // from production: a negative watching a string its own change had deleted, which is the exact
    // pattern this branch corrected twice elsewhere.
    expect(boardWords(container)).toContain('it reports no usable result, and 2 memories arrived with it');
    expect(logWords(container)).toContain('IT DISAGREES WITH WHAT ARRIVED');
  });

  it('prints none of a refused receipt numbers in the log either', async () => {
    // The log is where those numbers are most likely to be read as measurements, so taking them
    // off the board and leaving them here would put the contradiction straight back on screen.
    answers(turn([{ callId: 'recall-1', receipt: receipt(9), memories: [memory('0')] }]));
    const container = await mountAndAsk('anything');

    expect(logWords(container)).toContain('RECEIPT REFUSED');
    expect(logWords(container)).not.toContain('9 RETURNED');
    expect(logWords(container)).not.toContain('12 EXAMINED');
  });

  it('withholds the turn verdict when a refused receipt is what fed it', async () => {
    // THE SIBLING THIS UNIT'S OWN FIX OPENED, found by review. Taking the receipt's NUMBERS off the
    // log left the TURN COVERAGE chip two lines below, and that chip is not independent of them:
    // `loop.ts` folds each recall's own coverage into `worstCoverage` with `worseOf` and `server.ts`
    // ships it, so for a one recall turn it IS the refused receipt's word. The board called the
    // receipt unbelievable and the log printed COVERED underneath in the green class, which is the
    // verdict that licenses an absence claim.
    answers(turn([{ callId: 'recall-1', receipt: receipt(9), memories: [memory('0')] }]));
    const container = await mountAndAsk('anything');

    // THE AUDIT TRAIL SURVIVES, and the first version of this fix destroyed it. COVERED is the only
    // verdict `judgeAnswer` accepts as licence for an absence claim, so a turn that reported it
    // while carrying an unreadable receipt is precisely the turn a sceptic needs to see. Hiding the
    // word traded an overclaim for a silence, which a review caught.
    expect(logWords(container)).toContain('REPORTED COVERED, NOT USABLE');
    // AND IT IS NOT DRESSED AS A VERDICT. The class is where a reader takes the claim from, so that
    // is what this asserts. Nothing in the log may carry the COVERED class on this turn.
    expect(turnChipClass(container)).toBe('verdict v-unk');
    // On THIS turn every chip is unlit, because the only recall in it was refused.
    expect(verdictClasses(container)).not.toContain('verdict v-cov');
    // AND THE WHOLE SENTENCE, because the clause that says what this board can see is the half that
    // was wrong last time: it claimed HOW the API computed the value, on a body it had just called
    // foreign. The negative that stood here forbade that dead wording and watched nothing.
    expect(turnChipText(container)).toBe(
      'TURN COVERAGE · REPORTED COVERED, NOT USABLE: A SEARCH IN THIS TURN HAS NO RECEIPT THIS ' +
        'BOARD COULD READ',
    );
  });

  it('still prints an UNKNOWN turn verdict beside a refused receipt', async () => {
    // THE DIRECTION THAT MUST NOT BE SUPPRESSED. `worseOf` takes the WORST of the turn's recalls, so
    // UNKNOWN is the one verdict a refused input cannot have flattered, and it is the verdict this
    // product exists to show. Hiding it would trade one overclaim for a silence.
    answers({
      ...turn([{ callId: 'recall-1', receipt: receipt(9), memories: [memory('0')] }]),
      coverage: 'UNKNOWN',
    });
    const container = await mountAndAsk('anything');

    expect(logWords(container)).toContain('TURN COVERAGE');
    expect(logWords(container)).toContain('UNKNOWN');
    expect(logWords(container)).not.toContain('NOT USABLE');
  });

  it('marks the turn verdict unusable when a search in it produced no receipt at all', async () => {
    // THE SIBLING THE FIRST SUPPRESSION MISSED. A recall whose arguments failed the schema, or that
    // arrived after the tool budget was spent, never produces a receipt and never reaches `worseOf`,
    // so it is excluded from the turn's verdict entirely. The board racks a slip saying that search
    // did not complete while the log printed a green COVERED two panes away. The justification
    // written for the refused case said there is no way from here to tell, and for this case there
    // is: `failedRecalls` derives it by call id and the board already draws it.
    answers({
      ...turn([recall(1)]),
      transcript: [
        { role: 'tool_call', id: 'recall-2', given: 'recall-2', name: 'recall', args: { query: 'a second look' } },
      ],
    });
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('NO RECEIPT. THIS SEARCH DID NOT COMPLETE.');
    expect(logWords(container)).toContain('REPORTED COVERED, NOT USABLE');
    // THE TURN CHIP ALONE. The other recall in this turn came back clean, and its own chip is
    // entitled to say COVERED in the COVERED class. Asserting no green chip anywhere would have
    // pinned that legitimate one as a defect, which is how a guard starts refusing real answers.
    expect(turnChipClass(container)).toBe('verdict v-unk');
  });

  it('refuses a field that is not a measurement without claiming two fields disagreed', async () => {
    // THE THIRD KIND. Rules 0, 1 and 2 test ONE field and compare nothing, and they were labelled
    // as an internal disagreement, so a receipt reporting minus one memory was refused with the
    // words "its own fields disagree" over a receipt whose fields agreed. This lands on the one
    // refusal the guard can reach on a conforming answer: the negative duration a clock stepped
    // backwards produces.
    answers(turn([{ callId: 'recall-1', receipt: receipt(-1), memories: [] }]));
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('a receipt carrying a value that is not a measurement');
    expect(boardWords(container)).toContain('it reports -1 returned');
    expect(boardWords(container)).not.toContain('whose own fields disagree');
    expect(logWords(container)).toContain('A FIELD IS NOT A MEASUREMENT');
    expect(logWords(container)).not.toContain('ITS OWN FIELDS DISAGREE');
  });

  it('pins the refusal slip closing sentence whole', async () => {
    // A NEGATIVE GUARDS A WORDING AND NOT A CLAIM, which is why the archive file asserts its slip
    // paragraphs whole. The commit that applied that rule there rewrote three paragraphs here and
    // pinned none, so any rewrite of this one would pass unread.
    answers(turn([{ callId: 'recall-1', receipt: receipt(9), memories: [memory('0')] }]));
    const container = await mountAndAsk('anything');

    expect(slipClosing(container)).toBe(
      'Nothing here says the memory is empty. A receipt that cannot be read as one consistent ' +
        'statement gives no reason to believe any part of it, so this board prints none of its ' +
        'measurements rather than choosing the comfortable ones.',
    );
  });

  it('separates a search that never ran from one that ran and did not finish', async () => {
    // THE ARM THE PREVIOUS ROUND ADDED AND DID NOT TEST. Today's producer always sends a path of
    // `none` with nothing examined, so this receipt is foreign, which is the same threat model the
    // whole guard is written against. It must NOT be refused: an UNKNOWN is the verdict this
    // product exists to show, and the guard deliberately leaves this one alone.
    answers(
      turn([
        recall(0, {
          coverage: 'UNKNOWN',
          coverageCause: 'scoring_failed',
          retrievalPath: 'ann_index',
          candidatesConsidered: 12,
          coverageReason: 'a candidate could not be scored',
        }),
      ]),
    );
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('THE SEARCH DID NOT COMPLETE. VERDICT: UNKNOWN.');
    expect(boardWords(container)).not.toContain('NO SEARCH RAN');
    expect(boardWords(container)).not.toContain('RECEIPT REFUSED');
    // Asserted whole, and worded from what the receipt shows rather than from what it implies: a
    // path is NAMED before anything executes, so "the search started" was more than the fields say.
    expect(slipClosing(container)).toBe(
      'Nothing here says the archive is empty. This search reports a path or candidates examined ' +
        'and still produced no usable result, so this question has no answer on this board.',
    );
  });

  it('racks a shown PARTIAL as cut short rather than refusing it', async () => {
    // The one arm of the restructured verdict ternary that no test rendered. A PARTIAL that really
    // did examine candidates is a legitimate answer and has to survive the guard intact.
    answers(turn([recall(2, { coverage: 'PARTIAL', candidatesConsidered: 200 })]));
    const container = await mountAndAsk('anything');

    expect(strips(container)).toBe(2);
    expect(boardWords(container)).toContain('SEARCH CUT SHORT. VERDICT: PARTIAL.');
    expect(boardWords(container)).not.toContain('RECEIPT REFUSED');
    expect(slipClosing(container)).toBe(
      'What is here is real but incomplete. Some of the workspace was never examined.',
    );
  });

  it('says which two things disagreed rather than always blaming the strips', async () => {
    // PARTIAL over nothing examined racks NOTHING beside it, so a slip saying its numbers argue
    // with what arrived describes a comparison that never happened. Two of the nine rules read the
    // rack; the other seven compare the receipt against itself, and two of those compare two
    // strings with no number in them at all.
    answers(turn([recall(0, { coverage: 'PARTIAL', candidatesConsidered: 0 })]));
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('a receipt whose own fields disagree');
    expect(boardWords(container)).not.toContain('disagrees with what arrived with it');
    expect(logWords(container)).toContain('ITS OWN FIELDS DISAGREE');
    expect(logWords(container)).not.toContain('IT DISAGREES WITH WHAT ARRIVED');
  });

  it('leaves the verbatim receipt record unfiltered, on purpose', async () => {
    // THE ONE PLACE A REFUSED RECEIPT'S NUMBERS STILL APPEAR, and it is deliberate. That bay prints
    // what the MODEL was shown, verbatim, inside a collapsed record: it is evidence of what the
    // agent read rather than a measurement this board is making, and filtering it would hide the
    // thing a reader checks the agent against. Pinned so the exemption is a decision on the record
    // rather than an oversight nothing noticed.
    answers({
      ...turn([{ callId: 'recall-1', receipt: receipt(9), memories: [memory('0')] }]),
      transcript: [
        {
          role: 'tool_result',
          id: 'recall-1',
          name: 'recall',
          content: 'The search ran over 12 candidate memories by the approximate index and returned 9.',
        },
      ],
    });
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('What the agent was shown');
    expect(boardWords(container)).toContain('returned 9');
    // The log still withholds them, which is the half this unit changed.
    expect(logWords(container)).not.toContain('9 RETURNED');
  });

  it('never calls a refused receipt a real absence', async () => {
    // THE SIBLING THAT MATTERS MOST. An empty board prints "Every search this session completed and
    // matched nothing. Under a COVERED verdict that is a real absence", which is this page's most
    // confident sentence. A refused receipt left out of the strip count would sit under it.
    answers(turn([{ callId: 'recall-1', receipt: receipt(9), memories: [memory('0')] }]));
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).not.toContain('that is a real absence');
    expect(boardWords(container)).not.toContain('No strips on this board yet');
  });

  it('still calls a genuine empty result a real absence', async () => {
    // THE OTHER DIRECTION, and the case the guard must NOT refuse. Twelve candidates examined and
    // none returned is what `scoreCandidates` produces when every row is excluded, and the page is
    // entitled to its absence sentence there. A guard that refused this would trade one false
    // sentence for a different one.
    answers(turn([recall(0)]));
    const container = await mountAndAsk('anything');

    expect(strips(container)).toBe(0);
    expect(boardWords(container)).toContain('that is a real absence');
    expect(boardWords(container)).not.toContain('RECEIPT REFUSED');
  });

  it('refuses PARTIAL reported over nothing examined', async () => {
    // The print side of the unclamped candidate cap `runRecall` was fixed for in the same change.
    answers(turn([recall(0, { coverage: 'PARTIAL', candidatesConsidered: 0 })]));
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('RECEIPT REFUSED');
    expect(boardWords(container)).toContain('no candidate was examined at all');
    expect(boardWords(container)).not.toContain('SEARCH CUT SHORT');
  });

  it('racks an UNKNOWN recall as a refusal slip rather than as an empty result', async () => {
    // The verdict this product exists to show, and it must survive the new guard untouched.
    answers(
      turn([
        recall(0, {
          coverage: 'UNKNOWN',
          coverageCause: 'embedder_failed',
          retrievalPath: 'none',
          candidatesConsidered: 0,
          coverageReason: 'the embedding provider failed',
        }),
      ]),
    );
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('NO SEARCH RAN');
    expect(boardWords(container)).toContain('the embedding provider did not answer');
    expect(boardWords(container)).not.toContain('RECEIPT REFUSED');
    expect(boardWords(container)).not.toContain('that is a real absence');
  });
});

/**
 * The blank printed string, on every surface of this page that prints one.
 *
 * THE SHAPE IS THE DATE DEFECT'S, ONE FIELD OVER. `shapes.ts` checks `query` and `retrievalPath` as
 * bare strings, deliberately and for the reason written there, so `'   '` passes every guard between
 * the wire and a cell. `coverageCause` is `nullOr(isString)`, which this file said was a bare string
 * until a review read the map. A cell labelled QUERY with nothing after it does not read as a
 * missing value to anybody: it reads as a page that failed to render.
 *
 * THE SITES WERE ENUMERATED BY MECHANISM rather than by grepping for the three the previous
 * session's handoff named. Two mechanisms reach a cell here: a wire string printed raw, and a
 * `typeof` test in `writeAttempts` or `failedRecalls` that a blank string satisfies. The second was
 * invisible to any search for the first, and it is where the mechanism B tests below land.
 *
 * NOT ONE TEST PER SITE, which is what this paragraph claimed until it was counted: the write
 * attempt test asserts two cells at once, so the block is nine tests over ten sites. The number
 * that matters is the plant, and every site has its own.
 *
 * WHY THE ASSERTIONS ARE POSITIVE. A `not.toContain('')` is vacuous against every page, including
 * one that rendered nothing at all, which is the trap this file's own helper docblock records. Each
 * test names the substitute it expects, so a plant that removes the substitute reddens THIS test by
 * name rather than reddening the whole file.
 */
describe('a blank string arriving where the console prints one', () => {
  it('says the receipt recorded no query rather than printing an empty QUERY cell', async () => {
    answers(turn([recall(1, { coverage: 'PARTIAL', query: '   ' })]));
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('QUERY none recorded, so this slip cannot say what was searched for');
  });

  it('says the receipt named no path rather than printing an empty PATH cell', async () => {
    // THE CAST IS THE EVIDENCE, NOT A CONVENIENCE. `RetrievalPath` is a closed union in the
    // contract while `shapes.ts` checks the field with `isString`, so a blank one cannot be
    // WRITTEN here without a cast and arrives at runtime without one. The disagreement between the
    // declared type and the runtime guard is the whole reason this value reached a cell unnoticed.
    answers(turn([recall(1, { coverage: 'PARTIAL', retrievalPath: '  ' as RetrievalPath })]));
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('PATH a path this receipt did not name');
  });

  it('does not borrow "not recorded" for a cause that arrived and named no stage', async () => {
    // A BLANK CAUSE IS NOT A MISSING ONE. `coverageCause` is `nullOr(isString)`, so null already
    // prints "not recorded"; a whitespace cause is non-null, took the other arm, and printed
    // nothing at all through a fallback written to stop exactly that.
    answers(turn([recall(0, { coverage: 'UNKNOWN', coverageCause: '   ' as CoverageCause })]));
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('STOPPED BY a stage this receipt did not name');
    expect(boardWords(container)).not.toContain('STOPPED BY not recorded');
  });

  it('names the missing path on the verdict chip too, not only on the slip', async () => {
    // THE SIBLING SITE, IN A DIFFERENT COMPONENT. `UnknownSlip` and `TurnVerdicts` read the same
    // field through the same fallback, and a COVERED receipt draws no slip at all, so the chip is
    // the only place this value reaches a reader on this path.
    answers(turn([recall(1, { retrievalPath: '   ' as RetrievalPath })]));
    const container = await mountAndAsk('anything');

    expect(logWords(container)).toContain('A PATH THIS RECEIPT DID NOT NAME');
  });

  it('says a refused receipt records no query rather than labelling an empty cell', async () => {
    answers(turn([{ callId: 'recall-1', receipt: receipt(9, { query: '  ' }), memories: [memory('0')] }]));
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('QUERY THE RECEIPT CLAIMS none, this receipt records no query');
  });

  it('reads a blank write argument as no argument at all', async () => {
    answers(blankWriteTurn());
    const container = await mountAndAsk('anything');

    // READ PER CELL, NOT OFF THE PANE. A bare `toContain('not supplied')` would also pass off the
    // Kind cell, which prints those two words for a null kind, so it would hold on a page where the
    // field under test rendered nothing at all.
    expect(cellWords(container, 'Content')).toBe('(no content supplied)');
    expect(cellWords(container, 'Asserted by')).toBe('not supplied');
  });

  it('does not say the turn ended early when the tool answered with nothing', async () => {
    // THE ONE FIELD WHOSE TWO ABSENCES ARE DIFFERENT FACTS. No `tool_result` means the turn ended
    // first. A blank one means the tool ANSWERED and said nothing, and reporting the first over the
    // second is this board describing a sequence of events that did not happen.
    answers(blankWriteTurn());
    const container = await mountAndAsk('anything');

    expect(cellWords(container, 'What the tool answered')).toBe('This tool answered with nothing at all.');
    expect(boardWords(container)).not.toContain('The turn ended before this tool answered.');
  });

  it('reads a blank recall argument as no query recorded', async () => {
    answers(blankRecallTurn());
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('QUERY (no query recorded)');
  });

  it('does not say the turn ended early when the search answered with nothing', async () => {
    answers(blankRecallTurn());
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('This search answered with nothing at all.');
    expect(boardWords(container)).not.toContain('The turn ended before this search answered.');
  });

  it('folds a blank write kind into the null the cell already has words for', async () => {
    // THE SITE THIS BLOCK MISSED ON ITS FIRST PASS, found by two reviewers independently. `kind`
    // kept a bare `typeof` test, so `'   '` was non-null, the label lookup missed it and the Kind
    // cell printed nothing, under a comment claiming the sweep was complete.
    answers(blankKindWriteTurn());
    const container = await mountAndAsk('anything');

    expect(cellWords(container, 'Kind')).toBe('not supplied');
  });

  it('gives a blank recalled incident the words a missing one already had', async () => {
    // THE CLASS SHIPPED PINNED BY NOTHING, and the words disagreed with the archive's. Both halves
    // are asserted here now: reverting the `val doubt` arm reddens this test, and so does changing
    // the substitute back to a wording the twin cell does not use. The archive's twin test is
    // "gives a blank incident the words and the class a missing one already had".
    answers(turn([recall(1, {}, { incidentId: '   ' })]));
    const container = await mountAndAsk('anything');

    expect(cellWords(container, 'Incident')).toBe('none recorded');
    expect(cellClass(container, 'Incident')).toBe('val doubt');
  });

  it('leaves a recalled incident that names one in the confident class', async () => {
    // THE POSITIVE CONTROL FOR THE TEST ABOVE, named rather than placed: a widening that doubted
    // every Incident cell would leave that one green while reddening this one.
    answers(turn([recall(1, {}, { incidentId: 'INC-42' })]));
    const container = await mountAndAsk('anything');

    expect(cellWords(container, 'Incident')).toBe('INC-42');
    expect(cellClass(container, 'Incident')).toBe('val');
  });

  it('gives a blank recalled kind a word rather than an empty cell on both boards', async () => {
    // `cells.tsx` IS IMPORTED BY BOTH BOARDS, so this one blank emptied a cell on the console rack
    // and on the archive rack at once. The archive half is pinned in `archive-island.test.ts`.
    answers(turn([recall(1, {}, { kind: '  ' as MemoryKind })]));
    const container = await mountAndAsk('anything');

    expect(cellWords(container, 'Kind')).toBe('a kind this row did not name');
  });

  it('still racks a recalled memory whose body arrived blank rather than dropping the strip', async () => {
    // THE DECISION, PINNED SEPARATELY FROM THE WORDING, and it is a regression guard rather than a
    // proof of the change beside it: this board has never dropped a strip, so this was green before
    // the substitute existed. It is here because dropping the strip is the repair that looks
    // tidiest and is provably wrong. `readRecall` is handed the number of memories the board is
    // about to rack and refuses the receipt when it disagrees with `receipt.returned`, so a board
    // that dropped this one would refuse a receipt that was telling the truth.
    answers(turn([recall(1, {}, { content: '   ' })]));
    const container = await mountAndAsk('anything');

    expect(strips(container)).toBe(1);
    expect(boardWords(container)).not.toContain('RECEIPT REFUSED');
  });

  it('says a recalled memory arrived with no content rather than printing an empty cell', async () => {
    // `RECALLED_MEMORY_CHECKS.content` is a bare `isString`, on purpose, so whitespace reaches this
    // cell. It is one of the last two received strings on this strip that printed raw, and the
    // archive strip prints the identical substitute for the identical field.
    answers(turn([recall(1, {}, { content: '   ' })]));
    const container = await mountAndAsk('anything');

    expect(cellWords(container, 'Content')).toBe('This memory arrived with no content.');
    expect(cellClass(container, 'Content')).toBe('say doubt');
  });

  it('marks a recalled memory that names nobody as asserting it', async () => {
    // The other half, and it failed in the more dangerous direction: this cell had no conditional
    // class at all, so a blank provenance printed nothing in the confident class on the column that
    // says where a memory came from.
    answers(turn([recall(1, {}, { assertedBy: '   ' })]));
    const container = await mountAndAsk('anything');

    expect(cellWords(container, 'Asserted by')).toBe('nobody named');
    expect(cellClass(container, 'Asserted by')).toBe('val doubt');
  });

  it('leaves a filled Asserted by cell on a recalled memory in the confident class', async () => {
    // THE POSITIVE CONTROL FOR THE TEST ABOVE, named rather than placed.
    answers(turn([recall(1, {}, { assertedBy: 'human:oncall-ana' })]));
    const container = await mountAndAsk('anything');

    expect(cellClass(container, 'Asserted by')).toBe('val');
  });

  it('says the turn came back with no answer rather than printing an empty speaker', async () => {
    // THE ONE FREE TEXT FIELD ON THIS API THE LOOP NEITHER AUTHORS NOR VALIDATES, which is the
    // narrower claim: a row's `content` and `assertedBy` are not authored by the loop either, but
    // the remember and supersede schemas trim them and refuse them empty. Nothing trims this one.
    // `loop.ts` copies the model's reply into `text` verbatim and `judgeAnswer` does not police its
    // length, so it is the one blank on this page this product's own producer can emit.
    answers({ ...turn([]), text: '   ' });
    const container = await mountAndAsk('anything');

    expect(logWords(container)).toContain('This turn came back with no answer in it.');
  });

  it('says a verbatim receipt came back empty rather than opening onto nothing', async () => {
    // THE THIRD READER OF `tool_result.content`. The other two were guarded first, which is the
    // sibling shape this repository keeps paying for.
    answers({
      ...turn([]),
      transcript: [{ role: 'tool_result', id: 'r9', name: 'recall', content: '   ' }],
    });
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('This receipt came back with nothing in it.');
  });

  it('says a refusal carried no words rather than racking an empty chip', async () => {
    // The chip is counted in `stripCount`, so a blank one is a strip the header promises and the
    // rack does not draw.
    answers({ ...turn([]), transcript: [{ role: 'refusal', content: '   ' }] });
    const container = await mountAndAsk('anything');

    expect(boardWords(container)).toContain('A refusal was recorded with no words in it.');
  });
});

/** Mount, ask, and hand back the container. The shape almost every test above wants. */
async function mountAndAsk(question: string): Promise<HTMLElement> {
  const container = mount();
  await ask(container, question);
  return container;
}
