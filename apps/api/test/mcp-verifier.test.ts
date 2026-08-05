import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '@throughline/memory';
import { buildBoundedQuery, McpError, type McpClient, type McpSelectResult } from '../src/mcp-client.ts';
import {
  buildVerificationQuery,
  compareMemoryToRow,
  COMPARED_FIELDS,
  contentDigest,
  missingColumns,
  observationsFrom,
  VERIFICATION_COLUMNS,
  verifyMemory,
} from '../src/mcp-verifier.ts';

/**
 * The fixtures below are a REAL row, written to the live cluster over the Postgres wire protocol on
 * 2026-08-04 and read back over the managed MCP server, values copied verbatim. That matters for
 * two of them in particular:
 *
 * `created_at` differs between the channels as a STRING and matches as a millisecond instant. The
 * database returns microseconds and a JavaScript Date cannot hold them, so a comparator written the
 * obvious way reports a divergence on every row of a perfectly consistent database.
 *
 * `confirm_count` arrives from MCP as a JSON number and from `pg` as a string, because CockroachDB
 * INT8 does not fit a JS number safely. Comparing them without normalising is the same trap wearing
 * a different hat.
 */
const MEMORY_ID = '0ff30117-b0c9-4588-8cdb-0654a0b8b7b0';
const WORKSPACE = 'demo-workspace';
const CONTENT = 'A freshness probe row. Written over pg, looked for over MCP, then deleted.';

const MEMORY: MemoryRecord = {
  id: MEMORY_ID,
  workspaceId: WORKSPACE,
  kind: 'observation',
  content: CONTENT,
  provenance: { assertedBy: 'system:freshness-probe', incidentId: null, sourceRef: null },
  createdAt: new Date('2026-08-04T14:30:17.311Z'),
  lastConfirmedAt: new Date('2026-08-04T14:30:17.311Z'),
  confirmCount: 7,
  contradictCount: 0,
  validFrom: new Date('2026-08-04T14:30:17.311Z'),
  validUntil: null,
  supersededBy: null,
  protectedUntil: new Date('2026-08-04T15:30:17.311Z'),
  evictedAt: null,
  evictionReason: null,
};

/** The same row as the managed MCP server returns it. Microseconds and all. */
function channelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEMORY_ID,
    workspace_id: WORKSPACE,
    kind: 'observation',
    content_md5: contentDigest(CONTENT),
    content_length: CONTENT.length,
    content_prefix: CONTENT.slice(0, 120),
    asserted_by: 'system:freshness-probe',
    incident_id: null,
    source_ref: null,
    created_at: '2026-08-04T14:30:17.311394Z',
    last_confirmed_at: '2026-08-04T14:30:17.311394Z',
    confirm_count: 7,
    contradict_count: 0,
    valid_from: '2026-08-04T14:30:17.311394Z',
    valid_until: null,
    superseded_by: null,
    protected_until: '2026-08-04T15:30:17.311394Z',
    evicted_at: null,
    eviction_reason: null,
    embedding_model: null,
    embedding_is_null: true,
    ...overrides,
  };
}

function clientReturning(
  rows: readonly Record<string, unknown>[],
  capture?: { sql?: string; limit?: number },
): McpClient {
  return {
    clusterScope: 'argument',
    reset: () => undefined,
    callReadTool: () => Promise.resolve(null),
    select: (request): Promise<McpSelectResult> => {
      if (capture) {
        capture.sql = request.sql;
        capture.limit = request.limit;
      }
      return Promise.resolve({
        rows,
        limit: request.limit,
        possiblyTruncated: rows.length >= request.limit,
        elapsedMs: 12,
      });
    },
  };
}

function clientThrowing(error: unknown): McpClient {
  return {
    clusterScope: 'argument',
    reset: () => undefined,
    callReadTool: () => Promise.reject(error),
    select: () => Promise.reject(error),
  };
}

