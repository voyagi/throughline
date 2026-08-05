import { describe, expect, it } from 'vitest';
import type { Coverage } from '@throughline/memory';
import { MEMORY_KINDS } from '@throughline/memory';
import {
  claimsAbsence,
  findTool,
  mayAssertAbsence,
  parseToolCall,
  renderMemory,
  renderRecall,
  SCHEMAS,
  TOOLS,
  type ToolName,
} from '../src/agent/tools.ts';
import {
  MEMORY_ID_A,
  MEMORY_ID_B,
  memoryRecord,
  recallResult,
  scoredMemory,
} from './agent-fixtures.ts';

describe('the tool table', () => {
  it('lists exactly the five tools ADR 0002 fixes, and verify is not one of them', () => {
    expect(TOOLS.map((tool) => tool.name)).toStrictEqual([
      'recall',
      'remember',
      'supersede',
      'forget',
      'inspect',
    ]);
    expect(findTool('verify')).toBeUndefined();
  });

  // `dispatch` casts the parsed arguments to the shape it expects FOR THAT NAME. If a tool were
  // ever paired with another tool's schema, that cast would still typecheck and the repository
  // would be handed an object with every field undefined. Nothing else in the build catches it.
  it('pairs every tool with the schema registered under its own name', () => {
    for (const tool of TOOLS) {
      expect(tool.schema).toBe(SCHEMAS[tool.name]);
    }
    expect(TOOLS.map((tool) => tool.name).sort()).toStrictEqual(Object.keys(SCHEMAS).sort());
  });

  it('marks exactly the writing tools as writes, which is what the audit log keys on', () => {
    const writers = TOOLS.filter((tool) => tool.writes).map((tool) => tool.name);
    expect(writers).toStrictEqual(['remember', 'supersede']);
  });

  it('does not promise a capability forget does not have', () => {
    const forget = findTool('forget');
    expect(forget?.description).toMatch(/NOT YET CONNECTED/);
    expect(forget?.description).not.toMatch(/tombstone with a reason\./i);
  });
});

describe('parseToolCall', () => {
  it('refuses a tool it does not have, by name, and lists the ones it does', () => {
    const parsed = parseToolCall('search_memory', { query: 'anything' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) expect.unreachable('an invented tool name must be refused');
    expect(parsed.reason).toContain('There is no tool called "search_memory"');
    expect(parsed.reason).toContain('recall, remember, supersede, forget, inspect');
  });

  it('accepts a well formed recall and hands back the parsed arguments', () => {
    const parsed = parseToolCall('recall', { query: '  checkout latency  ', limit: 5 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) expect.unreachable('a well formed recall must parse');
    expect(parsed.args).toStrictEqual({ query: 'checkout latency', limit: 5 });
    expect(parsed.tool.name).toBe('recall');
  });

  // Provenance is the one thing a write cannot default. "agent" would be a lie about who asserted
  // it, and the database refuses it a second time, which is the point of two layers.
  it.each([
    ['a missing assertedBy', { kind: 'observation', content: 'the pods restarted' }],
    ['an empty assertedBy', { kind: 'observation', content: 'x', assertedBy: '' }],
    ['a whitespace assertedBy', { kind: 'observation', content: 'x', assertedBy: '   ' }],
  ])('refuses a remember with %s', (_label, args) => {
    const parsed = parseToolCall('remember', args);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) expect.unreachable('a write with no provenance must be refused');
    expect(parsed.reason).toMatch(/provenance|assertedBy/i);
  });

  it.each([
    ['recall with no query', 'recall', {}],
    ['recall with an empty query', 'recall', { query: '   ' }],
    ['recall with a limit above the cap', 'recall', { query: 'x', limit: 21 }],
    ['recall with a fractional limit', 'recall', { query: 'x', limit: 1.5 }],
    ['remember with an unknown kind', 'remember', { kind: 'guess', content: 'x', assertedBy: 'a' }],
    ['forget with no reason', 'forget', { memoryId: MEMORY_ID_A }],
    ['forget with an id that is not a uuid', 'forget', { memoryId: 'INC-42', reason: 'wrong' }],
    ['inspect with an id that is not a uuid', 'inspect', { memoryId: 'the first one' }],
    ['supersede with a non uuid previousId', 'supersede', {
      previousId: 'latest',
      kind: 'resolution',
      content: 'x',
      assertedBy: 'a',
    }],
  ])('refuses %s', (_label, name, args) => {
    const parsed = parseToolCall(name, args);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) expect.unreachable(`${name} must refuse these arguments`);
    expect(parsed.reason).toContain(`do not fit ${name}`);
  });

  it('accepts every kind the memory layer defines, so the two cannot drift apart', () => {
    for (const kind of MEMORY_KINDS) {
      const parsed = parseToolCall('remember', { kind, content: 'x', assertedBy: 'human:ana' });
      expect(parsed.ok, `kind ${kind} must be accepted`).toBe(true);
    }
  });
});

