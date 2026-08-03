import { describe, expect, it } from 'vitest';
import { formatVector, parseVector, rowToMemory, type MemoryRow } from '../src/rows.ts';
import { createRepository } from '../src/repository.ts';
import { createLocalEmbedder, embedSync, type Embedder } from '../src/embeddings.ts';
import { observed, type Capabilities } from '../src/types.ts';
import { createFakeDatabase, mentions, type Responder } from './fake-database.ts';

const CAPABILITIES: Capabilities = {
  observedAt: new Date('2026-08-03T12:00:00Z'),
  target: 'fake',
  serverVersion: observed('CockroachDB CCL v26.2.1'),
  vectorColumnDimensions: observed(8),
  embedderDimensions: observed(8),
  vectorIndex: observed(true),
  annPlanUsesIndex: observed(true),
  vectorIndexingEnabled: observed(true),
};

const QUERY_TEXT = 'payment deploy checkout latency';

/**
 * An embedding that genuinely MATCHES the query text.
 *
 * The fixtures previously used an arbitrary vector, which scored exactly 0.5 against a 0.6 floor,
 * so every candidate was excluded and two `toHaveLength(0)` assertions could not fail for the
 * reason they named. Deriving the fixture from the query means a returned memory can be asserted,
 * which is the case the suite was missing entirely.
 */
const MATCHING_EMBEDDING = formatVector(embedSync(QUERY_TEXT, 8));

const row = (overrides: Partial<MemoryRow> = {}): MemoryRow => ({
  id: '11111111-1111-1111-1111-111111111111',
  workspace_id: 'demo',
  kind: 'resolution',
  content: 'rolling back the payment deploy fixed checkout latency',
  embedding: MATCHING_EMBEDDING,
  embedding_model: 'local-token-hash-v1:8',
  asserted_by: 'human:oncall-ana',
  incident_id: 'INC-1042',
  source_ref: null,
  created_at: new Date('2026-08-01T00:00:00Z'),
  last_confirmed_at: new Date('2026-08-01T00:00:00Z'),
  confirm_count: '0',
  contradict_count: '0',
  valid_from: new Date('2026-08-01T00:00:00Z'),
  valid_until: null,
  superseded_by: null,
  protected_until: new Date('2026-08-02T00:00:00Z'),
  evicted_at: null,
  eviction_reason: null,
  ...overrides,
});

describe('vector round trip', () => {
  it('survives a round trip through the text form', () => {
    const values = [0.5, -0.25, 0];
    expect(parseVector(formatVector(values))).toEqual(values);
  });

  it('treats a null column as a memory that has not been embedded', () => {
    // A real state: the write had to be recorded even though the embedder was down.
    expect(parseVector(null)).toBeNull();
  });

  it('refuses a non-finite component instead of poisoning every later distance', () => {
    // NaN in an embedding makes every distance it takes part in NaN, and the resulting ranking
    // looks plausible rather than broken.
    expect(() => formatVector([1, Number.NaN, 3])).toThrow(/non-finite/);
    expect(() => parseVector('[1,abc,3]')).toThrow(/not a finite number/);
  });

  it('refuses an empty embedding and a malformed one', () => {
    expect(() => formatVector([])).toThrow(/empty embedding/);
    expect(() => parseVector('0.1,0.2')).toThrow(/\[a,b,c\] form/);
  });
});

describe('rowToMemory', () => {
  it('parses INT8 counters that arrive as strings', () => {
    // The pg driver returns INT8 as a string, because 64 bits do not fit a JS number safely.
    // Without an explicit conversion, `confirmCount + 1` silently produces "01".
    const memory = rowToMemory(row({ confirm_count: '3', contradict_count: '1' }));
    expect(memory.confirmCount).toBe(3);
    expect(memory.contradictCount).toBe(1);
  });

  it('refuses a kind the code does not know rather than coercing it', () => {
    // Reaching here means the database CHECK and MEMORY_KINDS have diverged, which is worth
    // failing on: a memory silently retyped would decay at the wrong rate.
    expect(() => rowToMemory(row({ kind: 'gossip' }))).toThrow(/does not know/);
  });

  it('carries provenance through as a structure, not loose columns', () => {
    const memory = rowToMemory(row());
    expect(memory.provenance).toEqual({
      assertedBy: 'human:oncall-ana',
      incidentId: 'INC-1042',
      sourceRef: null,
    });
  });
});

