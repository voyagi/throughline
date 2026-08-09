/**
 * What a response has to look like before the console will treat it as an answer.
 *
 * WHY THIS EXISTS, WRITTEN AS THE REPRO RATHER THAN AS THE CONCLUSION. `call` in `api.ts` returns
 * `ok: true` for any 200 whose body parses, so the body decides nothing and the page believes
 * whatever arrives. Two reviews, in two rounds, drove the same input class through it:
 *
 *   - `{}` on `/agent/turn` reached `Console.tsx:316` as an answer, where `response.recalls.map`
 *     threw during render and the pane went blank - the silent absence `api.ts` says the whole site
 *     argues against;
 *   - `{ receipt: { coverage: 'COVERED', kinds: [] }, memories: [] }` on `/memories` passed the
 *     first version of this guard, and the archive drew "the listing completed and no row matches"
 *     beside a bound of `undefined rows` and an empty Why cell. A receipt too thin to explain
 *     anything was still reported as a completed listing;
 *   - `coverage: 'unknown'`, in that casing, was accepted as a string, compared against the literal
 *     `'UNKNOWN'`, missed, and rendered as THE LISTING RAN.
 *
 * Each of those is one shape: a body that cannot support the sentence the page prints from it.
 *
 * THE FIELD MAPS ARE THE ENFORCEMENT, not the field lists in the docblocks. `FieldChecks<T>` is
 * `Record<keyof T, Check>`, so a field added to a contract interface is a COMPILE error here until
 * somebody decides what a valid value looks like. That is what keeps this from being the "second
 * copy of the contract, free to drift" that `types.ts` refuses: it cannot drift without failing the
 * build. `npm run verify:ship`'s web step (`astro check`) is what runs that check; the root
 * `gate:types` excludes `apps/web`.
 */
import { labelled } from './presentation.ts';
import type {
  AgentTurnResponse,
  BudgetView,
  Coverage,
  ExclusionView,
  LampView,
  MemoryListReceiptView,
  MemoryListResponse,
  MemoryRowView,
  RecallEventView,
  RecallReceiptView,
  RecalledMemoryView,
  StatusResponse,
  TurnView,
} from './types.ts';

type Check = (value: unknown) => boolean;

/** One check per declared field. See the docblock: the `keyof` is the part doing the work. */
type FieldChecks<T> = Readonly<Record<keyof T, Check>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString: Check = (value) => typeof value === 'string';
const isBoolean: Check = (value) => typeof value === 'boolean';

/** Finite, so a NaN cannot reach a cell that would print `NaN` in the place a measurement goes. */
const isNumber: Check = (value) => typeof value === 'number' && Number.isFinite(value);

const nullOr =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);

const arrayOf =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check);

function hasFields<T>(checks: FieldChecks<T>, value: unknown): value is T {
  if (!isObject(value)) return false;
  for (const [field, check] of Object.entries<Check>(checks)) {
    if (!check(value[field])) return false;
  }
  return true;
}

/**
 * The three words the contract declares, as something a running program can test against.
 *
 * `Record<Coverage, true>` enforces both directions: a fourth coverage added to the contract fails
 * to compile until it is listed here, and a word that is not a `Coverage` is refused as an excess
 * property. A plain array would have caught neither.
 */
export const COVERAGE_WORDS: Readonly<Record<Coverage, true>> = {
  COVERED: true,
  PARTIAL: true,
  UNKNOWN: true,
};

const isCoverage: Check = (value) => typeof value === 'string' && labelled(COVERAGE_WORDS, value) === true;

const RECEIPT_CHECKS: FieldChecks<MemoryListReceiptView> = {
  kinds: arrayOf(isString),
  limit: isNumber,
  returned: isNumber,
  coverage: isCoverage,
  coverageReason: isString,
  coverageCause: nullOr(isString),
  requestedAt: isString,
  elapsedMs: isNumber,
};

/**
 * A row is checked whole, and `kind` and `state` are checked only as strings.
 *
 * Whole, because `Archive.tsx` reads sixteen of these eighteen fields and two of them are read with
 * a method call - `freshness.toFixed` at `:124` and the `memory.id` key at `:482` - which THROW on a
 * missing value rather than printing wrongly. A review proved it: `memories: [null, 3, 'x']` was
 * accepted, classified as three rows, and crashed the island's render.
 *
 * Strings rather than closed domains for `kind` and `state`, deliberately, and the direction is the
 * reason. `kindWords` falls back to the raw value, so an unrecognised kind prints as itself and the
 * reader sees a word nobody has a label for - visibly odd, and true. Refusing the whole listing for
 * it would replace one honest row with no archive at all.
 */
const ROW_CHECKS: FieldChecks<MemoryRowView> = {
  id: isString,
  kind: isString,
  content: isString,
  state: isString,
  freshness: isNumber,
  stale: isBoolean,
  ageDays: isNumber,
  halfLifeDays: isNumber,
  confirmations: isNumber,
  contradictions: isNumber,
  assertedBy: isString,
  incidentId: nullOr(isString),
  supersededBy: nullOr(isString),
  createdAt: isString,
  validFrom: isString,
  validUntil: nullOr(isString),
  evictedAt: nullOr(isString),
  evictionReason: nullOr(isString),
};

