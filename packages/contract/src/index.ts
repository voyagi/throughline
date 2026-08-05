/**
 * The wire contract between `apps/api` and `apps/web`.
 *
 * WHY THIS PACKAGE EXISTS, because a package for eleven interfaces needs a reason.
 *
 * `apps/web/src/islands`, `components` and `scripts` are forbidden from importing `apps/api` or
 * `packages/memory` by the `browser-code-stays-in-the-browser` rule in `.dependency-cruiser.cjs`:
 * island code is bundled and shipped to visitors, so a server import there leaks Node APIs and
 * credentials into a public bundle. That rule is correct and stays.
 *
 * The first attempt at a console therefore TRANSCRIBED these shapes into the web app, with a
 * comment admitting the drift risk and naming a test that would catch it. `npm run gate:dup` refused
 * it, and the gate was right: this repository's own rule is that when two code paths must make the
 * same decision, the decision goes in one module both import, and a "keep in sync" comment does not
 * prevent drift. A transcription of a response shape is exactly that, and a type that lies about a
 * response is worse than no type at all.
 *
 * So the shapes live here, in a package neither wall forbids, and BOTH sides import them. The
 * server's handlers are typed against these, so a field that stops being sent is a type error at
 * build time rather than an `undefined` printed at an operator during an incident.
 *
 * TYPES ONLY. No runtime code, no dependencies, nothing to bundle. Everything here erases at
 * compile time, so importing it from a browser island ships zero bytes.
 *
 * These are deliberately NOT re-exported from `packages/memory`. The memory layer is the artifact
 * being judged and it does not get to know that an HTTP surface exists; the duplication of a name
 * like `Coverage` across the two is a boundary, not an oversight. Where a value must be identical
 * on both sides, the compiler checks it: `apps/api/src/http/contract-check.ts` assigns the memory
 * layer's types to these and fails to compile if they ever diverge.
 */

/** The verdict a recall reports. Mirrors the memory layer's `Coverage`, checked at compile time. */
export type Coverage = 'COVERED' | 'PARTIAL' | 'UNKNOWN';

/** Mirrors the memory layer's `MemoryKind`. The five holder colours are keyed to these. */
export type MemoryKind =
  | 'observation'
  | 'resolution'
  | 'runbook_fact'
  | 'rejected_hypothesis'
  | 'entity_fact';

/** Mirrors the memory layer's `RetrievalPath`. Reported, never assumed. */
export type RetrievalPath = 'ann_index' | 'exact_scan' | 'none';

/**
 * Mirrors the memory layer's `ExclusionRule`. Every exclusion is counted and attributed.
 *
 * `candidate_cap_reached` was MISSING from the first version of this list, and the equality
 * assertion in `apps/api/src/http/contract.ts` refused to compile until it was added. That is the
 * assertion earning its place on its first run: a hand-written mirror of a union is exactly the
 * thing that silently loses a member, and a console switching on five of six rules would have
 * rendered the most interesting exclusion of all as nothing at all.
 */
export type ExclusionRule =
  | 'superseded'
  | 'tombstoned'
  | 'outside_validity_window'
  | 'below_similarity_floor'
  | 'not_embedded'
  | 'candidate_cap_reached';

/**
 * Mirrors the memory layer's `CoverageCause`: which stage stopped the search, as a value.
 *
 * A value and not a sentence, and that is a security property rather than a convenience. The
 * sentence a failing stage could produce is the one that used to quote a database driver or a
 * hosted embedding provider, and this response is rendered onto a screen that gets recorded.
 */
export type CoverageCause =
  | 'no_retrieval_path'
  | 'embedder_failed'
  | 'exclusion_counts_failed'
  | 'candidate_query_failed'
  | 'scoring_failed';

export interface ExclusionView {
  readonly rule: ExclusionRule;
  readonly count: number;
}

/**
 * What actually happened during one recall.
 *
 * THERE IS NO WORKSPACE TOTAL, and its absence is deliberate. The bake-off mockups printed
 * "200 OF 4,102 READ" and the receipt cannot support the second number: it counts what the search
 * examined, not what exists. A console printing a total the API never sent would be a number
 * invented in the product's own house style, which is the failure ART-DIRECTION section 8 exists
 * to prevent.
 */
export interface RecallReceiptView {
  readonly query: string;
  readonly coverage: Coverage;
  readonly coverageReason: string;
  readonly coverageCause: CoverageCause | null;
  readonly retrievalPath: RetrievalPath;
  readonly candidatesConsidered: number;
  readonly returned: number;
  readonly exclusions: readonly ExclusionView[];
  readonly degradations: readonly string[];
  readonly elapsedMs: number;
}