const REQUEST = {
  database: 'defaultdb',
  schema: 'throughline',
  workspaceId: WORKSPACE,
  memoryId: MEMORY_ID,
  memory: MEMORY,
};

describe('buildVerificationQuery', () => {
  it('produces a query the client will accept, bound and all', () => {
    // The cross-module assertion that matters: the verifier writes no bound and the client refuses
    // any query that does. If either side drifts, this fails rather than the server silently
    // applying LIMIT 25 to a verification read.
    const sql = buildVerificationQuery('throughline', WORKSPACE, MEMORY_ID);
    expect(() => buildBoundedQuery(sql, 2)).not.toThrow();
    expect(sql).not.toMatch(/\blimit\b/i);
  });

  it('stays acceptable to the client for a workspace whose name contains a clause keyword', () => {
    // "rate-limit" is a plausible workspace for an incident tool, and the id lands inside the query
    // text. The two modules have to agree that a value is not a clause, or that workspace's
    // memories are permanently unverifiable.
    const sql = buildVerificationQuery('throughline', 'rate-limit', MEMORY_ID);
    expect(() => buildBoundedQuery(sql, 2)).not.toThrow();
  });

  it('sends a digest of the content rather than the content', () => {
    // Measured: this channel dies past roughly 10 KB of result text, and a memory can exceed that
    // on its own. A verification that only works on short memories is a verification of nothing.
    const sql = buildVerificationQuery('throughline', WORKSPACE, MEMORY_ID);
    expect(sql).toContain('md5(content) AS content_md5');
    // Asserted against the projection list rather than against the query text: `left(content, 120)`
    // contains the substring, so a regex here tests the regex rather than the design. What matters
    // is that no selected expression IS the bare column.
    expect(VERIFICATION_COLUMNS.map(({ expression }) => expression)).not.toContain('content');
    expect(sql).toContain('left(content, 120) AS content_prefix');
  });

  it('refuses an id that is not a UUID rather than escaping it', () => {
    for (const bad of [
      "' OR 1=1--",
      `${MEMORY_ID}' OR '1'='1`,
      '0ff30117b0c94588',
      '',
      'DROP',
    ]) {
      expect(() => buildVerificationQuery('throughline', WORKSPACE, bad)).toThrow(/not a UUID/);
    }
  });

  it('refuses a workspace id carrying anything a query could read as syntax', () => {
    for (const bad of ["demo'; --", 'demo workspace', 'demo"x', 'demo\\x', 'a'.repeat(65), '']) {
      expect(() => buildVerificationQuery('throughline', bad, MEMORY_ID)).toThrow(/refused rather than escaped/);
    }
  });

  it('refuses a schema that is not a bare lowercase identifier', () => {
    for (const bad of ['Throughline', 'public;drop', 'throughline"', '1schema', '']) {
      expect(() => buildVerificationQuery(bad, WORKSPACE, MEMORY_ID)).toThrow(/bare lowercase/);
    }
  });

  it('accepts the identifiers this product actually produces', () => {
    for (const workspace of ['demo-workspace', 'verify-live-40968', 'acme.eu:prod', 'a']) {
      expect(() => buildVerificationQuery('throughline', workspace, MEMORY_ID)).not.toThrow();
    }
  });
});

describe('contentDigest', () => {
  it('matches the digest CockroachDB computes over the same text', () => {
    // Both halves measured against the live cluster: md5() there and createHash here agreed on
    // five samples including 5000 characters and non-ASCII text, and on the real row below.
    expect(contentDigest('hello world')).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
    expect(contentDigest(CONTENT)).toBe('a4d0551005e2a4575e7000a099ca0da0');
  });
});

