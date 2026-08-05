import {
  createDatabase,
  createLocalEmbedder,
  createRepository,
  loadDatabaseConfig,
  loadEmbeddingConfig,
  probeCapabilities,
  quoteIdentifier,
} from '@throughline/memory';
import {
  createMcpClient,
  loadMcpConfig,
  McpError,
  readRows,
  type McpClient,
} from '../mcp-client.ts';
import { COMPARED_FIELDS, verifyMemory } from '../mcp-verifier.ts';

/**
 * Prove the verification channel against the LIVE managed MCP server.
 *
 * Every claim this project makes about that channel is asserted here rather than printed for
 * someone to eyeball, and the script exits non-zero on the first broken expectation, so it is
 * usable as a gate and not only as a demonstration. It is deliberately not part of `npm run gate`:
 * it needs a live cluster, a real service account key and a network, and a gate that cannot run
 * offline is a gate people learn to skip.
 *
 * What makes it worth having is the middle section. It writes a memory through the application's
 * own path, changes one field behind the application's back, and then shows the channel catching
 * the difference. A verification channel that has never been watched catching anything is a claim,
 * not a control.
 *
 * It writes to a dedicated workspace and removes it at the end, including on failure.
 */

const WORKSPACE = `verify-mcp-${process.pid}`;
let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` ${detail}` : ''}`);
}

/** The rows a diagnostic query returned, or a thrown McpError's kind. */
async function kindOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'no error';
  } catch (error) {
    return error instanceof McpError ? error.kind : `unexpected: ${(error as Error).name}`;
  }
}

async function proveTheTransport(client: McpClient, database: string): Promise<void> {
  console.log('\n  The transport, and the traps that a plausible client would fall into');

  const one = await client.select({ database, sql: 'SELECT 1 AS one', limit: 2 });
  check('a bounded read comes back', one.rows.length === 1 && one.rows[0]?.['one'] === 1);
  check('a single row is not reported as possibly truncated', !one.possiblyTruncated);

  // The read-only guard, refused locally. Nothing reaches the network, which is the point: this
  // service account holds Cluster Admin because the managed MCP server requires it.
  check(
    'a write tool is refused before the network',
    (await kindOf(() => client.callReadTool('insert_rows', { rows: [] }))) === 'read_only_violation',
  );
  check(
    'an unknown tool is refused too',
    (await kindOf(() => client.callReadTool('drop_everything', {}))) === 'read_only_violation',
  );

  // The other half of "read only", and the half this client does not own. The guard above is a
  // tool-name allowlist, but `select_query` carries arbitrary SQL and CockroachDB documents a
  // data-modifying CTE as a SELECT, so the allowlist alone does not establish that this channel
  // cannot write. The server's own CTE check is what does, and only a live call can show it still
  // holds. Safe by construction: the write targets a table that does not exist, so the two possible
  // outcomes are "refused as a non-SELECT" and "refused as a missing relation", and the second one
  // would be the finding, because reaching the planner means the write passed the SELECT check.
  const smuggledWrite = await kindOf(() =>
    client.select({
      database,
      sql: `WITH w AS (INSERT INTO throughline.no_such_table_${process.pid} (id) VALUES ('x') RETURNING id) SELECT id FROM w`,
      limit: 2,
    }),
  );
  check(
    'a write smuggled into a CTE is refused by the server, not just by our tool list',
    smuggledWrite === 'statement_not_select',
    `(${smuggledWrite})`,
  );

  // The silent bound. Called raw, so the server's own behaviour shows rather than this client's.
  // Parsed with the shipped parser rather than a second hand-rolled one: two readers of the same
  // envelope is how a diagnostic ends up disagreeing with the thing it is meant to be diagnosing.
  const unboundedRows = readRows(
    await client.callReadTool('select_query', {
      database,
      query: 'SELECT n FROM generate_series(1, 60) AS n',
    }),
  );
  check(
    'the server silently truncates a query that states no bound',
    unboundedRows.length === 25,
    `(asked for 60, received ${unboundedRows.length})`,
  );

  const bounded = await client.select({
    database,
    sql: 'SELECT n FROM generate_series(1, 60) AS n',
    limit: 60,
  });
  check('the same query through this client returns all 60', bounded.rows.length === 60);

  const atTheBound = await client.select({
    database,
    sql: 'SELECT n FROM generate_series(1, 60) AS n',
    limit: 25,
  });
  check('a result that fills its bound is flagged possibly truncated', atTheBound.possiblyTruncated);

  // The size ceiling, which is bytes rather than the documented row count, and which must never be
  // mistaken for a disagreement about data.
  const tooLarge = await kindOf(() =>
    client.select({
      database,
      sql: "SELECT n, repeat('x', 500) AS padding FROM generate_series(1, 40) AS n",
      limit: 40,
    }),
  );
  check('an oversized answer is named, not returned empty', tooLarge === 'result_too_large');

  check(
    'a query that writes its own bound is refused locally',
    (await kindOf(() => client.select({ database, sql: 'SELECT 1 LIMIT 1', limit: 2 }))) ===
      'query_not_bounded',
  );
}

async function proveTheClusterExclusion(database: string, mcpConfig: ReturnType<typeof loadMcpConfig>): Promise<void> {
  console.log('\n  The cluster id is exclusive-or with the header, in both directions');

  const asArgument = createMcpClient({ config: mcpConfig, clusterScope: 'argument' });
  const asHeader = createMcpClient({ config: mcpConfig, clusterScope: 'header' });

  const viaArgument = await asArgument.select({ database, sql: 'SELECT 1 AS one', limit: 2 });
  check('the cluster id works as a tool argument', viaArgument.rows.length === 1);

  const viaHeader = await asHeader.select({ database, sql: 'SELECT 1 AS one', limit: 2 });
  check('the cluster id works as a header', viaHeader.rows.length === 1);

  // Sending both, which this client cannot do through `select` and which the server refuses. Proven
  // rather than quoted, because the tool schema's phrasing ("required when the MCP config has no
  // cluster_id; otherwise must be omitted") is exactly the kind of sentence a plausible guess
  // reads past.
  const both = await kindOf(() =>
    asHeader.callReadTool('select_query', {
      database,
      query: 'SELECT 1 AS one LIMIT 1',
      cluster_id: mcpConfig.clusterId,
    }),
  );
  check('sending both at once is refused by the server', both === 'cluster_scope_conflict');
}

async function main(): Promise<void> {
  const dbConfig = loadDatabaseConfig(process.env);
  const embeddingConfig = loadEmbeddingConfig(process.env);
  const mcpConfig = loadMcpConfig(process.env);
  const database = new URL(dbConfig.connectionString).pathname.replace(/^\//, '') || 'defaultdb';

  const db = createDatabase(dbConfig);
  const embedder = createLocalEmbedder(embeddingConfig.dimensions);
  const client = createMcpClient({ config: mcpConfig });

  try {
    console.log(`\n  application channel: ${db.describe()}`);
    console.log(`  verification channel: ${mcpConfig.url} database=${database}`);
    console.log(`  workspace: ${WORKSPACE}`);

    await proveTheTransport(client, database);
    await proveTheClusterExclusion(database, mcpConfig);

    console.log('\n  The column the application writes into, read through the other channel');
    const schemaRows = readRows(
      await client.callReadTool('get_table_schema', {
        database,
        schema: dbConfig.schema,
        table: 'memory',
      }),
    );
    const createStatement = String(schemaRows[0]?.['create_statement'] ?? '');
    const declaredWidth = /VECTOR\s*\(\s*(\d+)\s*\)/i.exec(createStatement)?.[1];
    check('the vector column width is readable over MCP', declaredWidth !== undefined, `(${declaredWidth ?? 'not found'})`);
    check(
      'it matches the width the embedder is configured for',
      Number(declaredWidth) === embeddingConfig.dimensions,
      `(column ${declaredWidth}, embedder ${embeddingConfig.dimensions})`,
    );

    console.log('\n  A memory written by the application, read back through the other channel');
    const capabilities = await probeCapabilities(db, { schema: dbConfig.schema, embedder });
    const repository = createRepository({ db, embedder, schema: dbConfig.schema, capabilities });

    const written = await repository.remember({
      workspaceId: WORKSPACE,
      kind: 'resolution',
      content:
        'The checkout latency incident was fixed by raising the payment gateway pool size. ' +
        'Rolling back the deploy only masked it.',
      provenance: { assertedBy: 'human:oncall-ana', incidentId: 'INC-1042', sourceRef: null },
      embedding: await embedder.embed('checkout latency payment gateway pool size'),
    });

    const agreed = await verifyMemory(client, {
      database,
      schema: dbConfig.schema,
      workspaceId: WORKSPACE,
      memoryId: written.id,
      memory: written,
    });
    check('the two channels agree on a freshly written memory', agreed.verdict === 'AGREES', `(${agreed.verdict})`);
    check(
      'every field the channel claims to compare was compared',
      agreed.comparedFields.length === COMPARED_FIELDS.length,
      `(${agreed.comparedFields.length})`,
    );
    check('what was not compared is stated rather than implied', agreed.notCompared.length > 0);
    check(
      'the channel also observed the embedding it cannot compare',
      agreed.observations.some((observation) => observation.label.includes('embedding')),
    );
    console.log(`    ${agreed.reason}`);
    console.log(`    round trip: ${agreed.elapsedMs} ms`);

    console.log('\n  A change made behind the application\'s back');
    // The application still holds `written`. The row underneath it moves. This is the situation the
    // channel exists for, and it is the one a console can never detect on its own.
    await db.query(
      `UPDATE ${quoteIdentifier(dbConfig.schema)}.${quoteIdentifier('memory')} ` +
        `SET confirm_count = confirm_count + 41 WHERE id = $1`,
      [written.id],
    );
    const caught = await verifyMemory(client, {
      database,
      schema: dbConfig.schema,
      workspaceId: WORKSPACE,
      memoryId: written.id,
      memory: written,
    });
    check('the channel catches it', caught.verdict === 'DIVERGES', `(${caught.verdict})`);
    check(
      'and names the field that moved',
      caught.differences.some((difference) => difference.field === 'confirmCount'),
      `(${caught.differences.map((difference) => difference.field).join(', ') || 'none'})`,
    );
    console.log(`    ${caught.reason}`);
    for (const difference of caught.differences) {
      console.log(`    ${difference.field}: application ${difference.application}, channel ${difference.channel}`);
    }

    console.log('\n  The two directions of absence');
    const missingId = '11111111-2222-3333-4444-555555555555';
    const bothAbsent = await verifyMemory(client, {
      database,
      schema: dbConfig.schema,
      workspaceId: WORKSPACE,
      memoryId: missingId,
      memory: null,
    });
    check('both channels agreeing on absence is agreement', bothAbsent.verdict === 'AGREES');

    const onlyInDatabase = await verifyMemory(client, {
      database,
      schema: dbConfig.schema,
      workspaceId: WORKSPACE,
      memoryId: written.id,
      memory: null,
    });
    check(
      'a row the application cannot see but the database has is a divergence',
      onlyInDatabase.verdict === 'DIVERGES',
    );

    console.log('\n  An unavailable check is never a passed check, and never a divergence');
    const broken = createMcpClient({
      config: { ...mcpConfig, apiKey: 'EXAMPLE-NOT-A-REAL-KEY-deliberately-wrong-for-this-check' },
    });
    const unknown = await verifyMemory(broken, {
      database,
      schema: dbConfig.schema,
      workspaceId: WORKSPACE,
      memoryId: written.id,
      memory: written,
    });
    check('a rejected credential produces UNKNOWN', unknown.verdict === 'UNKNOWN', `(${unknown.verdict})`);
    check('and names the cause', unknown.failure === 'auth_rejected', `(${unknown.failure})`);
    check('and reports no differences', unknown.differences.length === 0);
    check(
      'and never reads as the row being absent',
      !/not found|no such|does not exist|nothing found/i.test(unknown.reason),
    );
    check(
      'and never repeats the provider text back',
      !unknown.reason.includes('EXAMPLE-NOT-A-REAL-KEY-deliberately-wrong-for-this-check'),
    );
    console.log(`    ${unknown.reason}`);

    const unreachable = createMcpClient({
      config: { ...mcpConfig, url: 'https://cockroachlabs.cloud/mcp-does-not-exist', timeoutMs: 4_000 },
    });
    const down = await verifyMemory(unreachable, {
      database,
      schema: dbConfig.schema,
      workspaceId: WORKSPACE,
      memoryId: written.id,
      memory: written,
    });
    check('an unreachable endpoint produces UNKNOWN too', down.verdict === 'UNKNOWN', `(${down.verdict})`);

    console.log(`\n  ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    await db
      .query(
        `DELETE FROM ${quoteIdentifier(dbConfig.schema)}.${quoteIdentifier('memory_audit')} WHERE workspace_id = $1`,
        [WORKSPACE],
      )
      .catch(() => undefined);
    await db
      .query(
        `DELETE FROM ${quoteIdentifier(dbConfig.schema)}.${quoteIdentifier('memory')} WHERE workspace_id = $1`,
        [WORKSPACE],
      )
      .catch(() => undefined);
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`\n[verify-mcp] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