describe('renderRecall puts the verdict first', () => {
  // CONTROL 1. Order is the mechanism. There must be no arrangement of this text in which a model
  // reads memories before it reads whether the search ran.
  it.each(['COVERED', 'PARTIAL', 'UNKNOWN'] as const)(
    'leads with the coverage line under %s',
    (coverage) => {
      const rendered = renderRecall(recallResult({ coverage, memories: [scoredMemory()] }));
      expect(rendered.split('\n')[0]).toBe(
        `COVERAGE: ${coverage}. the search ran over the whole workspace`,
      );
    },
  );

  it('renders no memory at all when the search did not run, even though it was handed some', () => {
    // The fixture is deliberately self contradictory: an UNKNOWN receipt carrying a memory. That
    // combination is what a partial failure downstream would look like, and the answer has to be
    // that nothing gets shown, not that the verdict is quietly believed over the payload.
    const rendered = renderRecall(
      recallResult({ coverage: 'UNKNOWN', memories: [scoredMemory()] }),
    );
    expect(rendered).not.toContain(MEMORY_ID_A);
    expect(rendered).not.toContain('Restarting the checkout pods');
    expect(rendered).toContain('this is not an empty result');
    expect(rendered).toContain('You must not say that there are no prior incidents');
  });

  // The allowlist. A denylist on the literal 'UNKNOWN' fails OPEN on any value a later migration
  // adds, and failing open here means rendering memories under a verdict nobody recognised.
  it('treats a coverage value it does not recognise as a search that did not run', () => {
    const rendered = renderRecall(
      recallResult({ coverage: 'unknown' as Coverage, memories: [scoredMemory()] }),
    );
    expect(rendered).not.toContain(MEMORY_ID_A);
    expect(rendered).toContain('The search did not run');
  });

  it('separates a real absence from a failed one', () => {
    const rendered = renderRecall(recallResult({ coverage: 'COVERED', memories: [] }));
    expect(rendered).toContain('No memory matched. The search did run, so this is a real absence.');
  });

  it('warns that a PARTIAL result is real but incomplete', () => {
    const rendered = renderRecall(
      recallResult({ coverage: 'PARTIAL', memories: [scoredMemory()] }),
    );
    expect(rendered).toContain('PARTIAL means the search was cut short');
    expect(rendered).toContain(MEMORY_ID_A);
  });

  it('reports what was excluded, under which rule, and what degraded', () => {
    const rendered = renderRecall(
      recallResult({
        memories: [scoredMemory()],
        candidatesConsidered: 40,
        exclusions: [{ rule: 'superseded', count: 3 }, { rule: 'not_embedded', count: 2 }],
        degradations: ['the vector index was unavailable, so an exact scan ran instead'],
      }),
    );
    expect(rendered).toContain('The search ran over 40 candidate memories');
    expect(rendered).toContain('Excluded: 3 superseded, 2 not embedded.');
    expect(rendered).toContain('Degraded: the vector index was unavailable');
  });

  it('names the retrieval path rather than describing every search the same way', () => {
    const ann = renderRecall(recallResult({ retrievalPath: 'ann_index', memories: [scoredMemory()] }));
    const scan = renderRecall(recallResult({ retrievalPath: 'exact_scan', memories: [scoredMemory()] }));
    expect(ann).toContain('the approximate vector index');
    expect(scan).toContain('an exact scan');
  });
});

