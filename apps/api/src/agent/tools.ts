/**
 * The agent's tool surface, and the boundary that stops it lying about what it knows.
 *
 * Five tools, matching ADR 0002: recall, remember, supersede, forget, inspect. `verify` is
 * deliberately NOT here. Auditing the memory against an independent channel is a user action and an
 * HTTP endpoint, because it costs an MCP round trip and because a model deciding when to check
 * itself is theatre rather than a control.
 *
 * THE POINT OF THIS FILE. The differentiator is not that the agent has tools; every agent has
 * tools. It is that the agent is structurally prevented from claiming coverage the memory layer did
 * not give it. Two rules enforce that here rather than in a prompt:
 *
 * 1. `recall` never returns memories without the receipt. The result handed back to the model
 *    always leads with the coverage verdict, and on a verdict that is not COVERED or PARTIAL it
 *    leads with the fact that the search could not run. A model cannot report "no prior incidents"
 *    from a result whose first line says the search failed, and if it tries, the loop's post-check
 *    catches it.
 * 2. `remember` and `supersede` require provenance. A write with an empty `assertedBy` is refused
 *    by the schema before it reaches the repository, which refuses it again at the database. A
 *    memory nobody can attribute is a rumour, and two layers say so.
 *
 * The schemas are the contract the model sees. They are deliberately narrow: no free-form filter
 * strings, no SQL, no id that is not a UUID. `select_query` on the verification channel taught the
 * same lesson from the other direction, and the answer is the same one: refuse, do not escape.
 */

import { z } from 'zod';
import {
  MEMORY_KINDS,
  type Coverage,
  type MemoryRecord,
  type RecallResult,
} from '@throughline/memory';

/** A memory id, and nothing that merely looks like one. */
const memoryId = z.uuid('must be the UUID of an existing memory');

/**
 * Who or what is asserting this, in the shape the memory layer already uses: `human:oncall-ana`,
 * `agent`, `alert:cloudwatch`. Free text, but not empty and not whitespace.
 */
const assertedBy = z
  .string()
  .trim()
  .min(1, 'a write needs provenance: name who or what is asserting this');

// `MEMORY_KINDS` is passed straight through with no cast. It is declared `readonly MemoryKind[]`,
// which zod 4 accepts directly; the `as unknown as [MemoryKind, ...MemoryKind[]]` this file used to
// carry was a zod 3 habit. That double cast is worth naming rather than quietly deleting: it would
// have kept compiling if the kinds list were ever emptied, and an empty enum accepts nothing, so
// every write would have been refused with a schema error nobody could explain.
const kind = z.enum(MEMORY_KINDS);

export const recallSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'say what you are looking for')
    .max(2_000, 'a recall query this long is a document, not a question'),
  limit: z.number().int().positive().max(20).optional(),
});

export const rememberSchema = z.object({
  kind,
  content: z
    .string()
    .trim()
    .min(1, 'a memory with no content is not a memory')
    .max(8_000, 'split this into several memories rather than storing an essay as one'),
  assertedBy,
  incidentId: z.string().trim().max(120).nullish(),
  sourceRef: z.string().trim().max(500).nullish(),
});

export const supersedeSchema = z.object({
  previousId: memoryId,
  kind,
  content: z.string().trim().min(1).max(8_000),
  assertedBy,
  incidentId: z.string().trim().max(120).nullish(),
  sourceRef: z.string().trim().max(500).nullish(),
});

export const forgetSchema = z.object({
  memoryId,
  reason: z
    .string()
    .trim()
    .min(1, 'a tombstone with no reason is a deletion with extra steps')
    .max(500),
});

export const inspectSchema = z.object({ memoryId });

/**
 * The one place a tool name is bound to the schema that validates its arguments.
 *
 * `ToolName` is derived from these keys rather than written out again, so a name can never exist
 * without a schema. The pairing itself is pinned by a test, because `dispatch` casts the parsed
 * arguments to the shape it expects for that name: swapping two schemas here would typecheck and
 * then hand the repository an object with every field undefined.
 */
export const SCHEMAS = {
  recall: recallSchema,
  remember: rememberSchema,
  supersede: supersedeSchema,
  forget: forgetSchema,
  inspect: inspectSchema,
};

export type ToolName = keyof typeof SCHEMAS;

/** The argument shape for one tool, read off the same table the parser uses. */
export type ArgumentsFor<Name extends ToolName> = z.infer<(typeof SCHEMAS)[Name]>;

