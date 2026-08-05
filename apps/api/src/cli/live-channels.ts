import {
  createDatabase,
  createLocalEmbedder,
  loadDatabaseConfig,
  loadEmbeddingConfig,
  type Database,
  type DatabaseConfig,
  type Embedder,
  type EmbeddingConfig,
} from '@throughline/memory';
import { createMcpClient, loadMcpConfig, type McpClient, type McpConfig } from '../mcp-client.ts';

/**
 * Open both channels the same way, once, for every live proof that needs them.
 *
 * The point of these scripts is that two independent paths to the same rows agree. That argument
 * is worth exactly as much as the claim that the two scripts are talking to the same place, and
 * the wiring that establishes it was copied between them: the same seven statements, which the
 * duplication gate reported as a nine line clone, no shared definition,
 * free to drift into two scripts reading two different databases and still printing agreement.
 *
 * The duplication gate is what noticed. It was right to.
 */
export interface LiveChannels {
  readonly dbConfig: DatabaseConfig;
  readonly embeddingConfig: EmbeddingConfig;
  readonly mcpConfig: McpConfig;
  /**
   * The database NAME, which the MCP tools take as an argument while the application takes it
   * inside a connection string. Derived from that one string rather than configured separately, so
   * the two channels cannot be pointed at different databases by a single edit.
   */
  readonly database: string;
  readonly db: Database;
  readonly embedder: Embedder;
  readonly client: McpClient;
}

/**
 * The database NAME, out of the connection string the application already has.
 *
 * A function rather than an expression inside `openLiveChannels`, because the HTTP surface needs
 * the same value and cannot use `openLiveChannels` itself: that one calls `loadMcpConfig` eagerly
 * and `loadMcpConfig` THROWS when the channel is unconfigured, which is the normal state of an
 * offline demo. Copying the one line instead would recreate exactly the drift this module was
 * extracted to prevent, one caller at a time.
 */
export function databaseNameOf(connectionString: string): string {
  return new URL(connectionString).pathname.replace(/^\//, '') || 'defaultdb';
}

export function openLiveChannels(env: Record<string, string | undefined>): LiveChannels {
  const dbConfig = loadDatabaseConfig(env);
  const embeddingConfig = loadEmbeddingConfig(env);
  const mcpConfig = loadMcpConfig(env);

  return {
    dbConfig,
    embeddingConfig,
    mcpConfig,
    database: databaseNameOf(dbConfig.connectionString),
    db: createDatabase(dbConfig),
    embedder: createLocalEmbedder(embeddingConfig.dimensions),
    client: createMcpClient({ config: mcpConfig }),
  };
}
