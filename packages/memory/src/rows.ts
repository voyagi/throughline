import type { MemoryKind, MemoryRecord } from './types.ts';
import { MEMORY_KINDS } from './types.ts';

/**
 * Translation between database rows and memory records.
 *
 * Pure and total: no database handle, no clock. Every function here either produces a valid value
 * or throws with a message naming the row, because a half-parsed memory that flows on silently is
 * worse than a loud failure at the boundary.
 */

/** The shape a `SELECT *` on the memory table returns. */
export interface MemoryRow {
  id: string;
  workspace_id: string;
  kind: string;
  content: string;
  embedding: string | null;
  embedding_model: string | null;
  asserted_by: string;
  incident_id: string | null;
  source_ref: string | null;
  created_at: Date;
  last_confirmed_at: Date;
  confirm_count: string | number;
  contradict_count: string | number;
  valid_from: Date;
  valid_until: Date | null;
  superseded_by: string | null;
  protected_until: Date;
  evicted_at: Date | null;
  eviction_reason: string | null;
}

const KNOWN_KINDS = new Set<string>(MEMORY_KINDS);

export function rowToMemory(row: MemoryRow): MemoryRecord {
  if (!KNOWN_KINDS.has(row.kind)) {
    // The database has a CHECK for this, so reaching here means the constraint and this code
    // disagree, which is worth failing on rather than coercing to a default kind.
    throw new Error(
      `Memory ${row.id} has kind "${row.kind}", which this code does not know. ` +
        'The database CHECK constraint and MEMORY_KINDS have diverged.',
    );
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as MemoryKind,
    content: row.content,
    provenance: {
      assertedBy: row.asserted_by,
      incidentId: row.incident_id,
      sourceRef: row.source_ref,
    },
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
    confirmCount: toCount(row.confirm_count, row.id, 'confirm_count'),
    contradictCount: toCount(row.contradict_count, row.id, 'contradict_count'),
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersededBy: row.superseded_by,
    protectedUntil: row.protected_until,
    evictedAt: row.evicted_at,
    evictionReason: row.eviction_reason,
  };
}

/**
 * CockroachDB INT8 arrives as a STRING through the pg driver, because 64 bits do not fit a JS
 * number safely. These counters are small, so a number is correct here, but the conversion has to
 * be explicit: `row.confirm_count + 1` on a string silently produces "01".
 */
function toCount(value: string | number, id: string, column: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Memory ${id} has a non-numeric ${column}: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Format a vector for a bind parameter.
 *
 * CockroachDB accepts the pgvector text form, `[1,2,3]`. Rejecting a non-finite component rather
 * than letting it through: NaN in an embedding poisons every distance it participates in, and the
 * resulting ranking looks plausible rather than broken.
 */
export function formatVector(values: readonly number[]): string {
  if (values.length === 0) throw new Error('Cannot store an empty embedding');
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`Embedding contains a non-finite component: ${String(value)}`);
    }
  }
  return `[${values.join(',')}]`;
}

/**
 * Parse the text form CockroachDB returns for a VECTOR column.
 *
 * Returns null for a null column, which is a real state: a memory can be written before it has
 * been embedded, and the schema enforces only that the vector and its model travel together.
 */
export function parseVector(raw: string | null): number[] | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error(`Expected a vector in [a,b,c] form, received: ${trimmed.slice(0, 40)}`);
  }
  const body = trimmed.slice(1, -1).trim();
  if (body.length === 0) return [];
  const parts = body.split(',');
  const values = new Array<number>(parts.length);
  for (let index = 0; index < parts.length; index += 1) {
    const value = Number((parts[index] as string).trim());
    if (!Number.isFinite(value)) {
      throw new Error(`Vector component ${index} is not a finite number: ${parts[index]}`);
    }
    values[index] = value;
  }
  return values;
}