export type RecallArguments = ArgumentsFor<'recall'>;
export type RememberArguments = ArgumentsFor<'remember'>;
export type SupersedeArguments = ArgumentsFor<'supersede'>;
export type ForgetArguments = ArgumentsFor<'forget'>;
export type InspectArguments = ArgumentsFor<'inspect'>;

export interface ToolDefinition {
  readonly name: ToolName;
  /** Written for the model. It states the constraint, not just the capability. */
  readonly description: string;
  readonly schema: z.ZodType;
  /** Whether calling it changes the store, which is what the rate limiter and audit log key on. */
  readonly writes: boolean;
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'recall',
    writes: false,
    schema: recallSchema,
    description:
      'Search the incident memory. Returns matching memories AND a receipt describing what the ' +
      'search actually did: which retrieval path ran, how many candidates it examined, what it ' +
      'excluded and under which rule, and a coverage verdict of COVERED, PARTIAL or UNKNOWN. ' +
      'UNKNOWN means the search could not be completed and an empty result means nothing at all. ' +
      'You may never report that something did not happen on the basis of an UNKNOWN recall.',
  },
  {
    name: 'remember',
    writes: true,
    schema: rememberSchema,
    description:
      'Store a new memory. Provenance is required: name who or what asserted it. Choose the kind ' +
      'carefully, because it sets how fast this ages. A rejected_hypothesis is a first class ' +
      'memory and is usually the most valuable thing to record, because knowing what did NOT fix ' +
      'an incident is what stops the next person retrying it.',
  },
  {
    name: 'supersede',
    writes: true,
    schema: supersedeSchema,
    description:
      'Replace a memory that has stopped being true. This does NOT delete the old one: it closes ' +
      'its validity window and points it at the replacement, so the history stays queryable. Use ' +
      'this rather than remember whenever the new fact contradicts an existing one.',
  },
  {
    name: 'forget',
    // Described as unwired because it IS unwired. The previous description promised a tombstone
    // this code cannot write, which is the same defect class as a receipt that overstates its
    // search: a claim the implementation does not keep. The tool stays listed because ADR 0002
    // fixes the surface and the console renders it, and because a model that wants to forget
    // something should be able to say so and be told plainly that nothing happened.
    writes: false,
    schema: forgetSchema,
    description:
      'NOT YET CONNECTED. Calling this changes nothing at all and the result will tell you so; ' +
      'say that plainly rather than implying the memory was removed. When it lands it will write ' +
      'a tombstone with a reason rather than deleting the row, so that a removal stays auditable.',
  },
  {
    name: 'inspect',
    writes: false,
    schema: inspectSchema,
    description:
      'Fetch one memory by id with its provenance, age, confirmation counts and supersede chain. ' +
      'Use it when you need to explain WHY you believe something, rather than to search.',
  },
];

const BY_NAME = new Map<string, ToolDefinition>(TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/**
 * Parse a model's tool arguments, or explain the refusal in words the model can act on.
 *
 * Returns a result rather than throwing, because a malformed tool call is an ordinary event in a
 * loop and the right response is to hand the model the reason and let it try again, not to end the
 * turn. An unknown tool name is refused by name: models invent tools.
 */
export type ToolParse =
  | { readonly ok: true; readonly tool: ToolDefinition; readonly args: unknown }
  | { readonly ok: false; readonly reason: string };

export function parseToolCall(name: string, rawArguments: unknown): ToolParse {
  const tool = findTool(name);
  if (!tool) {
    return {
      ok: false,
      reason: `There is no tool called "${name}". The tools are: ${TOOLS.map((one) => one.name).join(', ')}.`,
    };
  }
  const parsed = tool.schema.safeParse(rawArguments);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: `Those arguments do not fit ${name}: ${problems}.` };
  }
  return { ok: true, tool, args: parsed.data };
}

/**
 * Render a recall result for the model, receipt first.
 *
 * Order is the mechanism, not decoration. The coverage verdict is the first thing in the string,
 * so there is no arrangement of this text in which a model reads a list of memories without having
 * first read whether the search ran. When the search did not run there are no memories to read at
 * all, and the text says what failed rather than presenting silence.
 */