describe('compareMemoryToRow', () => {
  it('finds nothing to report when the two channels agree', () => {
    expect(compareMemoryToRow(MEMORY, channelRow())).toEqual([]);
  });

  it('does not mistake microseconds for a disagreement', () => {
    // The application holds 14:30:17.311Z and the channel says 14:30:17.311394Z. Same instant,
    // different precision. A string comparison would report every row in the database as diverged.
    expect(compareMemoryToRow(MEMORY, channelRow()).map((difference) => difference.field)).toEqual([]);
  });

  it('does not mistake an INT8 rendered as a string for a disagreement', () => {
    expect(compareMemoryToRow(MEMORY, channelRow({ confirm_count: '7' }))).toEqual([]);
  });

  /**
   * One planted disagreement per compared field.
   *
   * This is the test that stops a field being silently dropped from the comparison. Without it,
   * deleting any single line from `compareMemoryToRow` leaves a green suite and a verification that
   * reports AGREES while never having looked at that column.
   */
  const PLANTED: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['id', { id: '11111111-2222-3333-4444-555555555555' }],
    ['workspaceId', { workspace_id: 'someone-elses-workspace' }],
    ['kind', { kind: 'resolution' }],
    ['content (md5)', { content_md5: contentDigest('something else entirely') }],
    ['provenance.assertedBy', { asserted_by: 'human:someone-else' }],
    ['provenance.incidentId', { incident_id: 'INC-9999' }],
    ['provenance.sourceRef', { source_ref: 'https://example.invalid/1' }],
    ['createdAt', { created_at: '2026-08-04T14:30:19.311394Z' }],
    ['lastConfirmedAt', { last_confirmed_at: '2026-08-04T14:31:17.311394Z' }],
    ['confirmCount', { confirm_count: 8 }],
    ['contradictCount', { contradict_count: 3 }],
    ['validFrom', { valid_from: '2026-08-03T14:30:17.311394Z' }],
    ['validUntil', { valid_until: '2026-09-01T00:00:00Z' }],
    ['supersededBy', { superseded_by: '11111111-2222-3333-4444-555555555555' }],
    ['protectedUntil', { protected_until: '2026-08-04T16:30:17.311394Z' }],
    ['evictedAt', { evicted_at: '2026-08-04T15:00:00Z' }],
    ['evictionReason', { eviction_reason: 'age' }],
  ];

  it('covers every field it claims to compare, and claims every field it covers', () => {
    expect(PLANTED.map(([field]) => field)).toEqual([...COMPARED_FIELDS]);
  });

  for (const [field, override] of PLANTED) {
    it(`reports a disagreement on ${field}`, () => {
      const differences = compareMemoryToRow(MEMORY, channelRow(override));
      expect(differences.map((difference) => difference.field)).toEqual([field]);
      expect(differences[0]?.application).not.toBe(differences[0]?.channel);
    });
  }

  it('reports a MISSING column as a disagreement rather than passing it', () => {
    // True only for fields whose application value is not null: for a null one, absent and null
    // compare identically here. The real protection is the presence check in verifyMemory, which
    // turns any missing column into UNKNOWN. This covers the half the comparator can see.
    for (const column of ['kind', 'asserted_by', 'created_at', 'confirm_count', 'content_md5']) {
      const row = channelRow();
      delete row[column];
      expect(compareMemoryToRow(MEMORY, row).length).toBeGreaterThan(0);
    }
  });

  it('reports an unparseable timestamp rather than treating it as equal', () => {
    const differences = compareMemoryToRow(MEMORY, channelRow({ created_at: 'not a date' }));
    expect(differences.map((difference) => difference.field)).toEqual(['createdAt']);
    expect(differences[0]?.channel).toBe('null');
  });

  it('reports a non-numeric count rather than coercing it to zero', () => {
    const differences = compareMemoryToRow(MEMORY, channelRow({ confirm_count: 'seven' }));
    expect(differences.map((difference) => difference.field)).toEqual(['confirmCount']);
  });

  it('describes a content disagreement with something a human can act on', () => {
    const differences = compareMemoryToRow(
      MEMORY,
      channelRow({ content_md5: contentDigest('tampered'), content_length: 8, content_prefix: 'tampered' }),
    );
    expect(differences[0]?.channel).toContain('8 characters');
    expect(differences[0]?.channel).toContain('tampered');
  });

  it('compares nulls on both sides without inventing a difference', () => {
    const nulled: MemoryRecord = { ...MEMORY, validUntil: null, evictedAt: null, evictionReason: null };
    expect(compareMemoryToRow(nulled, channelRow())).toEqual([]);
  });
});

