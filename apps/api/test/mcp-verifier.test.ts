import { describe, expect, it } from 'vitest';
import { loadDatabaseConfig, type MemoryRecord } from '@throughline/memory';
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

  it('accepts exactly the schema names the database config accepts, in both directions', () => {
    // One rule, two consumers, and it used to be a byte-for-byte copy in each with a comment
    // asserting they matched and nothing holding them to it. They now import the same regex, and
    // this is what would notice if either grew its own again. The direction people expect, this
    // module accepting something dangerous, is not the one that bites: relax the CONFIG
    // rule and every verification of a legitimately named schema turns into UNKNOWN, which is the
    // component built to say "the channel could not look" becoming the reason it could not.
    const accepts = (action: () => unknown): boolean => {
      try {
        action();
        return true;
      } catch {
        return false;
      }
    };

    for (const schema of [
      'throughline',
      'public',
      '_private',
      'a1',
      'Throughline',
      'public;drop',
      '1schema',
      'throughline"',
      'with space',
      'sch-ema',
      '',
    ]) {
      const byConfig = accepts(() =>
        loadDatabaseConfig({
          DATABASE_URL: 'postgres://user@127.0.0.1:26257/defaultdb',
          THROUGHLINE_SCHEMA: schema,
        }),
      );
      const byQueryBuilder = accepts(() => buildVerificationQuery(schema, WORKSPACE, MEMORY_ID));
      // Compared as objects so a failure names the schema that caused it.
      expect({ schema, accepted: byConfig }).toEqual({ schema, accepted: byQueryBuilder });
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

  it('describes a content disagreement even when the length and the prefix did not arrive', () => {
    // Both arms of the content message were uncovered: reachable only by calling this function
    // directly, because through `verifyMemory` the presence check catches the absent columns first
    // and reports UNKNOWN. The fallback is what stops the sentence reading "undefined characters"
    // at whoever is holding the incident.
    const row = channelRow({ content_md5: contentDigest('tampered') });
    delete row['content_length'];
    delete row['content_prefix'];

    const differences = compareMemoryToRow(MEMORY, row);
    expect(differences.map((difference) => difference.field)).toEqual(['content (md5)']);
    expect(differences[0]?.channel).toContain('unknown characters');
    expect(differences[0]?.channel).not.toContain('beginning');
    expect(differences[0]?.channel).not.toContain('undefined');
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

  it('reports an unreadable embedding flag rather than dropping the observation', () => {
    // `(embedding IS NULL)` is a boolean expression, so a channel returning the string "true" is
    // one this code cannot read a boolean out of. Dropping the observation on that ground took the
    // only line about the embedding off the report with nothing at all to say it had gone: the
    // silent drop this codebase refuses everywhere else, committed in the report itself.
    for (const value of ['true', 'false', 1, 0, {}, null]) {
      const observations = observationsFrom(channelRow({ embedding_is_null: value }));
      const embedding = observations.find(
        (observation) => observation.label === 'embedding present in the database',
      );
      expect(embedding?.value).toMatch(/unreadable/);
      // And it must not resolve the ambiguity in either direction while it is at it.
      expect(embedding?.value).not.toMatch(/^(yes|no)$/);
    }
  });

  it('leaves out an embedding column that never arrived, which missingColumns has already named', () => {
    // Absent is not unreadable. A row missing the column is already UNKNOWN with the column named
    // in the reason, so an observation here would be a second voice on a settled point.
    const row = channelRow();
    delete row['embedding_is_null'];
    const labels = observationsFrom(row).map((observation) => observation.label);
    expect(labels).not.toContain('embedding present in the database');
    // The rest of the observations still arrive.
    expect(labels).toContain('embedding model recorded on the row');
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
    // ONE difference, counted. A verifier that reported this divergence plus a spurious second one
    // would still satisfy a read of index 0, and a verifier crying wolf is the failure this whole
    // surface exists to avoid.
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]?.channel).toBe('not found');
    // Measured rather than assumed, and the wording is held to the measurement: over 50 trials in
    // two runs (`npm run measure:freshness`, 2026-08-05) every row written over pg was found by
    // the FIRST read this channel attempted, the fastest of those reads 330 ms after the write
    // returned.
    //
    // The sentence states those two facts and stops, which is deliberate and is the second
    // correction this claim has needed. It does NOT say the invisible window is under 330 ms:
    // each trial bounds the window by its own read time, so that figure rests on one observation
    // rather than fifty, and treating it as a bound on the next write assumes the window does not
    // vary. `mcp-verifier.ts` says the same thing at length, and the two must not drift.
    expect(report.reason).toMatch(/50 trials/);
    expect(report.reason).toMatch(/first read/i);
    expect(report.reason).not.toMatch(/shorter than|window/i);
    expect(report.reason).not.toMatch(/no replication delay|never a delay|reads the present/);
  });

  it('diverges when the channel finds a row the application says is not there', async () => {
    const report = await verifyMemory(clientReturning([channelRow()]), { ...REQUEST, memory: null });
    expect(report.verdict).toBe('DIVERGES');
    expect(report.differences).toHaveLength(1);
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

  it('reports UNKNOWN, never DIVERGES, when the row position holds something that is not a row', async () => {
    // The worst reachable output of this component, and it arrives by a route no error message
    // takes. A falsy element (null, 0, false, "") makes `rows[0]` falsy while `rows.length` is 1,
    // so every "is there a row" branch is skipped and control falls through to "the application
    // holds this memory and an independent read of the cluster does not find it", with
    // `failure: null` so nothing downstream can tell it from a real finding. A claim about the
    // DATABASE, manufactured from the SHAPE of a response.
    //
    // The cast is the test: `McpClient` promises rows, and this asserts what happens when an
    // implementation of that interface does not keep the promise. `readRows` is the first control
    // and refuses these at the wire; this pins the second, which is the one that still holds when
    // the rows did not come off the wire at all.
    for (const bad of [null, 0, false, '', 'some text', 42]) {
      const rows = [bad] as unknown as readonly Record<string, unknown>[];
      const report = await verifyMemory(clientReturning(rows), REQUEST);
      expect(report.verdict).toBe('UNKNOWN');
      expect(report.failure).toBe('unrecognised_envelope');
      expect(report.differences).toEqual([]);
      // Not "must not contain the word absent": the sentence DENIES absence in as many words, and
      // a pattern that cannot tell a denial from a claim would forbid the correct wording. What is
      // forbidden is the DIVERGES sentence itself, which is what this path used to produce.
      expect(report.reason).not.toMatch(/does not find it/);
      expect(report.reason).toMatch(/not a row object/);
    }
  });

  it('does not mistake a genuinely empty result for an unreadable one', async () => {
    // The other side of the guard above: zero rows is a real answer and must stay a real answer,
    // or "the application holds a memory the cluster does not have" becomes unreportable.
    const report = await verifyMemory(clientReturning([]), REQUEST);
    expect(report.verdict).toBe('DIVERGES');
    expect(report.failure).toBeNull();
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

  it('stamps the report from the clock it was given, elapsed time included', async () => {
    // A clock that does not move gives an elapsed time of zero. It used to give whatever
    // `Date.now()` felt like, so the only assertion available was `>= 0`, which every possible
    // implementation satisfies.
    const when = new Date('2026-08-04T12:00:00.000Z');
    const report = await verifyMemory(clientReturning([channelRow()]), REQUEST, () => when);
    expect(report.checkedAt).toBe(when);
    expect(report.elapsedMs).toBe(0);
  });

  it('measures the interval on that same clock, on the answer path and on the failure path', async () => {
    // Two clocks in one report is a lie about an interval: `checkedAt` came from the injected
    // clock and `elapsedMs` from `Date.now()`, so the two numbers did not come off the same
    // timeline and no caller could assert the second one at all.
    const ticking = (): (() => Date) => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 7, 4, 12, 0, 0) + (tick += 1) * 250);
    };

    const answered = await verifyMemory(clientReturning([channelRow()]), REQUEST, ticking());
    expect(answered.verdict).toBe('AGREES');
    expect(answered.elapsedMs).toBe(250);
    expect(answered.checkedAt.toISOString()).toBe('2026-08-04T12:00:00.500Z');

    const failed = await verifyMemory(
      clientThrowing(new McpError('timeout', 'timed out')),
      REQUEST,
      ticking(),
    );
    expect(failed.verdict).toBe('UNKNOWN');
    expect(failed.elapsedMs).toBe(250);
  });
});