export function renderRecall(result: RecallResult): string {
  const { receipt, memories } = result;
  const lines: string[] = [];

  lines.push(`COVERAGE: ${receipt.coverage}. ${receipt.coverageReason}`);

  // An ALLOWLIST, not a test for the literal 'UNKNOWN', for the reason `assertAnswerable` already
  // spells out in the memory package: the types say coverage is one of three strings, and the
  // runtime says it arrives from a database column. A denylist here fails OPEN on 'unknown', on
  // undefined and on any value a later migration adds, and failing open means rendering a list of
  // memories under a verdict nobody recognised, which reads to the model as a completed search.
  if (receipt.coverage !== 'COVERED' && receipt.coverage !== 'PARTIAL') {
    lines.push(
      'The search did not run, so this is not an empty result. You must not say that there are no ' +
        'prior incidents, that nothing was found, or anything else that treats this as an absence. ' +
        'Say that the memory could not be searched and why.',
    );
    return lines.join('\n');
  }

  lines.push(
    `The search ran over ${receipt.candidatesConsidered} candidate memories by ` +
      `${describePath(receipt.retrievalPath)} and returned ${receipt.returned}.`,
  );
  if (receipt.exclusions.length > 0) {
    lines.push(
      `Excluded: ${receipt.exclusions.map((one) => `${one.count} ${one.rule.replace(/_/g, ' ')}`).join(', ')}.`,
    );
  }
  if (receipt.degradations.length > 0) {
    lines.push(`Degraded: ${receipt.degradations.join('; ')}.`);
  }
  if (receipt.coverage === 'PARTIAL') {
    lines.push(
      'PARTIAL means the search was cut short, so what follows is real but incomplete. Do not ' +
        'describe it as everything that is known.',
    );
  }

  if (memories.length === 0) {
    lines.push('\nNo memory matched. The search did run, so this is a real absence.');
    return lines.join('\n');
  }

  lines.push('');
  for (const scored of memories) {
    lines.push(renderMemory(scored.memory, scored.similarity, scored.stale));
  }
  return lines.join('\n');
}

function describePath(path: RecallResult['receipt']['retrievalPath']): string {
  if (path === 'ann_index') return 'the approximate vector index';
  if (path === 'exact_scan') return 'an exact scan';
  return 'no retrieval path at all';
}

/** One memory, with the things that decide whether to trust it, not just its text. */
export function renderMemory(memory: MemoryRecord, similarity?: number, stale?: boolean): string {
  const parts: string[] = [
    `[${memory.kind}] ${memory.content}`,
    `  id ${memory.id}`,
    `  asserted by ${memory.provenance.assertedBy}` +
      (memory.provenance.incidentId ? ` during ${memory.provenance.incidentId}` : '') +
      (memory.provenance.sourceRef ? `, source ${memory.provenance.sourceRef}` : ''),
    `  recorded ${memory.createdAt.toISOString()}, last confirmed ${memory.lastConfirmedAt.toISOString()}`,
  ];
  if (memory.confirmCount > 0 || memory.contradictCount > 0) {
    parts.push(`  confirmed ${memory.confirmCount} times, contradicted ${memory.contradictCount}`);
  }
  if (similarity !== undefined) parts.push(`  similarity ${similarity.toFixed(3)}`);
  if (stale) {
    parts.push(
      '  STALE: past this kind\'s confidence floor. It is shown rather than hidden, because a ' +
        'stale memory you can see is safer than one that vanished. Say so if you use it.',
    );
  }
  if (memory.supersededBy) parts.push(`  SUPERSEDED by ${memory.supersededBy}`);
  if (memory.evictedAt) parts.push(`  TOMBSTONED: ${memory.evictionReason ?? 'no reason recorded'}`);
  return parts.join('\n');
}

/**
 * Phrases that assert an absence, which the loop refuses to let through on an unproven recall.
 *
 * A blocklist of wordings would be a weak control on its own, and it is not the only one: the tool
 * result already leads with the failure, and the loop refuses to finish a turn whose recall came
 * back anything other than COVERED. This is the last of three, and it exists because the first two
 * are about what the model was TOLD and this one is about what it actually SAID.
 *
 * It is deliberately incomplete, and the incompleteness is tested rather than implied away. Two
 * families are left out ON PURPOSE. "I could not find anything" is genuinely ambiguous: under a
 * failed search it is an accurate description of what happened, and refusing it would train the
 * next author to loosen the rule until it refuses nothing. Bare counts like "zero matches" are out
 * for the same reason. What this catches is the confident, unhedged absence, which is the sentence
 * this product exists to prevent.
 */
const ABSENCE_CLAIM =
  /\b(?:no (?:prior|previous|earlier|similar|record|history|memor|incident)|nothing (?:\w+ ){0,2}(?:found|in memory|on record|similar|recorded)|never (?:been )?(?:happened|seen|occurred|recorded)|there (?:is|are|was|were) no)/i;

export function claimsAbsence(text: string): boolean {
  return ABSENCE_CLAIM.test(text);
}

/** Whether a coverage verdict permits an answer that asserts nothing was found. */
export function mayAssertAbsence(coverage: Coverage): boolean {
  return coverage === 'COVERED';
}
