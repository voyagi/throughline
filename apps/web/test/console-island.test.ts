import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentTurnResponse,
  RecallEventView,
  RecallReceiptView,
  RecalledMemoryView,
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
 * `cancelAnimationFrame` from THIS file reddens 0 of 17. Copying the sibling's paragraph would have
 * put a false claim at the top of a new file on the strength of it being true next door, which is
 * the failure this repository keeps finding in its own prose. `Console.tsx` uses `useRef` and
 * `useState` and no `useEffect` at all, so preact never reaches the frame scheduler here.
 *
 * Both halves are still installed, before preact is imported, which is why the imports below are
 * dynamic. Their value here is correctness of description and readiness for the first test that
 * does use an effect, not a defence this file leans on.
 *
 * WHAT THIS FILE ACTUALLY RESTS ON is the round trip. The console fetches NOTHING on mount: it
 * answers a submitted question, so nothing exists to assert until a form that only exists after
 * render has been driven and an answer has come back through `api.ts` and `shapes.ts`. MEASURED on
 * 2026-08-09: dropping the submit dispatch out of `ask`, which is the whole of what a dead island
 * does, reddens 17 OF 17 by name. Every test here depends on a completed round trip.
 *
 * BOTH NUMBERS HAVE NOW BEEN RE-MEASURED TWICE, at 8 tests, at 12 and at 17, each time in the change
 * that grew the file. A number written once and left alone is exactly what the sibling file records
 * being wrong about four times, and this file would already have been wrong twice.
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
  const chip = [...container.querySelectorAll('.log .verdict')].find((one) =>
    (one.textContent ?? '').includes('TURN COVERAGE'),
  );
  if (chip === undefined) throw new Error('the log has no TURN COVERAGE chip');
  if (!chip.hasAttribute('class')) throw new Error('the TURN COVERAGE chip carries no class attribute');
  return chip.getAttribute('class') ?? '';
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

const memory = (id: string): RecalledMemoryView => ({
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

const recall = (memoryCount: number, overrides: Partial<RecallReceiptView> = {}): RecallEventView => ({
  callId: 'recall-1',
  receipt: receipt(memoryCount, overrides),
  memories: Array.from({ length: memoryCount }, (_unused, index) => memory(String(index))),
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
    // THIS one really does disagree with the strips, so the rack wording is the true one here.
    expect(boardWords(container)).toContain('disagrees with the strips beside it');
    expect(logWords(container)).toContain('ITS COUNT DISAGREES WITH THE STRIPS');
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
    // It also may not claim HOW the API computed that value, on a body it just called foreign.
    expect(logWords(container)).not.toContain('A REFUSED RECEIPT FED IT');
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
      transcript: [{ role: 'tool_call', id: 'recall-2', name: 'recall', args: { query: 'a second look' } }],
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
    expect(boardWords(container)).not.toContain('disagrees with the strips beside it');
    expect(logWords(container)).toContain('ITS OWN FIELDS DISAGREE');
    expect(logWords(container)).not.toContain('ITS COUNT DISAGREES WITH THE STRIPS');
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

/** Mount, ask, and hand back the container. The shape almost every test above wants. */
async function mountAndAsk(question: string): Promise<HTMLElement> {
  const container = mount();
  await ask(container, question);
  return container;
}
