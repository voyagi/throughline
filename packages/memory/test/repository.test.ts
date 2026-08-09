import { describe, expect, it } from 'vitest';
import { formatVector, parseVector, rowToMemory, type MemoryRow } from '../src/rows.ts';
import { createRepository } from '../src/repository.ts';
import { createLocalEmbedder, embedSync, type Embedder } from '../src/embeddings.ts';
import { observed, type Capabilities } from '../src/types.ts';
import { DEFAULT_POLICY, type MemoryPolicy } from '../src/policy.ts';
import { describeCoverage } from '../src/coverage.ts';
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

  it('tells the embedder it is embedding a QUERY, not a document', async () => {
    // Some hosted models embed stored documents and search queries into deliberately different
    // spaces, so asking for the wrong one degrades retrieval while failing nothing: right width,
    // finite values, every guard green. Nothing else in the suite can catch a dropped argument.
    // The local embedder ignores purpose, the other doubles ignore their arguments, and the
    // parameter is optional so the compiler is silent too.
    const seen: (string | undefined)[] = [];
    const recorder: Embedder = {
      id: 'recorder',
      dimensions: 8,
      embed: (text, purpose) => {
        seen.push(purpose);
        return embedder.embed(text);
      },
    };
    await build(respond([]), recorder).recall({ workspaceId: 'demo', text: 'anything' });

    expect(seen).toEqual(['query']);
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

  /**
   * The same repository with a policy of its own and the fake database exposed.
   *
   * A SECOND BUILDER rather than a third parameter on the one above, whose second parameter is an
   * embedder that every existing call site passes positionally.
   */
  const buildWith = (responder: Responder, policy: MemoryPolicy) => {
    const db = createFakeDatabase(responder);
    return {
      db,
      repository: createRepository({
        db,
        embedder,
        schema: 'throughline',
        capabilities: CAPABILITIES,
        policy,
      }),
    };
  };

  /** The bound the candidate query actually ran with, read off the driver rather than inferred. */
  const candidateBound = (db: ReturnType<typeof createFakeDatabase>): unknown =>
    db.queries.find((query) => mentions(query.text, 'order by embedding'))?.values.at(-1);

  /** `count` candidates that all score, so a bound has something to bite on. */
  const candidates = (count: number): MemoryRow[] =>
    Array.from({ length: count }, (_unused, index) =>
      row({ id: `1111111${index}-1111-1111-1111-111111111111` }),
    );

  // THE CANDIDATE CAP, which this path trusted exactly the way the listing path used to trust
  // `listCap`. `policy` is public on `createRepository`, the cap went to the driver raw, and the
  // PARTIAL test compared `rows.length` against that same raw value, so a cap of 0 made `0 >= 0`
  // TRUE and the receipt reported PARTIAL reading "The candidate cap of 0 was reached" over nothing
  // examined at all. `decideCoverage` is tested exhaustively and was never the problem: it was told
  // the cap had been reached, and it said so.
  it.each([
    ['zero', 0],
    ['a negative', -10],
    ['a fraction below one', 0.5],
    // All three non-finite values, because the arm takes three. `Infinity` is the likeliest to be
    // written on purpose, as the natural spelling of "examine everything".
    ['not a number at all', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('floors a candidateCap of %s to a bound that can hold a candidate', async (_label, candidateCap) => {
    const { db, repository } = buildWith(respond([row()]), { ...DEFAULT_POLICY, candidateCap });
    const result = await repository.recall({ workspaceId: 'demo', text: QUERY_TEXT });

    expect(candidateBound(db)).toBe(1);
    // PARTIAL is the honest verdict here, and it now arrives with the candidate that makes the
    // sentence true rather than over an empty examination.
    expect(result.receipt.candidatesConsidered).toBe(1);
    expect(result.receipt.coverage).toBe('PARTIAL');
    expect(result.receipt.coverageReason).toContain('candidate cap of 1 was reached');
  });

  it('floors a fractional candidateCap rather than handing the driver a fraction', async () => {
    // Separate from the table because the expectation differs in kind: this pins the `Math.floor`,
    // which a bare `Math.max(1, cap)` would pass while still sending 7.9 to the driver.
    const { db, repository } = buildWith(respond(candidates(3)), { ...DEFAULT_POLICY, candidateCap: 7.9 });
    await repository.recall({ workspaceId: 'demo', text: QUERY_TEXT });

    expect(candidateBound(db)).toBe(7);
  });

  it('still reports a COVERED empty workspace under a floored candidate cap', async () => {
    // The floor must not turn an empty workspace into a truncated search. THE INVARIANT, stated as
    // the thing that must never travel: PARTIAL with nothing examined. Both the console and the
    // agent read PARTIAL as "what came back is real and incomplete", and nothing came back.
    const { repository } = buildWith(respond([]), { ...DEFAULT_POLICY, candidateCap: 0 });
    const result = await repository.recall({ workspaceId: 'demo', text: QUERY_TEXT });

    expect(result.receipt.candidatesConsidered).toBe(0);
    expect(result.receipt.coverage).toBe('COVERED');
    expect(result.receipt.coverageReason).not.toContain('candidate cap');
  });

  // THE CALLER'S OWN BOUND, which had no clamp at all: `query.limit ?? 5` straight into
  // `.slice(0, limit)`. Five is written here rather than imported because it is the default a
  // caller observes, and a test that imported the constant would agree with the source by
  // construction whatever either of them said.
  it.each([
    ['a fraction', 2.7, 2],
    ['zero', 0, 5],
    ['a negative', -3, 5],
    ['not a number at all', Number.NaN, 5],
    ['a fraction below one', 0.5, 5],
    ['infinity', Number.POSITIVE_INFINITY, 5],
    ['negative infinity', Number.NEGATIVE_INFINITY, 5],
  ])('reads a limit of %s as no preference rather than as a bound', async (_label, requested, expected) => {
    const result = await build(respond(candidates(6))).recall({
      workspaceId: 'demo',
      text: QUERY_TEXT,
      limit: requested,
    });

    expect(result.memories).toHaveLength(expected);
    expect(result.receipt.returned).toBe(expected);
  });

  it('never leads with an absence it did not establish when the bound was unusable', async () => {
    // THE SENTENCE THIS PROTECTS IS GENERATED RATHER THAN WRITTEN BY THE MODEL, which is the whole
    // reason it cannot be softened, and under a bound of zero it was the one sentence in the system
    // able to state an absence nobody established. `.slice(0, 0)` returns nothing while the receipt
    // still reports every candidate examined, so COVERED arrived with `returned: 0` and the agent
    // was handed "I searched the whole workspace and found nothing relevant" over six candidates
    // that all scored. A negative bound is worse: `.slice(0, -3)` drops the last three and returns
    // the rest, so asking for fewer than none returns a page.
    const result = await build(respond(candidates(6))).recall({
      workspaceId: 'demo',
      text: QUERY_TEXT,
      limit: 0,
    });

    expect(result.receipt.candidatesConsidered).toBe(6);
    expect(result.memories.length).toBeGreaterThan(0);
    expect(describeCoverage(result)).not.toContain('found nothing relevant');
    expect(describeCoverage(result)).toContain('the search was complete');
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

});

/**
 * `remember`, under its own heading.
 *
 * These two lived under `describe('recall')`, which made the insert path look covered by a heading
 * it has nothing to do with. (`scopes the eviction candidate query…` above is still there and is an
 * `evict` test; it predates this branch and is left alone rather than swept up.)
 */
describe('remember', () => {
  const embedder = createLocalEmbedder(8);

  // THE INSERT PATH HAD NO TEST AT ALL, which is how an off-by-one planted in `insertSql` survived a
  // fully green suite. It runs inside a transaction, and the fake database used to hand transactions
  // an empty object, so every statement `remember` and `supersede` issue was invisible: unrecorded,
  // unchecked, and never executed by any test.
  it('writes the memory and its audit row in one transaction, with matching placeholders', async () => {
    const db = createFakeDatabase((text) => {
      if (mentions(text, 'insert into', 'returning')) return [row()];
      return [];
    });
    const repository = createRepository({ db, embedder, schema: 'throughline', capabilities: CAPABILITIES });

    const memory = await repository.remember({
      workspaceId: 'demo',
      kind: 'resolution',
      content: 'rolling back the payment deploy fixed checkout latency',
      provenance: { assertedBy: 'human:oncall-ana', incidentId: 'INC-1042', sourceRef: null },
      embedding: embedSync('payment deploy', 8),
    });

    expect(memory.id).toBe('11111111-1111-1111-1111-111111111111');

    const insert = db.queries.find((query) => mentions(query.text, 'insert into', 'memory', 'returning'));
    const auditRow = db.queries.find((query) => mentions(query.text, 'insert into', 'memory_audit'));
    expect(insert).toBeDefined();
    expect(auditRow).toBeDefined();

    // BOTH INSIDE THE TRANSACTION - and until `via` existed this fixture could not say that. A
    // review moved the audit write back OUTSIDE `db.transaction`, which is exactly the defect the
    // sentence used to describe, and the file stayed at 40/40 green: every statement went into one
    // array with no record of which client issued it. The old assertions were two text `some()`
    // checks and a count, all of which the defect satisfies. What is at stake is that a failing
    // audit insert leaves a memory with no audit trail and a caller who retries into a duplicate.
    expect(insert?.via).toBe('tx');
    expect(auditRow?.via).toBe('tx');

    // The audit row points AT the memory it audits and names the operation `memory_audit`'s CHECK
    // constraint permits. Both were unasserted and both survived being changed: `memory_id` to null,
    // and the operation to `evict`. `memory_id` is the second bind; the operation is a SQL literal
    // in this statement rather than a parameter, so it is asserted in the text.
    expect(auditRow?.values[1]).toBe(memory.id);
    expect(auditRow?.text).toContain("'remember'");

    // `createFakeDatabase` refuses a placeholder that does not match its parameters, so reaching this
    // line at all is the assertion that the insert's eleven bind parameters line up.
    expect(db.queries).toHaveLength(2);
  });

  it('refuses a write with no provenance before it reaches the database', async () => {
    const repository = createRepository({
      db: createFakeDatabase(() => []),
      embedder,
      schema: 'throughline',
      capabilities: CAPABILITIES,
    });
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

describe('list', () => {
  const embedder = createLocalEmbedder(8);

  /** Answers the listing statement with the given rows and nothing else. */
  const listing =
    (rows: MemoryRow[]): Responder =>
    (text) => {
      if (mentions(text, 'select', 'from', 'order by created_at desc')) return rows;
      return [];
    };

  const build = (responder: Responder, policy?: MemoryPolicy) => {
    const db = createFakeDatabase(responder);
    return {
      db,
      // Spread rather than `policy` as a plain property: `exactOptionalPropertyTypes` is on, so an
      // explicit `undefined` for an optional property does not compile.
      repository: createRepository({
        db,
        embedder,
        schema: 'throughline',
        capabilities: CAPABILITIES,
        ...(policy === undefined ? {} : { policy }),
      }),
    };
  };

  /** `count` rows with distinct ids, so a total ordering has something to order. */
  const rows = (count: number): MemoryRow[] =>
    Array.from({ length: count }, (_unused, index) =>
      row({ id: `1111111${index}-1111-1111-1111-111111111111` }),
    );

  it('returns rows with a receipt, and the receipt reports the filter that was applied', async () => {
    const { repository } = build(listing(rows(2)));
    const page = await repository.list({ workspaceId: 'demo', kinds: ['resolution'] });

    expect(page.memories).toHaveLength(2);
    expect(page.receipt.returned).toBe(2);
    expect(page.receipt.coverage).toBe('COVERED');
    expect(page.receipt.coverageCause).toBeNull();
    // Reported back so a reader of an EMPTY page can tell a filter nobody applied from one that
    // excluded everything.
    expect(page.receipt.kinds).toEqual(['resolution']);
  });

  it('reports PARTIAL only when a row beyond the bound actually exists', async () => {
    // THE DISCRIMINATING CASE, and the reason the implementation asks for `limit + 1`. An archive
    // holding EXACTLY the bound is COVERED: `returned === limit` is not evidence of more, and a
    // version that inferred PARTIAL from it would call a complete archive truncated forever.
    const exactly = build(listing(rows(3)));
    const atBound = await exactly.repository.list({ workspaceId: 'demo', limit: 3 });
    expect(atBound.memories).toHaveLength(3);
    expect(atBound.receipt.coverage).toBe('COVERED');

    // One more row exists, so the same bound is PARTIAL. The probe row is NOT returned.
    const more = build(listing(rows(4)));
    const overBound = await more.repository.list({ workspaceId: 'demo', limit: 3 });
    expect(overBound.memories).toHaveLength(3);
    expect(overBound.receipt.returned).toBe(3);
    expect(overBound.receipt.coverage).toBe('PARTIAL');
    // PARTIAL is a bound that was reached, NOT a stage that failed, so there is no cause.
    expect(overBound.receipt.coverageCause).toBeNull();
  });

  it('asks the database for one row more than the bound', async () => {
    const { db, repository } = build(listing(rows(1)));
    await repository.list({ workspaceId: 'demo', limit: 5 });
    // The bound is the LAST parameter on the unfiltered statement. Asserting the value rather than
    // the SQL text, because the whole point is the number that reaches the database.
    expect(db.queries[0]?.values.at(-1)).toBe(6);
  });

  it('clamps a caller bound to the policy cap and reports the bound it applied', async () => {
    const { db, repository } = build(listing(rows(1)));
    const page = await repository.list({ workspaceId: 'demo', limit: 100_000 });

    expect(page.receipt.limit).toBe(DEFAULT_POLICY.listCap);
    expect(db.queries[0]?.values.at(-1)).toBe(DEFAULT_POLICY.listCap + 1);
  });

  // THE CAP ITSELF, which the clamp above took on trust. Two of `boundedLimit`'s three paths
  // returned `cap` verbatim and the third returned it whenever the caller asked for more, so the
  // same self-contradicting bound of zero came straight back in through the policy: `policy` is
  // public on `createRepository`, the probe still fetches one row, `rows.length > 0` holds, and the
  // receipt reported PARTIAL with `returned: 0` while its own reason claimed the archive holds more
  // than 0 rows. No caller OVERRIDES `listCap` (one of the seven non-test call sites does pass a
  // policy, spreading `DEFAULT_POLICY` and changing `graceWindowMs`), which is exactly what made
  // this an accident of who calls the function rather than a property of it.
  //
  // Both sentences above were wrong in the first version of this comment, in the same two ways the
  // source docblock was, and were corrected there while this copy stood six lines from an edit. A
  // comment is not re-driven by anything, so a second copy of a claim is a second thing to get wrong.
  it.each([
    ['zero', 0],
    ['a negative', -10],
    ['a fraction below one', 0.5],
    // ALL THREE NON-FINITE VALUES, because the arm takes three and the first version of this table
    // named one. `Infinity` is the likeliest of them to be written on purpose, as the natural
    // spelling of "unbounded", and it used to reach the driver as `LIMIT Infinity`.
    ['not a number at all', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('floors a listCap of %s to a bound that can hold a row', async (_label, listCap) => {
    const { db, repository } = build(listing(rows(4)), { ...DEFAULT_POLICY, listCap });
    const page = await repository.list({ workspaceId: 'demo' });

    expect(page.receipt.limit).toBe(1);
    expect(db.queries[0]?.values.at(-1)).toBe(2);
    // The invariant, stated as the thing that must never travel: PARTIAL with an empty page. The
    // archive really does hold more than this bound, so PARTIAL is the honest verdict here, and it
    // now arrives with the row that makes the sentence true.
    expect(page.memories).toHaveLength(1);
    expect(page.receipt.returned).toBe(1);
    expect(page.receipt.coverage).toBe('PARTIAL');
  });

  it('floors a fractional listCap rather than handing the driver a fraction', async () => {
    // Separate from the table above because the expectation is different in kind: this one pins the
    // `Math.floor`, which a bare `Math.max(1, cap)` would pass while still sending 7.9 to the driver.
    const { db, repository } = build(listing(rows(1)), { ...DEFAULT_POLICY, listCap: 7.9 });
    const page = await repository.list({ workspaceId: 'demo' });

    expect(page.receipt.limit).toBe(7);
    expect(db.queries[0]?.values.at(-1)).toBe(8);
  });

  it('still reports a COVERED empty archive under a floored cap', async () => {
    // The floor must not turn an empty archive into a truncated one. Nothing was there, the bound
    // was never reached, and COVERED with no rows is the page's one honest absence claim.
    const { repository } = build(listing([]), { ...DEFAULT_POLICY, listCap: 0 });
    const page = await repository.list({ workspaceId: 'demo' });

    expect(page.memories).toHaveLength(0);
    expect(page.receipt.coverage).toBe('COVERED');
  });

  it.each([
    ['a fraction', 2.7, 2],
    ['zero', 0, DEFAULT_POLICY.listCap],
    ['a negative', -5, DEFAULT_POLICY.listCap],
    ['not a number at all', Number.NaN, DEFAULT_POLICY.listCap],
    // THE THREE THAT FLOOR TO ZERO, and the case the first version of this table missed. `0.5` is
    // finite and positive, so a guard that tested positivity BEFORE flooring let it through and
    // produced a bound of 0: the probe still fetched one row, so the receipt reported PARTIAL with
    // `returned: 0` and a reason claiming the archive holds more than 0 rows, and the page printed
    // "no row in the archive matches it" beside it. Reachable from the public query string.
    ['a fraction below one', 0.5, DEFAULT_POLICY.listCap],
    ['a fraction very close to one', 0.999, DEFAULT_POLICY.listCap],
    ['a tiny exponential', 1e-9, DEFAULT_POLICY.listCap],
  ])('treats %s as a display preference rather than an error', async (_label, requested, expected) => {
    // A malformed bound is a typo in a query string. Refusing the whole page over one would turn a
    // typo into an outage, and the receipt reports what was actually applied either way.
    const { repository } = build(listing([]));
    const page = await repository.list({ workspaceId: 'demo', limit: requested });
    expect(page.receipt.limit).toBe(expected);
  });

  it('includes tombstoned and superseded rows, because they are the point of the archive', async () => {
    const { db, repository } = build(
      listing([
        row({ id: '11111111-1111-1111-1111-111111111111' }),
        row({ id: '22222222-2222-2222-2222-222222222222', superseded_by: '11111111-1111-1111-1111-111111111111' }),
        row({
          id: '33333333-3333-3333-3333-333333333333',
          evicted_at: new Date('2026-08-04T00:00:00Z'),
          eviction_reason: 'evicted by the scheduled sweep',
        }),
      ]),
    );
    const page = await repository.list({ workspaceId: 'demo' });

    expect(page.memories).toHaveLength(3);
    // NO `is_live` FILTER. That column is `evicted_at IS NULL`, so filtering on it would drop every
    // tombstone, and the tombstones are half of what this archive can show that a vector store
    // cannot. Asserted on the statement, because a fixture returning three rows would pass anyway.
    expect(db.texts()[0]).not.toContain('is_live');
  });

  it('orders newest first with a tiebreak, so a bounded page has a stable boundary', async () => {
    const { db, repository } = build(listing(rows(1)));
    await repository.list({ workspaceId: 'demo' });

    // Two rows written in one transaction share a `created_at`. Without the id tiebreak their
    // relative order is whatever the storage engine returns, so the same request could reorder them
    // and a PARTIAL page's boundary would move under the reader.
    expect(mentions(db.texts()[0] ?? '', 'order by created_at desc, id desc')).toBe(true);
  });

  it('passes the kind filter to the database rather than filtering in memory', async () => {
    const { db, repository } = build(listing(rows(1)));
    await repository.list({ workspaceId: 'demo', kinds: ['resolution', 'runbook_fact'], limit: 1 });

    expect(mentions(db.texts()[0] ?? '', 'kind = any($2::text[])')).toBe(true);
    expect(db.queries[0]?.values[1]).toEqual(['resolution', 'runbook_fact']);
    // THE BOUND'S POSITION, asserted because the filtered branch numbers it `$3` while the unfiltered
    // one numbers it `$2`, and the docblock on `listStatement` rests its whole design on that not
    // being got wrong. `createFakeDatabase` now refuses a placeholder mismatch outright, which is the
    // broad guard; this is the narrow one that names the value.
    expect(db.queries[0]?.values.at(-1)).toBe(2);
    expect(mentions(db.texts()[0] ?? '', 'limit $3')).toBe(true);
  });

  it('sends no kind filter at all when none was asked for', async () => {
    const { db, repository } = build(listing(rows(1)));
    await repository.list({ workspaceId: 'demo' });

    // An empty array must not become `kind = ANY('{}')`, which matches nothing and would turn "every
    // kind" into "no kinds" - an empty archive that reads as COVERED.
    //
    // Asserted on the PREDICATE and not on the word: `kind` is one of the selected columns, so
    // `not.toContain('kind')` fails against the correct statement. Only one parameter is bound,
    // which is the second half of the same claim.
    expect(mentions(db.texts()[0] ?? '', 'kind = any')).toBe(false);
    expect(db.queries[0]?.values).toHaveLength(1 + 1);
  });

  it('reports UNKNOWN when the listing query fails, and never an empty archive', async () => {
    // The whole argument of the product, applied to its own archive page. An empty list here would
    // read as "there is nothing", which is a different and far more dangerous claim.
    const { repository } = build(() => {
      throw new Error('relation "throughline.memory" does not exist');
    });
    const page = await repository.list({ workspaceId: 'demo' });

    expect(page.memories).toEqual([]);
    expect(page.receipt.coverage).toBe('UNKNOWN');
    expect(page.receipt.coverageCause).toBe('listing_query_failed');
    // The thrown message is NOT read. It carries a schema and table name, and this reason reaches a
    // public page.
    expect(page.receipt.coverageReason).not.toContain('throughline.memory');
  });

  it('reports UNKNOWN when a row cannot be read, rather than a shorter archive', async () => {
    // `rowToMemory` throws on a kind the code does not know, which means the database CHECK and
    // MEMORY_KINDS have diverged. Dropping the row would hide a real schema divergence behind a
    // page that merely looked a bit short.
    const { repository } = build(listing([row(), row({ kind: 'wishful_thinking' })]));
    const page = await repository.list({ workspaceId: 'demo' });

    expect(page.memories).toEqual([]);
    expect(page.receipt.coverage).toBe('UNKNOWN');
    expect(page.receipt.coverageCause).toBe('row_unreadable');
  });

  it('never parses the probe row, so a malformed row beyond the bound cannot fail the page', async () => {
    // The probe exists only to answer "is there more". Mapping before slicing would parse it, and a
    // broken row sitting one past the bound would take down a listing that did not need it.
    const { repository } = build(listing([row(), row({ kind: 'wishful_thinking' })]));
    const page = await repository.list({ workspaceId: 'demo', limit: 1 });

    expect(page.memories).toHaveLength(1);
    expect(page.receipt.coverage).toBe('PARTIAL');
  });

  it('writes no audit row, because a page view is not an auditable event', async () => {
    const { db, repository } = build(listing(rows(1)));
    await repository.list({ workspaceId: 'demo' });

    // `memory_audit` has a CHECK listing the operations it permits, so a row per page view would
    // need a migration and would grow the audit table with the least interesting fact in the system.
    expect(db.texts().some((text) => mentions(text, 'insert into'))).toBe(false);
  });
});