/**
 * One memory a recall returned, with the numbers that ordered it.
 *
 * `score` and `similarity` travel with the row because the product's claim is that a model never
 * produces the number that ordered a result. A console that showed the row without the number
 * would be asking to be taken on trust, which is the thing this whole site refuses to do.
 */
export interface RecalledMemoryView {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly similarity: number;
  readonly score: number;
  readonly freshness: number;
  /** True when freshness fell past this kind's floor. The row is returned FLAGGED, never dropped. */
  readonly stale: boolean;
  readonly ageDays: number;
  readonly halfLifeDays: number;
  readonly confirmations: number;
  readonly contradictions: number;
  readonly assertedBy: string;
  readonly incidentId: string | null;
  readonly supersededBy: string | null;
}

/** One recall, as data. This is what the console's memory pane racks, none of it parsed from prose. */
export interface RecallEventView {
  readonly callId: string;
  readonly receipt: RecallReceiptView;
  readonly memories: readonly RecalledMemoryView[];
}

/**
 * One thing the model said or was told, in the order it happened.
 *
 * `refusal` is the loop's OWN words: any sentence the loop authored rather than the model. That
 * wide definition is the third fix of one defect. Twice the loop put its own text under the
 * `assistant` role, and both times the test asserting otherwise drove only the path that had just
 * been fixed. The round-cap notice was the last one standing and it was never a refusal, which is
 * exactly how it kept slipping past a role named for refusals. What matters is not what the
 * sentence is FOR, it is who WROTE it.
 *
 * Its own role rather than a `tool_result`, and that distinction is load bearing in two places. A
 * provider adapter has to render it as model input, and a `tool_result` carrying an id that no
 * preceding `tool_call` announced is rejected outright by both the Bedrock Converse API and the
 * Anthropic Messages API, so the shape this used to have would have failed on first contact with a
 * real provider while passing every test. The console has the mirror problem: attributing the
 * refusal to the user or to a tool puts the loop's sentence in someone else's mouth, on the one
 * screen that exists to show who said what.
 */
export type TurnView =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string }
  | { readonly role: 'tool_call'; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly role: 'tool_result'; readonly id: string; readonly name: string; readonly content: string }
  | { readonly role: 'refusal'; readonly content: string };

export interface BudgetView {
  /** Null when the ceiling refused the turn: nothing was spent, so nothing is reported as spent. */
  readonly used: number | null;
  readonly limit: number;
  readonly day: string;
}

/** The 200 from `POST /agent/turn`. */
export interface AgentTurnResponse {
  readonly text: string;
  readonly coverage: Coverage | null;
  readonly refusedAnAbsenceClaim: boolean;
  readonly toolCallCount: number;
  readonly modelId: string;
  readonly transcript: readonly TurnView[];
  readonly recalls: readonly RecallEventView[];
  readonly budget: BudgetView;
}

/** Every failure the API hands back. The console branches on `error`, never on the sentence. */
export interface FailureResponse {
  readonly error: string;
  readonly detail: string;
  readonly fields?: readonly string[];
  readonly limit?: number;
  readonly day?: string;
}

export type LampState = 'OK' | 'DEGRADED' | 'UNKNOWN';

export interface LampView {
  readonly name: string;
  readonly state: LampState;
  /** Why the lamp reads as it does, in words written here rather than quoted from a driver. */
  readonly detail: string;
}

/**
 * The 200 from `GET /status`.
 *
 * `observedAt` is when the probe RAN, not when the response was built, because "the last time
 * anyone actually looked" is the fact the status page is about.
 *
 * THERE IS NO `target` FIELD, and there was one until a review asked whether it belonged in a
 * public response. It carried `db.describe()`, which is host, port, database and schema, so an
 * unauthenticated GET published the live CockroachDB Cloud hostname to anyone who loaded the page.
 * Measured against the real cluster before it was removed, not argued about. "Which cluster am I
 * talking to" is an operator's question and the boot log already answers it; a visitor gains
 * nothing from the hostname, and a scanner gains a target.
 */
export interface StatusResponse {
  readonly server: string;
  readonly observedAt: string;
  readonly lamps: readonly LampView[];
}

/** The 200 from `GET /health`. It names the server: something answering the port is not my server. */
export interface HealthResponse {
  readonly server: string;
  readonly status: 'ok';
}