describe('missingColumns', () => {
  it('is empty for the row the query actually asks for', () => {
    expect(missingColumns(channelRow())).toEqual([]);
  });

  it('names a column the channel did not return, even when its value would be null anyway', () => {
    // The dangerous half. `incident_id` is null on this memory, so an absent column and a null
    // column compare identically. Only presence tells them apart.
    const row = channelRow();
    delete row['incident_id'];
    expect(missingColumns(row)).toEqual(['incident_id']);
  });

  it('the query selects exactly the columns the check expects, with no drift', () => {
    // The query and the expectations come from one list, and this is what holds that true.
    const sql = buildVerificationQuery('throughline', WORKSPACE, MEMORY_ID);
    for (const { expression } of VERIFICATION_COLUMNS) expect(sql).toContain(expression);
    expect(missingColumns(channelRow())).toEqual([]);
  });
});

describe('observationsFrom', () => {
  it('reports what the channel saw that the record type cannot hold', () => {
    const observations = observationsFrom(channelRow({ embedding_is_null: false, embedding_model: 'bedrock:x:1024' }));
    const labels = observations.map((observation) => `${observation.label}=${observation.value}`);
    expect(labels).toContain('embedding present in the database=yes');
    expect(labels).toContain('embedding model recorded on the row=bedrock:x:1024');
  });

  it('says none rather than guessing when there is no model on the row', () => {
    const observations = observationsFrom(channelRow());
    expect(observations.find((observation) => observation.label.includes('model'))?.value).toBe('none');
  });
});

