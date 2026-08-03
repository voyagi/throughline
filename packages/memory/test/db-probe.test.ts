import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  DatabaseError,
  quoteIdentifier,
  sanitizeError,
  toDatabaseError,
} from '../src/db.ts';
import { loadDatabaseConfig, secretsOf } from '../src/config.ts';
import { probeCapabilities } from '../src/capability.ts';
import { createLocalEmbedder } from '../src/embeddings.ts';
import { createFakeDatabase, mentions, type Responder } from './fake-database.ts';

const PASSWORD = 'NotARealPassword-rotated-2026';
const URL_WITH_SECRET = `postgresql://throughline:${PASSWORD}@cluster.example.cloud:26257/defaultdb`;

describe('quoteIdentifier', () => {
  it('wraps a bare name', () => {
    expect(quoteIdentifier('throughline')).toBe('"throughline"');
  });

  it('doubles an embedded quote rather than letting it terminate the identifier', () => {
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });
});

describe('DatabaseError redaction', () => {
  // The guarantee is that a connection string never leaves this layer. An earlier version redacted
  // the MESSAGE and then attached the UNREDACTED original as `cause`, which cancelled the whole
  // thing precisely where it mattered: if the driver message held no secret there was nothing to
  // redact, and if it did, the cause kept it verbatim.
  const errorFromDriver = (): Error => {
    const inner = new Error(`could not connect using "${URL_WITH_SECRET}"`);
    const outer = new Error(`password authentication failed for ${PASSWORD}`, { cause: inner });
    (outer as unknown as Record<string, unknown>)['code'] = '28P01';
    (outer as unknown as Record<string, unknown>)['constraint'] = 'none';
    return outer;
  };

  const secrets = secretsOf(loadDatabaseConfig({ DATABASE_URL: URL_WITH_SECRET }));

  it('keeps the secret out of the whole inspected object, cause chain included', () => {
    // util.inspect is what `console.error(err)` and Node's uncaught handler actually print, so it
    // is the honest test. Asserting only on `.message` is how the broken version passed review.
    const sanitized = sanitizeError(errorFromDriver(), secrets);
    const wrapped = new DatabaseError('wrapped', '28P01', { cause: sanitized });

    const printed = inspect(wrapped, { depth: 10 });
    expect(printed).not.toContain(PASSWORD);
    expect(printed).not.toContain(URL_WITH_SECRET);
    expect(printed).toContain('[redacted]');
  });

  it('redacts the nested cause, which is where the leak actually was', () => {
    const sanitized = sanitizeError(errorFromDriver(), secrets);
    const nested = (sanitized as unknown as Record<string, unknown>)['cause'] as Error;
    expect(nested).toBeInstanceOf(Error);
    expect(nested.message).not.toContain(PASSWORD);
    expect(nested.message).toContain('[redacted]');
  });

  it('redacts the stack as well as the message', () => {
    // A stack frame can carry the connection string in its source text, and a stack is printed by
    // exactly the same code paths as a message.
    const raw = new Error('boom');
    raw.stack = `Error: boom\n    at connect (${URL_WITH_SECRET})`;
    const sanitized = sanitizeError(raw, secrets);
    expect(sanitized?.stack).not.toContain(PASSWORD);
  });

  it('keeps the diagnostic fields the repository layer needs', () => {
    // CockroachDB reports a CHECK violation as SQLSTATE 23514 with the constraint NAME on
    // `error.constraint`; the message carries only the expression. Losing this field during
    // sanitising would force the caller to parse messages, which is fragile in a different way.
    const raw = new Error('failed to satisfy CHECK constraint (length(asserted_by) > 0)');
    (raw as unknown as Record<string, unknown>)['code'] = '23514';
    (raw as unknown as Record<string, unknown>)['constraint'] = 'provenance_is_present';

    const sanitized = sanitizeError(raw, secrets) as unknown as Record<string, unknown>;
    expect(sanitized['code']).toBe('23514');
    expect(sanitized['constraint']).toBe('provenance_is_present');
  });

  it('does not mutate the driver error it was given', () => {
    // The caller may still hold that object, and a frozen error would silently refuse the write.
    const raw = new Error(`connecting to ${URL_WITH_SECRET}`);
    sanitizeError(raw, secrets);
    expect(raw.message).toContain(PASSWORD);
  });

  it('stops walking a cause chain rather than recursing forever', () => {
    const deepest = new Error('deepest');
    let current: Error = deepest;
    for (let i = 0; i < 20; i += 1) current = new Error(`level ${i}`, { cause: current });
    expect(() => sanitizeError(current, secrets)).not.toThrow();
  });

  it('handles a thrown non-error without losing the redaction', () => {
    const sanitized = sanitizeError(`failed for ${URL_WITH_SECRET}`, secrets);
    expect(sanitized?.message).not.toContain(PASSWORD);
  });

  it('attaches a SANITISED cause, not the driver error itself', () => {
    // Pins the WIRING rather than the helper. Reverting `toDatabaseError` to attach the raw error
    // left every other test in this file green, because they call `sanitizeError` directly. This
    // one goes red for that revert, which is the whole point of it existing.
    const raw = errorFromDriver();
    const wrapped = toDatabaseError(raw, secrets);

    const attached = (wrapped as unknown as Record<string, unknown>)['cause'];
    expect(attached).not.toBe(raw);
    expect(inspect(wrapped, { depth: 10 })).not.toContain(PASSWORD);
    expect(inspect(wrapped, { depth: 10 })).not.toContain(URL_WITH_SECRET);
  });

  it('carries the driver code onto the wrapper so callers can branch on it', () => {
    const wrapped = toDatabaseError(errorFromDriver(), secrets);
    expect(wrapped.code).toBe('28P01');
  });

  it('surfaces a real connection failure as a DatabaseError with no secret in it', async () => {
    // The end-to-end half. The host does not resolve, so this exercises the genuine driver path
    // rather than a hand-built error.
    const db = createDatabase(loadDatabaseConfig({ DATABASE_URL: URL_WITH_SECRET }));
    try {
      await db.query('SELECT 1');
      expect.unreachable('a query to a nonexistent host must fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError);
      expect(inspect(error, { depth: 10 })).not.toContain(PASSWORD);
    } finally {
      await db.close();
    }
  }, 30_000);
});

describe('probeVectorIndex', () => {
  const columnRow = { data_type: 'USER-DEFINED', crdb_sql_type: 'VECTOR(1024)' };

  const responderWithIndexRows = (indexRows: unknown[]): Responder => {
    return (text) => {
      if (mentions(text, 'information_schema.columns')) return [columnRow];
      if (mentions(text, 'show indexes from')) return indexRows;
      if (mentions(text, 'show cluster setting')) return [{ setting: 'true' }];
      if (mentions(text, 'explain select')) return [{ info: 'vector search' }];
      if (mentions(text, 'select version()')) return [{ version: 'CockroachDB CCL v26.2.1' }];
      return [];
    };
  };

  it('asks a question a stored primary-index column cannot answer yes to', async () => {
    // This is the regression guard for the bug that shipped in the previous commit. A CockroachDB
    // primary index STORES every non-key column, so `embedding` appears under `memory_pkey`. A
    // query that merely asks "does any index mention this column" answers yes on a table with no
    // vector index, and recall would then claim an ANN path while doing a full scan.
    //
    // Rather than assert on a canned answer, this asserts on the QUERY: it must exclude stored and
    // implicit columns. Reverting the filter makes this fail.
    const db = createFakeDatabase(responderWithIndexRows([]));
    await probeCapabilities(db, { schema: 'throughline', embedder: createLocalEmbedder(1024) });

    const indexQuery = db.texts().find((text) => mentions(text, 'show indexes from'));
    expect(indexQuery, 'the probe must ask the catalog about indexes').toBeDefined();
    expect(indexQuery).toContain("column_name = 'embedding'");
    expect(indexQuery).toContain('storing = false');
    expect(indexQuery).toContain('implicit = false');
  });

  it('reports false when the filtered query returns nothing', async () => {
    const db = createFakeDatabase(responderWithIndexRows([]));
    const capabilities = await probeCapabilities(db, {
      schema: 'throughline',
      embedder: createLocalEmbedder(1024),
    });
    expect(capabilities.vectorIndex).toEqual({ status: 'observed', value: false });
  });

  it('reports true when a real index row survives the filter', async () => {
    const db = createFakeDatabase(responderWithIndexRows([{ index_name: 'memory_embedding_ann' }]));
    const capabilities = await probeCapabilities(db, {
      schema: 'throughline',
      embedder: createLocalEmbedder(1024),
    });
    expect(capabilities.vectorIndex).toEqual({ status: 'observed', value: true });
  });

  it('reports UNKNOWN, never false, when the catalog refuses the question', async () => {
    // "Could not check" and "checked, absent" are different facts. Cloud Basic refuses
    // crdb_internal outright, so this is a state that really happens.
    const db = createFakeDatabase((text) => {
      if (mentions(text, 'information_schema.columns')) return [columnRow];
      if (mentions(text, 'show indexes from')) throw new Error('Access to crdb_internal is restricted');
      return [];
    });
    const capabilities = await probeCapabilities(db, {
      schema: 'throughline',
      embedder: createLocalEmbedder(1024),
    });
    expect(capabilities.vectorIndex.status).toBe('unknown');
  });
});

describe('probeAnnPlan', () => {
  const respondWithPlan = (planText: string): Responder => {
    return (text) => {
      if (mentions(text, 'information_schema.columns')) {
        return [{ data_type: 'USER-DEFINED', crdb_sql_type: 'VECTOR(4)' }];
      }
      if (mentions(text, 'explain select')) return [{ info: planText }];
      return [];
    };
  };

  it('asks about the filter recall actually uses, not a filter nobody runs', async () => {
    // Measured on a live cluster: the same index plans as a vector search under
    // `workspace_id = $1 AND is_live` and as a FULL SCAN under `evicted_at IS NULL`, because
    // CockroachDB only accelerates a filtered vector search on the index prefix columns. A probe
    // written against the wrong filter answers a question nobody asked.
    const db = createFakeDatabase(respondWithPlan('vector search'));
    await probeCapabilities(db, { schema: 'throughline', embedder: createLocalEmbedder(4) });

    const explain = db.texts().find((text) => mentions(text, 'explain select'));
    expect(explain).toBeDefined();
    expect(explain).toContain('workspace_id = $2');
    expect(explain).toContain('is_live');
    expect(explain).not.toContain('evicted_at');
  });

  it('recognises a vector search plan', async () => {
    const db = createFakeDatabase(respondWithPlan('• vector search table: memory@memory_embedding_ann'));
    const capabilities = await probeCapabilities(db, {
      schema: 'throughline',
      embedder: createLocalEmbedder(4),
    });
    expect(capabilities.annPlanUsesIndex).toEqual({ status: 'observed', value: true });
  });

  it('reports false for a full scan plan rather than assuming the index is used', async () => {
    const db = createFakeDatabase(
      respondWithPlan('• scan table: memory@memory_eviction_candidates spans: FULL SCAN'),
    );
    const capabilities = await probeCapabilities(db, {
      schema: 'throughline',
      embedder: createLocalEmbedder(4),
    });
    expect(capabilities.annPlanUsesIndex).toEqual({ status: 'observed', value: false });
  });

  it('builds the probe vector at the column width, so a mismatch surfaces here', async () => {
    const db = createFakeDatabase(respondWithPlan('vector search'));
    await probeCapabilities(db, { schema: 'throughline', embedder: createLocalEmbedder(4) });
    const explain = db.queries.find((query) => mentions(query.text, 'explain select'));
    expect(explain?.values[0]).toBe('[0.01,0.01,0.01,0.01]');
  });
});