describe('renderMemory shows what decides whether to trust a memory', () => {
  it('carries provenance, dates and the id', () => {
    const rendered = renderMemory(memoryRecord());
    expect(rendered).toContain('[resolution] Restarting the checkout pods cleared the latency spike.');
    expect(rendered).toContain(`id ${MEMORY_ID_A}`);
    expect(rendered).toContain('asserted by human:oncall-ana during INC-42');
  });

  it('flags a stale memory rather than hiding it', () => {
    const rendered = renderMemory(memoryRecord(), 0.42, true);
    expect(rendered).toContain('STALE');
    expect(rendered).toContain('similarity 0.420');
  });

  it('says when a memory was superseded or tombstoned', () => {
    const superseded = renderMemory(memoryRecord({ supersededBy: MEMORY_ID_B }));
    expect(superseded).toContain(`SUPERSEDED by ${MEMORY_ID_B}`);

    const tombstoned = renderMemory(
      memoryRecord({ evictedAt: new Date('2026-08-05T13:00:00Z'), evictionReason: 'wrong runbook' }),
    );
    expect(tombstoned).toContain('TOMBSTONED: wrong runbook');
  });

  it('reports confirmations only when there are any', () => {
    expect(renderMemory(memoryRecord())).not.toContain('confirmed 0 times');
    expect(renderMemory(memoryRecord({ confirmCount: 3 }))).toContain(
      'confirmed 3 times, contradicted 0',
    );
  });
});

describe('claimsAbsence', () => {
  it.each([
    'There are no prior incidents like this.',
    'I found no similar incident in the archive.',
    'Nothing found in the incident memory.',
    'Nothing was found matching that.',
    'Nothing has been found on record.',
    'This has never happened before.',
    'That failure was never seen on this cluster.',
    'There is no record of that outage.',
    'There were no memories about checkout.',
    'We have no history of this alert.',
  ])('catches %j', (text) => {
    expect(claimsAbsence(text)).toBe(true);
  });

  // The deliberate gaps, asserted rather than left to be discovered. Two families are out ON
  // PURPOSE: "I could not find anything" is an accurate description of a failed search, and
  // refusing it would train the next author to loosen the rule until it refuses nothing. Recording
  // them here means a future widening is a decision someone makes, not a surprise.
  it.each([
    'I could not find anything relevant.',
    'Zero matches came back.',
    'The archive is empty for that query.',
    'I am not able to say whether this happened before.',
  ])('deliberately does not catch %j', (text) => {
    expect(claimsAbsence(text)).toBe(false);
  });

  it('does not fire on an ordinary answer that merely mentions memory', () => {
    expect(
      claimsAbsence('Memory 1111 records that restarting the pods fixed this on 2 August.'),
    ).toBe(false);
  });
});

describe('mayAssertAbsence', () => {
  it.each([
    ['COVERED', true],
    ['PARTIAL', false],
    ['UNKNOWN', false],
  ])('permits an absence claim under %s: %s', (coverage, expected) => {
    expect(mayAssertAbsence(coverage as Coverage)).toBe(expected);
  });

  it('refuses a verdict it does not recognise, rather than treating it as good enough', () => {
    expect(mayAssertAbsence('covered' as Coverage)).toBe(false);
  });
});

describe('the schema table', () => {
  it('names every tool exactly once', () => {
    const names = Object.keys(SCHEMAS) as ToolName[];
    expect(new Set(names).size).toBe(names.length);
  });
});