describe('verifyMemory', () => {
  it('agrees when both channels return the same row', async () => {
    const report = await verifyMemory(clientReturning([channelRow()]), REQUEST);
    expect(report.verdict).toBe('AGREES');
    expect(report.differences).toEqual([]);
    expect(report.comparedFields).toEqual([...COMPARED_FIELDS]);
    expect(report.notCompared.join(' ')).toMatch(/embedding/);
    expect(report.failure).toBeNull();
  });

  it('asks for two rows on a lookup that can only return one', async () => {
    // Asking for exactly one would hide a duplicate behind the bound. The bound is not the place
    // to discover that the primary key assumption is wrong.
    const capture: { sql?: string; limit?: number } = {};
    await verifyMemory(clientReturning([channelRow()], capture), REQUEST);
    expect(capture.limit).toBe(2);
    expect(capture.sql).toContain(MEMORY_ID);
    expect(capture.sql).toContain(WORKSPACE);
  });

  it('diverges when a field disagrees, and names it', async () => {
    const report = await verifyMemory(clientReturning([channelRow({ kind: 'resolution' })]), REQUEST);
    expect(report.verdict).toBe('DIVERGES');
    expect(report.differences.map((difference) => difference.field)).toEqual(['kind']);
    expect(report.reason).toMatch(/1 of 17 compared fields disagree/);
  });

  it('diverges when the application holds a row the channel cannot find', async () => {
    const report = await verifyMemory(clientReturning([]), REQUEST);
    expect(report.verdict).toBe('DIVERGES');
    expect(report.differences[0]?.channel).toBe('not found');
    // Settled by measurement rather than assumed: a row written over pg was visible over this
    // channel 436 ms later, and the channel's transaction timestamp tracks the present rather than
    // sitting ~4.8 seconds behind it. So an absent row is a finding, not a replication artifact.
  });

  it('diverges when the channel finds a row the application says is not there', async () => {
    const report = await verifyMemory(clientReturning([channelRow()]), { ...REQUEST, memory: null });
    expect(report.verdict).toBe('DIVERGES');
    expect(report.differences[0]?.application).toBe('not found');
    expect(report.observations.length).toBeGreaterThan(0);
  });

  it('agrees when both channels say the memory does not exist', async () => {
    const report = await verifyMemory(clientReturning([]), { ...REQUEST, memory: null });
    expect(report.verdict).toBe('AGREES');
    expect(report.reason).toMatch(/does not exist/);
  });

  it('reports UNKNOWN, never DIVERGES, when the channel fails', async () => {
    // The single most dangerous confusion available to this component: a channel that is down must
    // not render as "the database does not have your row", which is the most alarming verdict it
    // can produce and is in this case no finding at all.
    for (const kind of ['timeout', 'auth_rejected', 'result_too_large', 'transport_unreachable'] as const) {
      const report = await verifyMemory(
        clientThrowing(new McpError(kind, `a ${kind} happened`)),
        REQUEST,
      );
      expect(report.verdict).toBe('UNKNOWN');
      expect(report.failure).toBe(kind);
      expect(report.differences).toEqual([]);
    }
  });

  it('reports UNKNOWN for a failure it does not recognise at all', async () => {
    const report = await verifyMemory(clientThrowing(new TypeError('fetch is not a function')), REQUEST);
    expect(report.verdict).toBe('UNKNOWN');
    expect(report.failure).toBe('server_error');
    expect(report.reason).toMatch(/nothing is known/);
  });

  it('never lets an UNKNOWN read as an absence', async () => {
    const report = await verifyMemory(clientThrowing(new McpError('timeout', 'timed out')), REQUEST);
    expect(report.reason).not.toMatch(/not found|no such|does not exist|nothing found/i);
  });

  it('reports UNKNOWN, not AGREES, when the channel omits a column it was asked for', async () => {
    // Both directions of the trap, in one test. `incident_id` is null on this memory, so dropping
    // it would have compared equal and produced a confident AGREES about a column never returned.
    for (const column of ['incident_id', 'kind', 'embedding_model']) {
      const row = channelRow();
      delete row[column];
      const report = await verifyMemory(clientReturning([row]), REQUEST);
      expect(report.verdict).toBe('UNKNOWN');
      expect(report.reason).toContain(column);
      expect(report.differences).toEqual([]);
    }
  });

  it('reports UNKNOWN when a primary key lookup somehow returns two rows', async () => {
    const report = await verifyMemory(clientReturning([channelRow(), channelRow()]), REQUEST);
    expect(report.verdict).toBe('UNKNOWN');
    expect(report.reason).toMatch(/should be impossible/);
  });

  it('reports UNKNOWN rather than diverging when the query itself is refused', async () => {
    // `memory: null` because an id that disagrees with the record is a call site bug and throws
    // first, which is a different and correct behaviour tested below. This exercises the path where
    // the caller asks about a malformed id and the query builder refuses to construct anything.
    const report = await verifyMemory(clientReturning([]), {
      ...REQUEST,
      memoryId: 'not-a-uuid',
      memory: null,
    });
    expect(report.verdict).toBe('UNKNOWN');
    expect(report.failure).toBe('query_not_bounded');
    expect(report.reason).toMatch(/not a UUID/);
  });

  it('throws when the caller hands it a record for a different memory', async () => {
    // A bug in the call site, not a finding about the database. Reporting it as a divergence would
    // be this component inventing evidence.
    await expect(
      verifyMemory(clientReturning([channelRow()]), {
        ...REQUEST,
        memory: { ...MEMORY, id: '11111111-2222-3333-4444-555555555555' },
      }),
    ).rejects.toThrow(/handed a record for/);
    await expect(
      verifyMemory(clientReturning([channelRow()]), {
        ...REQUEST,
        memory: { ...MEMORY, workspaceId: 'another' },
      }),
    ).rejects.toThrow(/handed a record for/);
  });

  it('stamps the report from the clock it was given', async () => {
    const when = new Date('2026-08-04T12:00:00.000Z');
    const report = await verifyMemory(clientReturning([channelRow()]), REQUEST, () => when);
    expect(report.checkedAt).toBe(when);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
