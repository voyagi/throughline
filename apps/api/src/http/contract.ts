import { DEFAULT_POLICY, MS_PER_DAY } from '@throughline/memory';
import type {
  Capabilities,
  Coverage,
  CoverageCause,
  ExclusionRule,
  MemoryKind,
  MemoryPolicy,
  Observation,
  RecallResult,
  RetrievalPath,
} from '@throughline/memory';
import type {
  Coverage as WireCoverage,
  CoverageCause as WireCoverageCause,
  ExclusionRule as WireExclusionRule,
  LampView,
  MemoryKind as WireMemoryKind,
  RecallEventView,
  RecalledMemoryView,
  RetrievalPath as WireRetrievalPath,
} from '@throughline/contract';

/**
 * The one place the memory layer's shapes become the shapes a browser reads.
 *
 * Two jobs, and they belong together. It MAPS, and it PROVES the two vocabularies still agree.
 *
 * The proof is the interesting half. `@throughline/contract` re-declares five string unions that
 * the memory layer also declares, because the memory layer is the artifact being judged and does
 * not get to know an HTTP surface exists. Re-declaring is a boundary rather than an oversight, but
 * a re-declaration that nobody checks is exactly the silent drift this repository keeps paying
 * for. So each pair is asserted EXACTLY EQUAL below, in both directions, and a mismatch is a
 * compile error rather than a runtime surprise.
 *
 * Both directions matter and one direction is not enough. A one-way `extends` check passes when
 * the wire type is WIDER than the memory type, so adding a sixth memory kind on the server would
 * sail through while every console branching on the union silently stopped being exhaustive.
 */

/**
 * True only when A and B are the same type, not merely mutually assignable.
 *
 * The conditional-type-identity trick rather than a pair of `extends` checks, because `extends`
 * treats `never` as assignable to everything, so an assertion built on it passes when the type it
 * is checking has collapsed to `never` - which is the exact case a broken import produces.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type CoverageAgrees = Expect<Equal<Coverage, WireCoverage>>;
export type CoverageCauseAgrees = Expect<Equal<CoverageCause, WireCoverageCause>>;
export type MemoryKindAgrees = Expect<Equal<MemoryKind, WireMemoryKind>>;
export type RetrievalPathAgrees = Expect<Equal<RetrievalPath, WireRetrievalPath>>;
export type ExclusionRuleAgrees = Expect<Equal<ExclusionRule, WireExclusionRule>>;

const wholeDaysBetween = (from: Date, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));

/**
 * A recall, as the console reads it.
 *
 * `coverageReason` IS forwarded, and that is safe by construction rather than by hope: the memory
 * layer writes it from scratch at every site and never interpolates a caught error's message. The
 * docblock on `RecallReceipt.coverageReason` carries the proof, and two controls in
 * `test/server.test.ts` fail if that ever stops being true.
 */
export function toRecallEvent(
  callId: string,
  result: RecallResult,
  now: Date,
  policy: MemoryPolicy = DEFAULT_POLICY,
): RecallEventView {
  const { receipt, memories } = result;
  return {
    callId,
    receipt: {
      query: receipt.query,
      coverage: receipt.coverage,
      coverageReason: receipt.coverageReason,
      coverageCause: receipt.coverageCause,
      retrievalPath: receipt.retrievalPath,
      candidatesConsidered: receipt.candidatesConsidered,
      returned: receipt.returned,
      exclusions: receipt.exclusions.map((one) => ({ rule: one.rule, count: one.count })),
      degradations: receipt.degradations,
      elapsedMs: receipt.elapsedMs,
    },
    memories: memories.map((scored): RecalledMemoryView => {
      const { memory } = scored;
      return {
        id: memory.id,
        kind: memory.kind,
        content: memory.content,
        similarity: scored.similarity,
        score: scored.score,
        freshness: scored.freshness,
        stale: scored.stale,
        ageDays: wholeDaysBetween(memory.createdAt, now),
        halfLifeDays: policy.halfLifeDays[memory.kind],
        confirmations: memory.confirmCount,
        contradictions: memory.contradictCount,
        assertedBy: memory.provenance.assertedBy,
        incidentId: memory.provenance.incidentId,
        supersededBy: memory.supersededBy,
      };
    }),
  };
}