const LISTING_CHECKS: FieldChecks<MemoryListResponse> = {
  server: isString,
  receipt: (value) => hasFields(RECEIPT_CHECKS, value),
  memories: arrayOf((value) => hasFields(ROW_CHECKS, value)),
};

/**
 * A lamp's `state` is a string here, not the closed `LampState`, and that is a judgement worth
 * recording rather than an omission.
 *
 * `StatusBoard.classFor` sends every unrecognised state to the UNLIT class, so a state this console
 * does not know renders as doubt with its own word printed beside it. That is the safe direction and
 * it is the one this site prefers everywhere else. Refusing the whole status page because one lamp
 * came back with a word we do not recognise would turn a legible partial answer into no answer.
 *
 * `coverage` gets the opposite treatment for the opposite reason: an unrecognised coverage does not
 * degrade to doubt, it degrades to `empty`, which is the page's most confident sentence.
 */
const LAMP_CHECKS: FieldChecks<LampView> = {
  name: isString,
  state: isString,
  detail: isString,
};

const STATUS_CHECKS: FieldChecks<StatusResponse> = {
  server: isString,
  observedAt: isString,
  lamps: arrayOf((value) => hasFields(LAMP_CHECKS, value)),
};

/**
 * A memory a RECALL returned, checked whole, for the same reason `ROW_CHECKS` is.
 *
 * THIS WAS THE DEFECT IN THE COMMIT THAT ADDED THIS FILE. `recalls[].memories` was checked as
 * `Array.isArray` and nothing more, so `[null]`, `[3]` or `['an-id']` were accepted - while
 * `Console.tsx` keys each one by `memory.id` (`:487`) and calls `score.toFixed` (`:96`) and
 * `similarity.toFixed` (`:121`). Those THROW, and the pane goes blank: exactly the failure the
 * header of this file says it closed, left open one list over from where it was closed. The listing
 * path had the identical hole and the identical fix twelve lines up, which is what makes this worth
 * writing down rather than quietly correcting.
 *
 * `kind` is a string here rather than the closed union, matching `ROW_CHECKS` and for the same
 * reason: an unrecognised kind prints as itself, which is odd and true.
 */
const RECALLED_MEMORY_CHECKS: FieldChecks<RecalledMemoryView> = {
  id: isString,
  kind: isString,
  content: isString,
  similarity: isNumber,
  score: isNumber,
  freshness: isNumber,
  stale: isBoolean,
  ageDays: isNumber,
  halfLifeDays: isNumber,
  confirmations: isNumber,
  contradictions: isNumber,
  assertedBy: isString,
  incidentId: nullOr(isString),
  supersededBy: nullOr(isString),
};

const EXCLUSION_CHECKS: FieldChecks<ExclusionView> = {
  rule: isString,
  count: isNumber,
};

/**
 * The daily ceiling as the turn reports it.
 *
 * Checked whole even though nothing on the console reads it yet, because `BudgetView` was the ONE
 * contract interface reachable from `AgentTurnResponse` with no map, and that asymmetry is how the
 * next hole gets in. A review put it exactly right: `args` had a paragraph explaining why it is
 * unchecked and this had nothing, which is the difference between a decision and an oversight.
 *
 * `used` is nullable because THE CONTRACT DECLARES IT SO, and that is the whole reason available
 * here. An earlier version of this sentence explained it as "null when the ceiling refused the
 * turn", which is a real case and one this guard never sees: a refused claim is answered 429 by
 * `server.ts` and reaches the console through `asFailure`, never through `isAgentTurnResponse`.
 * Mirroring the declared type is the honest justification; inventing a scenario for it was not.
 */
const BUDGET_CHECKS: FieldChecks<BudgetView> = {
  used: nullOr(isNumber),
  limit: isNumber,
  day: isString,
};

/**
 * A recall's receipt, checked whole.
 *
 * THIS PARAGRAPH HAS NOW BEEN WRONG TWICE, IN THE SAME DIRECTION, AND THAT IS THE REASON THE FIX IS
 * STRUCTURAL RATHER THAN ANOTHER FIELD. The first version said the fields beyond `coverage` are "a
 * wrong or blank cell"; corrected, it still said they are "printed and never dereferenced". Both
 * were false: `Console.tsx:399` calls `.toUpperCase()` on `retrievalPath`, so a receipt carrying
 * only `coverage` was accepted and then threw during render. Writing a narrower claim about the
 * same object was not a fix, it was the same mistake with better prose.
 *
 * So this is a full `FieldChecks<RecallReceiptView>`, and `RECALL_CHECKS` below it is
 * `FieldChecks<RecallEventView>`. Neither can be checked at one field again without failing the
 * build, which is the only kind of guarantee this file is entitled to make about itself. (The
 * previous sentence said "the map above it", which is a fact about the file that was never true -
 * `RECALL_CHECKS` is underneath. A review counted the lines.)
 */
