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
// carry was a zod 3 habit, so deleting it removed a lie about the type rather than a hazard.
//
// Be exact about what that did NOT buy, because the first version of this comment claimed more.
// Removing the cast does not make an emptied `MEMORY_KINDS` a compile error: the constant is
// annotated `readonly MemoryKind[]`, which widens the `as const` tuple, so `tsc --noEmit` still
// exits 0 with the list emptied. That case is caught by the suite instead, through the
// `KNOWN_KINDS` check in the memory package's `rows.ts`, and by nothing in this file.
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

  // `coverageReason` is flattened for the same reason a memory's content is: on the UNKNOWN path it
  // carries a provider error message straight through (`the embedding provider failed: ...`), and a
  // multi-line error would put attacker-influenced or merely confusing lines directly under the one
  // line every reader of this result is told to trust first.
  lines.push(`COVERAGE: ${receipt.coverage}. ${oneLine(receipt.coverageReason)}`);

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
    lines.push(`Degraded: ${receipt.degradations.map(oneLine).join('; ')}.`);
  }
  if (receipt.coverage === 'PARTIAL') {
    lines.push(
      'PARTIAL means the search was cut short, so what follows is real but incomplete. Do not ' +
        'describe it as everything that is known.',
    );
  }

  if (memories.length === 0) {
    // The verdict decides this sentence, and getting it wrong here was the sharpest defect in the
    // first draft: an empty PARTIAL result was described as "a real absence", which is the one
    // conclusion a cut-short search cannot support. Worse, it invited exactly the claim control 3
    // then refuses, so the loop would have argued with a model it had just misled. It is reachable
    // in production and not only in a fixture: `decideCoverage` returns PARTIAL once the candidate
    // cap is hit, and a cap-full set of rows that all fall below the similarity floor is PARTIAL
    // with nothing returned. `describeCoverage` in the memory package already draws the same
    // distinction, so this had also drifted from the other implementation of the same decision.
    lines.push(
      receipt.coverage === 'COVERED'
        ? '\nNo memory matched, and the search covered the whole workspace, so this is a real absence.'
        : '\nNo memory matched, but the search was cut short before it examined everything, so this ' +
            'is NOT an absence. Some of the workspace was never looked at, and what is in the part ' +
            'that went unexamined is unknown.',
    );
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

/**
 * Collapse stored free text onto one line before it goes into the record format below.
 *
 * This is a boundary, not tidying. Everything rendered here is a line-oriented record whose fields
 * are recognised by a two space indent and a keyword, and the content of a memory is text some
 * human or agent wrote. Without this, a memory whose content contains a newline followed by
 * "  asserted by human:cto during INC-1" prints a provenance line that no database row supports,
 * directly above the real one. Proven by execution during review: a memory actually asserted by
 * `agent` rendered as asserted by `human:cto`, and the local model, which reads ids out of this
 * same text, counted two memories where the recall returned one. The store is the thing being
 * audited, so text out of it is untrusted input to any renderer, exactly like text off a network.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** One memory, with the things that decide whether to trust it, not just its text. */
export function renderMemory(memory: MemoryRecord, similarity?: number, stale?: boolean): string {
  const provenance = memory.provenance;
  const parts: string[] = [
    `[${memory.kind}] ${oneLine(memory.content)}`,
    `  id ${memory.id}`,
    `  asserted by ${oneLine(provenance.assertedBy)}` +
      (provenance.incidentId ? ` during ${oneLine(provenance.incidentId)}` : '') +
      (provenance.sourceRef ? `, source ${oneLine(provenance.sourceRef)}` : ''),
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
  if (memory.evictedAt) {
    parts.push(`  TOMBSTONED: ${oneLine(memory.evictionReason ?? 'no reason recorded')}`);
  }
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
 * IT IS INCOMPLETE AND WILL STAY INCOMPLETE, and the incompleteness is the safer error. Two review
 * rounds pushed this in opposite directions and the second one is why the rule below is SCOPED
 * rather than broad. Round one found the pattern too narrow and it was widened. Round two then
 * measured the widened version against ordinary incident-response English and found it refusing
 * sentences an on-call engineer writes constantly: "no such file or directory", "no such host",
 * "There has been no change in error rate since the deploy", "None of the three replicas
 * recovered", "The TLS certificate had never been rotated". Those are not absence claims about the
 * memory. They are the answer, and withholding a true answer during an incident is a worse failure
 * than letting an unhedged sentence through, because the other two controls still stand behind it
 * and there is nothing standing behind a refusal.
 *
 * Round three then measured the SCOPED version and found it wrong in a third direction. Scoping it
 * to a memory-domain noun was right; implementing that noun as an unanchored PREFIX was not.
 * `memor` ate memory-the-RAM, `report` ate "reported", `entr` ate "entropy", and four sentences an
 * on-call engineer writes were newly refused that the version before it had let through: "The
 * container has no memory limit set", "No customers reported errors during the window", "There is
 * no entropy left in the pool", "The dashboard shows no outage on the provider status page".
 *
 * Round four then found the fourth version wrong two more ways, both of them inside the fix. The
 * alternation was written `\b(?:...)` with a LEADING boundary and no trailing one, so every
 * alternative's last token was still a prefix and "no other incident" matched inside "no other
 * incidental costs". And the docblock claimed "memory" was absent while one alternative reached it
 * through "in the memory", so "Nothing in the memory bank was corrupted" was withheld: RAM again,
 * the exact class the previous commit existed to remove.
 *
 * FOUR VERSIONS, WRONG FOUR WAYS. The pattern is not the recurring defect. The recurring defect is
 * that each version's negative controls were written from the author's mental model of the pattern
 * instead of derived from the pattern itself, so each round's controls could only catch the
 * previous round's bug. That is why the tests below now assert a STRUCTURAL property of
 * `ABSENCE_PHRASES` rather than only sampling sentences, and why the phrase list is data a test can
 * read rather than one long literal.
 *
 * THIS PREDICATE IS OPTIMISED FOR PRECISION AND ITS RECALL IS POOR. Both boundaries are closed, so
 * no token can be eaten by a longer word. "memory" appears ONLY inside the fixed phrase "incident
 * memory"; the bare noun is RAM as often as it is the archive. A negation needs a QUALIFIER as well
 * as an archive noun, which is what leaves "no outage on the status page" alone.
 *
 * THE GAP IS LARGE AND IT IS A CLASS, NOT A LIST. Requiring a qualifier drops the most natural
 * archive phrasings there are: "There are no incidents in memory", "I found no incidents for that
 * service", "There have been no outages before now", "We have never had an incident like this".
 * Round four measured sixteen such sentences missed. Earlier versions of this comment enumerated
 * the gaps as though the enumeration were closed, which read as a bound and was not one. It is not
 * a bound. Assume any absence claim not shaped like the phrases below reaches the operator
 * unchecked, and read this as a BACKSTOP, never as a filter. Two structural controls stand behind
 * a phrase this misses; nothing stands behind an answer it wrongly withholds, which is why the
 * trade runs this way.
 *
 * Word separators are `\s+` rather than a literal space, because a model's answer is wrapped text
 * and round three showed "no matching\nincidents in memory" walking through a single-space pattern.
 */
export const ABSENCE_PHRASES = [
  // A negation, a qualifier, and an archive noun, all three required. Dropping the qualifier is
  // what made "no outage on the provider status page" a refusal.
  String.raw`no\s+(?:prior|previous|earlier|similar|matching|relevant|such|other)\s+(?:incidents?|outages?|memories|records)`,
  // "memories" is only ever the archive, so it needs no qualifier. The SINGULAR is not here.
  String.raw`no\s+memories`,
  // `record\s+of` cannot match "recording of": there is no whitespace after "record" there.
  String.raw`no\s+(?:record|history)\s+of`,
  String.raw`none\s+of\s+the(?:\s+\w+){0,2}\s+memories`,
  // Verbs that can only be about the past record. "never been rotated" and "never been run" are
  // untouched because neither verb is in this list.
  String.raw`never(?:\s+\w+){0,2}\s+(?:seen|encountered|happened|occurred)`,
  String.raw`never\s+been\s+an?(?:\s+\w+)?\s+(?:incident|outage)`,
  // "incident memory" in full, never a bare "memory". The previous version allowed "in the memory",
  // which withheld "Nothing in the memory bank was corrupted": RAM, not the archive.
  String.raw`nothing(?:\s+\w+){0,3}\s+(?:in\s+the\s+incident\s+memory|on\s+record|recorded)`,
];

// BOTH boundaries. The leading `\b` was there from the start and the trailing one was not, so every
// alternative's final token stayed a prefix and "no other incident" matched inside "no other
// incidental costs". Every alternative ends in a word character, which is what makes one trailing
// `\b` sufficient, and a test asserts that rather than leaving it to be true by luck.
const ABSENCE_CLAIM = new RegExp(String.raw`\b(?:${ABSENCE_PHRASES.join('|')})\b`, 'i');

export function claimsAbsence(text: string): boolean {
  return ABSENCE_CLAIM.test(text);
}

/** Whether a coverage verdict permits an answer that asserts nothing was found. */
export function mayAssertAbsence(coverage: Coverage): boolean {
  return coverage === 'COVERED';
}