/**
 * The annunciator, from a real probe.
 *
 * THE TRI-STATE SURVIVES THE MAPPING, and that is the whole point of this function. An
 * `Observation` distinguishes "checked, and it is absent" from "could not check", and collapsing
 * those into a boolean here would commit the product's headline failure in the product's own
 * chrome. `unknown` becomes UNKNOWN and renders unlit; it never becomes DEGRADED, because
 * DEGRADED is a measurement and nobody measured anything.
 *
 * The MCP lamp is deliberately not probed here. Opening the verification channel costs a round
 * trip to a third party on every status poll, and a status page that hammers an external service
 * to draw a lamp is a denial of service with a nice font. It reports what configuration says and
 * says so.
 */
export function toLamps(capabilities: Capabilities, mcpConfigured: boolean): readonly LampView[] {
  const { vectorIndex, annPlanUsesIndex, vectorColumnDimensions, embedderDimensions } = capabilities;

  return [
    {
      name: 'Vector index',
      ...describeIndex(vectorIndex, annPlanUsesIndex),
    },
    {
      name: 'Embeddings',
      ...describeEmbedding(vectorColumnDimensions, embedderDimensions),
    },
    {
      name: 'MCP transport',
      state: mcpConfigured ? 'DEGRADED' : 'UNKNOWN',
      detail: mcpConfigured
        ? 'A verification channel is configured. This page does not open it, because polling a ' +
          'third party to draw a lamp is not a status check. Use the verify action to exercise it.'
        : 'No verification channel is configured, so nobody has looked.',
    },
  ];
}

function describeIndex(
  exists: Observation<boolean>,
  plannerUses: Observation<boolean>,
): { state: LampView['state']; detail: string } {
  if (plannerUses.status === 'observed' && plannerUses.value) {
    return { state: 'OK', detail: 'The planner chooses the vector index for the recall query.' };
  }
  // NO PROBE REASON IS INTERPOLATED INTO A LAMP, and this is the second round of the same lesson.
  // The first round removed `capabilities.target` from this response because it published the
  // cluster host; a review then pointed out that the reasons still carried `throughline.memory`,
  // the schema and table, through exactly this line. Same class, one hop further along.
  //
  // The reasons are written from scratch in `capability.ts` and carry no driver text, so this is
  // about IDENTIFIERS rather than about leaked exceptions: a public status page has no reason to
  // name internal objects. The operator's copy is in the boot log and in `npm run probe`.
  if (plannerUses.status === 'unknown') {
    return { state: 'UNKNOWN', detail: 'The query plan could not be read, so nobody knows.' };
  }
  if (exists.status === 'unknown') {
    return {
      state: 'UNKNOWN',
      detail: 'The planner does not use an index, and whether one exists could not be determined.',
    };
  }
  return exists.value
    ? {
        state: 'DEGRADED',
        detail: 'An index exists and the planner is ignoring it. Recall falls back to an exact scan.',
      }
    : {
        state: 'DEGRADED',
        detail: 'No vector index on the embedding column. Recall compares every live row directly.',
      };
}

function describeEmbedding(
  column: Observation<number>,
  embedder: Observation<number>,
): { state: LampView['state']; detail: string } {
  if (column.status === 'unknown') {
    return { state: 'UNKNOWN', detail: 'The embedding column could not be inspected.' };
  }
  if (embedder.status === 'unknown') {
    return { state: 'UNKNOWN', detail: 'The embedder could not be measured.' };
  }
  if (column.value !== embedder.value) {
    return {
      state: 'DEGRADED',
      detail:
        `The column holds ${column.value} dimensions and the embedder produces ${embedder.value}. ` +
        'Comparing them would not be less accurate, it would be meaningless, so no recall runs.',
    };
  }
  return { state: 'OK', detail: `The embedder and the column agree at ${column.value} dimensions.` };
}