const RECALL_RECEIPT_CHECKS: FieldChecks<RecallReceiptView> = {
  query: isString,
  coverage: isCoverage,
  coverageReason: isString,
  coverageCause: nullOr(isString),
  retrievalPath: isString,
  candidatesConsidered: isNumber,
  returned: isNumber,
  exclusions: arrayOf((value) => hasFields(EXCLUSION_CHECKS, value)),
  degradations: arrayOf(isString),
  elapsedMs: isNumber,
};

/**
 * TYPED OFF THE CONTRACT, not off an inline literal, and that difference was itself a finding.
 *
 * The previous version declared `FieldChecks<{ callId: string; receipt: unknown; memories: unknown }>`
 * - a shape written here by hand, which is exactly the "second copy of the contract, free to drift"
 * that the header of this file says cannot exist. Measured: a field planted on `RecalledMemoryView`
 * or `StatusResponse` failed `astro check` in two places, and the same plant on `RecallEventView`
 * failed in one, because this map was not looking at the contract at all.
 */
const RECALL_CHECKS: FieldChecks<RecallEventView> = {
  callId: isString,
  receipt: (value) => hasFields(RECALL_RECEIPT_CHECKS, value),
  memories: arrayOf((value) => hasFields(RECALLED_MEMORY_CHECKS, value)),
};

/**
 * One entry of the transcript, checked by the role it declares.
 *
 * `role` alone was not enough, which is the other half of the same finding. `Console.tsx:568` reads
 * `content.length`, so `{ role: 'tool_result', id: 't1', name: 'recall' }` - a turn with no
 * `content` - was accepted and threw during render. `TurnView` is five shapes carrying different
 * fields, so one flat map cannot describe it.
 *
 * The type is what keeps this honest in BOTH directions: a sixth role added to the union has no
 * entry and fails to compile, and a field added to one of the five variants leaves that variant's
 * map incomplete and fails to compile. `args` is `unknown` in the contract and stays unchecked here
 * on purpose - it is model-supplied, and `Console.tsx:226` already reads it defensively.
 */
const TURN_ROLE_CHECKS: { [Role in TurnView['role']]: FieldChecks<Extract<TurnView, { role: Role }>> } = {
  user: { role: isString, content: isString },
  assistant: { role: isString, content: isString },
  refusal: { role: isString, content: isString },
  tool_call: { role: isString, id: isString, name: isString, args: () => true },
  tool_result: { role: isString, id: isString, name: isString, content: isString },
};

/**
 * An unrecognised role is refused rather than waved through. The console branches on role and renders
 * nothing for a word it does not know, so a turn it cannot place is a turn it cannot show.
 *
 * `labelled` RATHER THAN A BARE LOOKUP, and this is the third instance of one mistake in one file.
 * The first version tested `TURN_ROLE_CHECKS[role] !== undefined`, which accepted every one of the
 * TWELVE own names on `Object.prototype` - `constructor`, `toString`, `__proto__`, `valueOf`,
 * `hasOwnProperty` and the rest. Each resolves to an INHERITED value, which is not undefined, and
 * `Object.entries()` of it is empty, so `hasFields` returned true on an empty loop and a turn with
 * no field but `role` was accepted. The comment right here said the opposite, and the test used
 * `narrator`, which the broken guard already refused, so the suite was green over the hole. (An
 * earlier version of this sentence said eight. A review counted them: twelve, all accepted.)
 *
 * `isCoverage`, elsewhere in this file, tests `=== true` and was never vulnerable. Writing the safe
 * version and the unsafe version of the same lookup in the same file, an hour apart, is the argument
 * for having one helper both call rather than two expressions that happen to agree. No line distance
 * is quoted here: this file has now carried two wrong ones, the second written sixty lines below its
 * own correction of the first.
 */
const isTurnView: Check = (value) => {
  if (!isObject(value)) return false;
  const role = value['role'];
  if (typeof role !== 'string') return false;
  const checks = labelled(TURN_ROLE_CHECKS, role);
  return checks !== undefined && hasFields(checks, value);
};

const TURN_CHECKS: FieldChecks<AgentTurnResponse> = {
  text: isString,
  coverage: nullOr(isCoverage),
  refusedAnAbsenceClaim: isBoolean,
  toolCallCount: isNumber,
  modelId: isString,
  budget: (value) => hasFields(BUDGET_CHECKS, value),
  transcript: arrayOf(isTurnView),
  recalls: arrayOf((value) => hasFields(RECALL_CHECKS, value)),
};

export const isMemoryListResponse = (body: unknown): body is MemoryListResponse =>
  hasFields(LISTING_CHECKS, body);

export const isStatusResponse = (body: unknown): body is StatusResponse =>
  hasFields(STATUS_CHECKS, body);

export const isAgentTurnResponse = (body: unknown): body is AgentTurnResponse =>
  hasFields(TURN_CHECKS, body);
