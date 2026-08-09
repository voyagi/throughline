/**
 * The types this site uses, and where each one comes from.
 *
 * THE WIRE SHAPES ARE IMPORTED, NOT TRANSCRIBED. The first version of this file declared them
 * again by hand, with a comment admitting the drift risk and naming a test that would catch it.
 * `npm run gate:dup` refused it and the gate was right: this repository's rule is that when two
 * code paths must agree, the agreement lives in one module both import, and a "keep in sync"
 * comment does not prevent drift. They now live in `@throughline/contract`, which the API's
 * handlers are also typed against, so a field that stops being sent is a compile error rather than
 * an `undefined` printed at an operator mid-incident.
 *
 * Importing it from island code is allowed and costs nothing: the package is types only, so every
 * import here erases at compile time and ships zero bytes. The
 * `browser-code-stays-in-the-browser` rule still forbids reaching into `apps/api` or
 * `packages/memory`, and nothing here does.
 *
 * What remains below is what belongs to the SITE rather than to the wire.
 */

export type {
  AgentTurnResponse,
  BudgetView,
  Coverage,
  CoverageCause,
  ExclusionRule,
  ExclusionView,
  FailureResponse,
  HealthResponse,
  LampState,
  LampView,
  ListFailureCause,
  MemoryKind,
  MemoryListReceiptView,
  MemoryListResponse,
  MemoryRowView,
  MemoryState,
  RecallEventView,
  RecallReceiptView,
  RecalledMemoryView,
  RetrievalPath,
  StatusResponse,
  TurnView,
} from '@throughline/contract';

/**
 * How far a number on a page can be trusted. The source strip prints one of these per row.
 *
 * Three and no fourth. MEASURED means the running system produced it. ILLUSTRATION means it is an
 * example, drawn from `packages/memory/src/policy.ts` wherever it is a policy value at all.
 * UNKNOWN means nobody looked, and it renders unlit rather than as anything reassuring.
 */
export type Trust = 'MEASURED' | 'ILLUSTRATION' | 'UNKNOWN';

export interface SourceRow {
  readonly claim: string;
  readonly trust: Trust;
}
