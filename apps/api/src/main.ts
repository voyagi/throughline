import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  createDatabase,
  createLocalEmbedder,
  createRepository,
  loadDatabaseConfig,
  loadEmbeddingConfig,
  probeCapabilities,
  retrievalPathFor,
} from '@throughline/memory';
import { createChatModel } from './agent/local-model.ts';
import { databaseNameOf } from './cli/live-channels.ts';
import { createMcpClient, loadMcpConfig } from './mcp-client.ts';
import { createDemoBudget } from './http/demo-budget.ts';
import { loadDemoLimits } from './http/limits.ts';
import { clientAddressFrom } from './http/rate-limit.ts';
import { createApp, SERVER_NAME } from './server.ts';

/**
 * The process entry point.
 *
 * Separate from `server.ts` so that file can be imported by a test without starting a listener, and
 * separate WITHOUT a self-execution guard, because the guard is the trap: this repository has a
 * gate that did nothing for weeks because `process.argv[1] === fileURLToPath(import.meta.url)` is
 * false through a junction. Here there is no condition to be wrong about. Importing this module
 * starts a server; that is the whole contract.
 *
 * The capability probe runs at boot, before the listener opens, because the repository needs its
 * answer and because a server that reports what it can do should have asked.
 */

const PORT = Number(process.env['PORT'] ?? 8787);

/** Loopback, never every interface. A demo bound wider than this is a demo on somebody's network. */
const HOST = process.env['HOST'] ?? '127.0.0.1';

async function main(): Promise<void> {
  const env = process.env;
  const limits = loadDemoLimits(env);
  const dbConfig = loadDatabaseConfig(env);
  const embeddingConfig = loadEmbeddingConfig(env);

  const database = createDatabase(dbConfig);

  // REFUSED rather than silently substituted, matching what `createChatModel` does for the agent
  // one call below and what `probe.ts` does for the same setting. Reading EMBEDDING_PROVIDER and
  // then always building the local embedder would mean an operator who set `bedrock` gets hash
  // embeddings and is told nothing, which is the same dishonesty as an offline model answering as
  // though it were the hosted one. The Bedrock embedder exists; wiring it needs the model id and
  // the width read off a live account, and that is blocked on the owner rather than on this file.
  if (embeddingConfig.provider !== 'local') {
    throw new Error(
      `EMBEDDING_PROVIDER is "${embeddingConfig.provider}", and this server only wires the local ` +
        'embedder today. It refuses rather than quietly using hash embeddings under a name that ' +
        'says otherwise. Set EMBEDDING_PROVIDER=local, or wire the Bedrock embedder here.',
    );
  }
  const embedder = createLocalEmbedder(embeddingConfig.dimensions);
  const capabilities = await probeCapabilities(database, {
    schema: dbConfig.schema,
    embedder,
  });

  const retrieval = retrievalPathFor(capabilities);
  console.log(`[boot] ${database.describe()}`);
  console.log(`[boot] retrieval path: ${retrieval.path} (${retrieval.reason})`);

  const app = createApp({
    limits,
    repository: createRepository({
      db: database,
      embedder,
      schema: dbConfig.schema,
      capabilities,
    }),
    model: createChatModel(env),
    budget: createDemoBudget({
      database,
      schema: dbConfig.schema,
      limit: limits.maxAgentCallsPerDay,
      now: () => new Date(),
    }),
    database,
    schema: dbConfig.schema,
    databaseName: databaseNameOf(dbConfig.connectionString),
    workspaceId: env['DEMO_WORKSPACE_ID'] ?? 'demo',
    // Built per call and not at boot: `loadMcpConfig` throws when the channel is unconfigured,
    // which is the normal state offline, and that must not stop the rest of the demo from running.
    openVerificationChannel: () => createMcpClient({ config: loadMcpConfig(env) }),
    clientAddressOf: (c) =>
      clientAddressFrom(
        c.req.header('X-Forwarded-For') ?? null,
        getConnInfo(c).remote.address ?? null,
        limits.trustProxyHeader,
      ),
    now: () => new Date(),
    log: (line) => console.log(line),
  });

  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`[boot] ${SERVER_NAME} listening on http://${HOST}:${info.port}`);
    console.log(
      `[boot] ${limits.ratePerMinute}/minute per client, ${limits.maxAgentCallsPerDay}/day total, ` +
        `origins: ${limits.allowedOrigins.length > 0 ? limits.allowedOrigins.join(', ') : 'none'}`,
    );
  });
}

await main();