describe('recall', () => {
  const embedder = createLocalEmbedder(8);

  const respond =
    (candidateRows: MemoryRow[], counts = { tombstoned: '0', unembedded: '0' }): Responder =>
    (text) => {
      if (mentions(text, 'count(*) filter')) return [counts];
      if (mentions(text, 'select', 'from', 'order by embedding')) return candidateRows;
      return [];
    };

  const build = (responder: Responder, override?: Embedder) =>
    createRepository({
      db: createFakeDatabase(responder),
      embedder: override ?? embedder,
      schema: 'throughline',
      capabilities: CAPABILITIES,
    });

  it('returns UNKNOWN and no rows when the embedder fails', async () => {
    // The canonical UNKNOWN. It is not an empty result and it is not a reason to substitute a
    // weaker embedder, which would produce confident answers from a different measurement.
    const failing: Embedder = {
      id: 'broken',
      dimensions: 8,
      embed: () => Promise.reject(new Error('provider unreachable')),
    };
    const result = await build(respond([]), failing).recall({ workspaceId: 'demo', text: 'anything' });

    expect(result.receipt.coverage).toBe('UNKNOWN');
    expect(result.memories).toHaveLength(0);
    expect(result.receipt.coverageReason).toMatch(/embedding provider failed/i);
    expect(result.receipt.retrievalPath).toBe('none');
  });

  it('returns UNKNOWN when the candidate query itself fails', async () => {
    const result = await build((text) => {
      if (mentions(text, 'count(*) filter')) return [{ tombstoned: '0', unembedded: '0' }];
      if (mentions(text, 'order by embedding')) throw new Error('statement timeout');
      return [];
    }).recall({ workspaceId: 'demo', text: 'anything' });

    expect(result.receipt.coverage).toBe('UNKNOWN');
    expect(result.receipt.coverageReason).toMatch(/candidate query failed/i);
  });

  it('excludes a superseded memory and counts the exclusion', async () => {
    const result = await build(
      respond([row({ superseded_by: '22222222-2222-2222-2222-222222222222' })]),
    ).recall({ workspaceId: 'demo', text: 'payment deploy checkout latency' });

    expect(result.memories).toHaveLength(0);
    expect(result.receipt.exclusions).toContainEqual({ rule: 'superseded', count: 1 });
    // Counted, not hidden: the receipt has to be able to say why nothing came back.
    expect(result.receipt.candidatesConsidered).toBe(1);
  });

  it('excludes a memory whose validity window has closed', async () => {
    const result = await build(
      respond([row({ valid_until: new Date('2026-08-02T00:00:00Z') })]),
    ).recall({
      workspaceId: 'demo',
      text: 'payment deploy checkout latency',
      now: new Date('2026-08-03T00:00:00Z'),
    });

    expect(result.receipt.exclusions).toContainEqual({ rule: 'outside_validity_window', count: 1 });
  });

  it('reports tombstoned and unembedded rows the candidate query cannot see', async () => {
    // Those rows are filtered in SQL, because is_live is an index prefix and moving the filter
    // into the application would cost the ANN path. They can therefore never reach the scoring
    // loop, so a separate aggregate is what stops the receipt quietly omitting them.
    const result = await build(
      respond([row()], { tombstoned: '4', unembedded: '2' }),
    ).recall({ workspaceId: 'demo', text: 'payment deploy checkout latency' });

    expect(result.receipt.exclusions).toContainEqual({ rule: 'tombstoned', count: 4 });
    expect(result.receipt.exclusions).toContainEqual({ rule: 'not_embedded', count: 2 });
  });

  it('marks the exact-scan path as a degradation rather than staying quiet', async () => {
    const degraded = createRepository({
      db: createFakeDatabase(respond([row()])),
      embedder,
      schema: 'throughline',
      capabilities: { ...CAPABILITIES, annPlanUsesIndex: observed(false), vectorIndex: observed(false) },
    });
    const result = await degraded.recall({ workspaceId: 'demo', text: 'payment deploy' });

    expect(result.receipt.retrievalPath).toBe('exact_scan');
    expect(result.receipt.degradations).toHaveLength(1);
    expect(result.receipt.degradations[0]).toMatch(/no vector index/i);
  });

  it('returns the matching memory and reports it as covered', async () => {
    // The case the suite did not have: an actual returned memory. Without it, `.slice(0, limit)`
    // could be replaced by `.slice(0, 0)` and everything still passed.
    const result = await build(respond([row()])).recall({ workspaceId: 'demo', text: QUERY_TEXT });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.memory.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(result.memories[0]?.similarity).toBeGreaterThan(0.6);
    expect(result.receipt.coverage).toBe('COVERED');
    expect(result.receipt.returned).toBe(1);
  });

  it('honours the limit rather than returning everything it scored', async () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      row({ id: `1111111${index}-1111-1111-1111-111111111111` }),
    );
    const result = await build(respond(many)).recall({
      workspaceId: 'demo',
      text: QUERY_TEXT,
      limit: 2,
    });

    expect(result.memories).toHaveLength(2);
    expect(result.receipt.returned).toBe(2);
    // The receipt must still admit how many were examined, not just how many came back.
    expect(result.receipt.candidatesConsidered).toBe(5);
  });

  it('scopes the candidate query to one workspace', async () => {
    // Asserting on the QUERY, because a missing workspace filter is a cross-workspace data leak
    // that no fixture-based assertion would notice: the fake returns the same rows either way.
    const db = createFakeDatabase(respond([row()]));
    await createRepository({
      db,
      embedder,
      schema: 'throughline',
      capabilities: CAPABILITIES,
    }).recall({ workspaceId: 'demo', text: QUERY_TEXT });

    const candidateQuery = db.texts().find((text) => mentions(text, 'order by embedding'));
    expect(candidateQuery).toBeDefined();
    expect(candidateQuery).toContain('workspace_id = $1');
    expect(candidateQuery).toContain('is_live');
  });

  it('omits the IS NOT NULL filter on the ANN path and adds it on an exact scan', async () => {
    // CockroachDB sorts NULLs FIRST by default, so unembedded rows would eat the candidate cap on a
    // plain scan. The filter that fixes it turns the ANN plan into a full scan, and the ANN index
    // does not contain NULL vectors anyway. Both measured on a live cluster, hence the asymmetry.
    const annDb = createFakeDatabase(respond([row()]));
    await createRepository({
      db: annDb,
      embedder,
      schema: 'throughline',
      capabilities: CAPABILITIES,
    }).recall({ workspaceId: 'demo', text: QUERY_TEXT });

    const scanDb = createFakeDatabase(respond([row()]));
    await createRepository({
      db: scanDb,
      embedder,
      schema: 'throughline',
      capabilities: { ...CAPABILITIES, annPlanUsesIndex: observed(false), vectorIndex: observed(false) },
    }).recall({ workspaceId: 'demo', text: QUERY_TEXT });

    const annQuery = annDb.texts().find((text) => mentions(text, 'order by embedding')) ?? '';
    const scanQuery = scanDb.texts().find((text) => mentions(text, 'order by embedding')) ?? '';

    expect(annQuery).not.toContain('embedding is not null');
    expect(scanQuery.toLowerCase()).toContain('embedding is not null');
  });

  it('scopes the eviction candidate query to one workspace and to live rows', async () => {
    // Its own test, because the eviction SELECT is a SECOND place the workspace filter lives. A
    // mutation harness anchored on the shared SQL fragment hit this statement instead of the
    // candidate query and reported the wrong verdict, which is how the gap surfaced.
    const db = createFakeDatabase(respond([]));
    await createRepository({
      db,
      embedder,
      schema: 'throughline',
      capabilities: CAPABILITIES,
    }).evict('demo', 1);

    const evictionQuery = db
      .texts()
      .find((text) => mentions(text, 'select', 'from', 'where') && !mentions(text, 'order by embedding'));
    expect(evictionQuery).toBeDefined();
    expect(evictionQuery).toContain('workspace_id = $1');
    expect(evictionQuery).toContain('is_live');
  });

  it('refuses a write with no provenance before it reaches the database', async () => {
    const repository = build(respond([]));
    await expect(
      repository.remember({
        workspaceId: 'demo',
        kind: 'observation',
        content: 'anonymous claim',
        provenance: { assertedBy: '  ', incidentId: null, sourceRef: null },
      }),
    ).rejects.toThrow(/needs provenance/i);
  });
});
