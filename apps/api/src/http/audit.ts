import type { Database } from '@throughline/memory';
import { quoteIdentifier } from '@throughline/memory';
import type { VerificationReport } from '../mcp-verifier.ts';

/**
 * The audit row for a verification.
 *
 * `memory_audit` already permits the `verify` operation: the table's CHECK constraint has listed it
 * since migration 001, and it was the one permitted value nothing produced. This is the writer.
 *
 * WHY THE ACTOR IS NOT THE CLIENT ADDRESS. An IP address is personal data under the GDPR, this demo
 * serves the EU, and an audit table is the worst place to discover that: rows here deliberately
 * outlive the memories they describe, so a retention policy for the memory does not cover them. The
 * actor records WHICH SURFACE asked, which is the thing an operator reading this table actually
 * needs, and it carries no personal data to have to delete later.
 *
 * The detail is a SUMMARY rather than the whole report. The report carries observations read off the
 * verification channel, and an audit row that grows with whatever a server returned is a row whose
 * size nobody controls.
 */

/** The one actor string this surface writes. A constant so a test can assert it and mean it. */
export const CONSOLE_ACTOR = 'user:console';

export interface RecordVerificationOptions {
  readonly database: Database;
  readonly schema: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly report: VerificationReport;
}

export async function recordVerification(options: RecordVerificationOptions): Promise<void> {
  const { database, schema, workspaceId, memoryId, report } = options;
  const table = `${quoteIdentifier(schema)}.${quoteIdentifier('memory_audit')}`;

  const detail = {
    verdict: report.verdict,
    reason: report.reason,
    elapsedMs: report.elapsedMs,
    differences: report.differences.length,
    // Null when the verdict is not UNKNOWN. Recorded either way so a query can count causes without
    // parsing prose, which is the same reason `McpError` carries a `kind`.
    failure: report.failure,
  };

  await database.query(
    `INSERT INTO ${table} (workspace_id, memory_id, operation, actor, detail)
     VALUES ($1, $2, 'verify', $3, $4)`,
    [workspaceId, memoryId, CONSOLE_ACTOR, JSON.stringify(detail)],
  );
}
