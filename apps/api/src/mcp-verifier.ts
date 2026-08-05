/**
 * The verification channel: read the same memory back through a different door and say what you
 * find, including when the answer is that you could not look.
 *
 * ADR 0003 argues that routing ordinary recall through the managed MCP server would be slower than
 * a direct query and ornamental besides. This is the use that is not ornamental. The application
 * reads a memory over the Postgres wire protocol with the `pg` driver and its own connection pool;
 * this reads the same row over HTTPS, JSON-RPC, a service account key and the vendor's own query
 * service. Nothing but the cluster is shared. When the two agree, the agreement is worth something.
 *
 * Three rules, each of which has a specific failure it is preventing:
 *
 * NO CALLER TEXT EVER REACHES A QUERY. `select_query` takes a string, which makes it the obvious
 * injection surface in an otherwise typed system. The query here is a constant with two validated
 * identifiers interpolated: a UUID that must match the UUID shape exactly, and a workspace id that
 * must match a narrow character class. Neither is escaped, both are refused. Escaping is a thing
 * you get right most of the time.
 *
 * THE PAYLOAD IS SMALL BY CONSTRUCTION. Measured 2026-08-04: this channel dies with "max result
 * size exceeded" a little past 10 KB of result text, which a single memory with a long `content`
 * can exceed on its own. So `content` is compared as an md5 digest computed inside the database,
 * against the same digest computed here over the same bytes. CockroachDB's `md5()` and Node's agree
 * on all five samples tested, including 5000 characters and non-ASCII text. A 120 character prefix
 * travels too, for describing a disagreement rather than for detecting one.
 *
 * A FAILED CHECK IS NEVER A PASSED CHECK, AND NEVER A DISAGREEMENT EITHER. Every failure of the
 * transport produces UNKNOWN with a reason. The one thing this file must never do is let "the
 * channel is down" render as "the database does not have your row", because that reads as the most
 * alarming possible finding and is in fact no finding at all.
 */

import { createHash } from 'node:crypto';
import type { MemoryRecord } from '@throughline/memory';
import { McpError, type McpClient, type McpFailureKind } from './mcp-client.ts';

/** A memory id is a UUID and nothing else is accepted into a query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A workspace id is application-controlled, but "application-controlled" is exactly what everyone
 * says right before a demo grows a workspace picker. The class below covers every workspace this
 * product creates and contains no quote, backslash, semicolon, whitespace or comment marker.
 */
const WORKSPACE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A bare lowercase SQL identifier, matching the rule `loadDatabaseConfig` enforces on the schema. */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * The fields this channel actually compares, named so that nobody has to infer the coverage.
 *
 * `embedding` is deliberately absent and its absence is reported rather than left to be noticed:
 * `MemoryRecord` does not carry the vector, so there is nothing on the application side to compare
 * a database vector against. What the channel CAN see about it travels as an observation instead,
 * clearly separated from the comparison.
 */
export const COMPARED_FIELDS = [
  'id',
  'workspaceId',
  'kind',
  'content (md5)',
  'provenance.assertedBy',
  'provenance.incidentId',
  'provenance.sourceRef',
  'createdAt',
  'lastConfirmedAt',
  'confirmCount',
  'contradictCount',
  'validFrom',
  'validUntil',
  'supersededBy',
  'protectedUntil',
  'evictedAt',
  'evictionReason',
] as const;

export const NOT_COMPARED = [
  'embedding: the application record type does not carry the vector, so there is no local value ' +
    'to compare. Whether the row has one, and which model produced it, travel as observations.',
  'timestamps below one millisecond: this channel returns microseconds and the application holds ' +
    'a JavaScript Date, which cannot. Comparison is at millisecond granularity.',
] as const;

export type VerificationVerdict = 'AGREES' | 'DIVERGES' | 'UNKNOWN';

export interface FieldDifference {
  /** The name as the application knows it, matching an entry in COMPARED_FIELDS. */
  readonly field: string;
  /** What the application read over the Postgres wire protocol. */
  readonly application: string;
  /** What the managed MCP server returned for the same row. */
  readonly channel: string;
}

export interface ChannelObservation {
  readonly label: string;
  readonly value: string;
}

export interface VerificationReport {
  readonly verdict: VerificationVerdict;
  readonly memoryId: string;
  readonly workspaceId: string;
  readonly checkedAt: Date;
  readonly elapsedMs: number;
  /** Always populated and written for a human. For UNKNOWN it is the only useful field. */
  readonly reason: string;
  readonly comparedFields: readonly string[];
  readonly notCompared: readonly string[];
  readonly differences: readonly FieldDifference[];
  /** Read over the channel and reported, but not compared against anything. */
  readonly observations: readonly ChannelObservation[];
  /** Set when the verdict is UNKNOWN, so a caller can branch on the cause without reading prose. */
  readonly failure: McpFailureKind | null;
}

export interface VerifyMemoryRequest {
  readonly database: string;
  readonly schema: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  /**
   * What the application believes, or null when it believes the memory does not exist.
   *
   * Null is a real and useful case rather than an edge one: "the application says this id is not
   * there, and the database agrees" is a verification, and it is the direction that catches a read
   * path filtering rows out by mistake.
   */
  readonly memory: MemoryRecord | null;
}

/**
 * The projection, as expression and result name together.
 *
 * One list, used to BUILD the query and to CHECK what came back, because those two are the classic
 * pair that drifts. If a column ever stops being selected, the presence check below turns the
 * verification into UNKNOWN instead of letting the comparison quietly succeed on a field nobody
 * looked at, which is what would happen otherwise for any field whose application value is null:
 * absent and null both read as "nothing there" unless something insists on the difference.
 */
export const VERIFICATION_COLUMNS: ReadonlyArray<{ expression: string; column: string }> = [
  { expression: 'id', column: 'id' },
  { expression: 'workspace_id', column: 'workspace_id' },
  { expression: 'kind', column: 'kind' },
  { expression: 'md5(content) AS content_md5', column: 'content_md5' },
  { expression: 'char_length(content) AS content_length', column: 'content_length' },
  { expression: 'left(content, 120) AS content_prefix', column: 'content_prefix' },
  { expression: 'asserted_by', column: 'asserted_by' },
  { expression: 'incident_id', column: 'incident_id' },
  { expression: 'source_ref', column: 'source_ref' },
  { expression: 'created_at', column: 'created_at' },
  { expression: 'last_confirmed_at', column: 'last_confirmed_at' },
  { expression: 'confirm_count', column: 'confirm_count' },
  { expression: 'contradict_count', column: 'contradict_count' },
  { expression: 'valid_from', column: 'valid_from' },
  { expression: 'valid_until', column: 'valid_until' },
  { expression: 'superseded_by', column: 'superseded_by' },
  { expression: 'protected_until', column: 'protected_until' },
  { expression: 'evicted_at', column: 'evicted_at' },
  { expression: 'eviction_reason', column: 'eviction_reason' },
  { expression: 'embedding_model', column: 'embedding_model' },
  { expression: '(embedding IS NULL) AS embedding_is_null', column: 'embedding_is_null' },
];

/** Which of the expected columns the channel did not return. Empty means the row is complete. */
export function missingColumns(row: Record<string, unknown>): string[] {
  return VERIFICATION_COLUMNS.filter(({ column }) => !(column in row)).map(({ column }) => column);
}

/**
 * The one query this channel sends, with two validated identifiers in it and nothing else.
 *
 * Every column is small. `content` never travels: only its digest, its length and a short prefix,
 * because the transport cannot carry a large row and a verification that fails on long memories
 * would be a verification of short memories.
 */
export function buildVerificationQuery(schema: string, workspaceId: string, memoryId: string): string {
  if (!SCHEMA_NAME.test(schema)) {
    throw new McpError(
      'query_not_bounded',
      `The schema name ${JSON.stringify(schema)} is not a bare lowercase SQL identifier, so it is ` +
        'refused rather than quoted into a query.',
    );
  }
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new McpError(
      'query_not_bounded',
      'The workspace id contains characters this channel will not put into a query. It is refused ' +
        'rather than escaped, because escaping is the thing that works until it does not.',
    );
  }
  if (!UUID.test(memoryId)) {
    throw new McpError(
      'query_not_bounded',
      'The memory id is not a UUID. The verification endpoint accepts an identifier and nothing ' +
        'else, so this is refused before any query exists.',
    );
  }

  const projection = VERIFICATION_COLUMNS.map(({ expression }) => expression).join(', ');
  return (
    `SELECT ${projection} FROM ${schema}.memory ` +
    `WHERE id = '${memoryId}' AND workspace_id = '${workspaceId}'`
  );
}

/** The digest the database computes over `content`, computed here over the same bytes. */
export function contentDigest(content: string): string {
  return createHash('md5').update(content, 'utf8').digest('hex');
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Both sides of a timestamp, as epoch milliseconds.
 *
 * The channel sends microseconds ("2026-08-04T11:55:43.795479Z") and the application holds a Date,
 * which stops at milliseconds. Comparing the strings would report a difference on every row of a
 * perfectly consistent database, which is precisely the transport-manufactured disagreement this
 * whole component exists to avoid producing.
 */
function asMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function asCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function renderMillis(millis: number | null): string {
  return millis === null ? 'null' : new Date(millis).toISOString();
}

function renderText(text: string | null): string {
  return text === null ? 'null' : text;
}

/**
 * Compare what the application read against what the channel read, field by field.
 *
 * Pure and total, so the whole comparison is testable without a network, a database or a clock.
 * The row argument is `Record<string, unknown>` because that is honestly what arrives: JSON decoded
 * from a text block, with the database's types flattened into strings, numbers, booleans and null.
 */
export function compareMemoryToRow(
  memory: MemoryRecord,
  row: Record<string, unknown>,
): FieldDifference[] {
  const differences: FieldDifference[] = [];

  const text = (field: string, mine: string | null, column: string): void => {
    const theirs = asText(row[column]);
    if (mine !== theirs) {
      differences.push({ field, application: renderText(mine), channel: renderText(theirs) });
    }
  };

  const stamp = (field: string, mine: Date | null, column: string): void => {
    const mineMillis = mine === null ? null : mine.getTime();
    const theirs = asMillis(row[column]);
    if (mineMillis !== theirs) {
      differences.push({
        field,
        application: renderMillis(mineMillis),
        channel: renderMillis(theirs),
      });
    }
  };

  const count = (field: string, mine: number, column: string): void => {
    const theirs = asCount(row[column]);
    if (theirs === null || mine !== theirs) {
      differences.push({
        field,
        application: String(mine),
        channel: theirs === null ? 'null' : String(theirs),
      });
    }
  };

  text('id', memory.id, 'id');
  text('workspaceId', memory.workspaceId, 'workspace_id');
  text('kind', memory.kind, 'kind');

  const mineDigest = contentDigest(memory.content);
  const theirDigest = asText(row['content_md5']);
  if (mineDigest !== theirDigest) {
    const length = asText(row['content_length']) ?? 'unknown';
    const prefix = asText(row['content_prefix']);
    differences.push({
      field: 'content (md5)',
      application: `${mineDigest} (${memory.content.length} characters)`,
      channel:
        `${renderText(theirDigest)} (${length} characters` +
        (prefix === null ? ')' : `, beginning ${JSON.stringify(prefix.slice(0, 60))})`),
    });
  }

  text('provenance.assertedBy', memory.provenance.assertedBy, 'asserted_by');
  text('provenance.incidentId', memory.provenance.incidentId, 'incident_id');
  text('provenance.sourceRef', memory.provenance.sourceRef, 'source_ref');

  stamp('createdAt', memory.createdAt, 'created_at');
  stamp('lastConfirmedAt', memory.lastConfirmedAt, 'last_confirmed_at');
  count('confirmCount', memory.confirmCount, 'confirm_count');
  count('contradictCount', memory.contradictCount, 'contradict_count');
  stamp('validFrom', memory.validFrom, 'valid_from');
  stamp('validUntil', memory.validUntil, 'valid_until');
  text('supersededBy', memory.supersededBy, 'superseded_by');
  stamp('protectedUntil', memory.protectedUntil, 'protected_until');
  stamp('evictedAt', memory.evictedAt, 'evicted_at');
  text('evictionReason', memory.evictionReason, 'eviction_reason');

  return differences;
}

/** What the channel saw that the application record has no field for. Reported, never compared. */
export function observationsFrom(row: Record<string, unknown>): ChannelObservation[] {
  const observations: ChannelObservation[] = [];
  const isNull = row['embedding_is_null'];
  if (typeof isNull === 'boolean') {
    observations.push({
      label: 'embedding present in the database',
      value: isNull ? 'no' : 'yes',
    });
  }
  const model = asText(row['embedding_model']);
  observations.push({
    label: 'embedding model recorded on the row',
    value: model === null ? 'none' : model,
  });
  const length = asText(row['content_length']);
  if (length !== null) {
    observations.push({ label: 'content length in the database', value: `${length} characters` });
  }
  return observations;
}

/**
 * Read one memory back over the managed MCP server and report what the two channels say.
 *
 * Takes the application's record rather than a database handle, so the comparison stays pure, the
 * dependency direction stays one way, and the caller keeps the audit write it is already holding a
 * connection for.
 */
export async function verifyMemory(
  client: McpClient,
  request: VerifyMemoryRequest,
  clock: () => Date = () => new Date(),
): Promise<VerificationReport> {
  const { memory, memoryId, workspaceId } = request;
  if (memory && (memory.id !== memoryId || memory.workspaceId !== workspaceId)) {
    // A caller mistake, not a finding. Reporting it as a divergence would be this component
    // inventing evidence about the database from a bug in its own call site.
    throw new Error(
      `verifyMemory was asked about memory ${memoryId} in workspace ${workspaceId} but handed a ` +
        `record for ${memory.id} in ${memory.workspaceId}.`,
    );
  }

  const startedAt = Date.now();
  const base = {
    memoryId,
    workspaceId,
    comparedFields: COMPARED_FIELDS as readonly string[],
    notCompared: NOT_COMPARED as readonly string[],
  };

  let rows: readonly Record<string, unknown>[];
  try {
    const sql = buildVerificationQuery(request.schema, workspaceId, memoryId);
    // Two, for a lookup that can return at most one. A second row would mean the primary key or the
    // workspace filter is not doing what this query assumes, and asking for exactly one would hide
    // that behind the bound instead of surfacing it.
    const result = await client.select({ database: request.database, sql, limit: 2 });
    rows = result.rows;
  } catch (error) {
    const failure = error instanceof McpError ? error.kind : 'server_error';
    const sentence =
      error instanceof McpError
        ? error.message
        : 'The verification channel failed in a way this code does not recognise, so nothing was ' +
          'read and nothing is known.';
    return {
      ...base,
      verdict: 'UNKNOWN',
      checkedAt: clock(),
      elapsedMs: Date.now() - startedAt,
      reason: sentence,
      differences: [],
      observations: [],
      failure,
    };
  }

  const checkedAt = clock();
  const elapsedMs = Date.now() - startedAt;

  if (rows.length > 1) {
    return {
      ...base,
      verdict: 'UNKNOWN',
      checkedAt,
      elapsedMs,
      reason:
        `The verification channel returned ${rows.length} rows for a primary key lookup, which ` +
        'should be impossible. Something about the query or the table is not what this check ' +
        'assumes, so its answer is not trustworthy in either direction.',
      differences: [],
      observations: [],
      failure: 'unrecognised_envelope',
    };
  }

  // SHAPE, never truthiness. `rows[0]` being null, 0, false or "" would skip every row branch below
  // and fall through to "the application holds this memory and an independent read does not find
  // it" with `failure: null`, indistinguishable from a real divergence. That is a claim about the
  // DATABASE manufactured from the SHAPE of a response, and it is the one output this file exists
  // to prevent. `readRows` refuses such a row at the wire boundary; this is the second control,
  // because `McpClient` is an interface and the wire is not the only way a row can arrive.
  const first: unknown = rows.length > 0 ? rows[0] : undefined;
  const row =
    first !== null && typeof first === 'object' && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : undefined;

  if (rows.length > 0 && row === undefined) {
    return {
      ...base,
      verdict: 'UNKNOWN',
      checkedAt,
      elapsedMs,
      reason:
        'The verification channel returned something in the row position that is not a row object, ' +
        'so there is nothing to compare. Nothing is claimed about this memory in either direction: ' +
        'an unreadable answer is not an absent row.',
      differences: [],
      observations: [],
      failure: 'unrecognised_envelope',
    };
  }

  // The four presence cases, with both-present FIRST so the narrowing falls out of the control
  // flow. Ordering them the other way round needs an unreachable guard at the end to convince the
  // type checker, and an unreachable branch in a component about honest reporting is a bad joke.
  // A row that is missing columns is not a row that disagrees. It is a read that did not cover what
  // this check claims to cover, and the difference matters most where it is least visible: for any
  // field whose application value is null, an absent column compares equal, so the report would say
  // AGREES about a column nobody returned.
  const absent = row ? missingColumns(row) : [];
  if (row && absent.length > 0) {
    return {
      ...base,
      verdict: 'UNKNOWN',
      checkedAt,
      elapsedMs,
      reason:
        `The verification channel returned a row without ${absent.length} of the columns this ` +
        `check compares (${absent.join(', ')}). The comparison would have passed on some of them ` +
        'by accident, because a column that is not there and a column that is null look the same ' +
        'from here. Nothing is claimed about this memory either way.',
      differences: [],
      observations: observationsFrom(row),
      failure: 'unrecognised_envelope',
    };
  }

  if (row && memory) {
    const differences = compareMemoryToRow(memory, row);
    const observations = observationsFrom(row);

    if (differences.length === 0) {
      return {
        ...base,
        verdict: 'AGREES',
        checkedAt,
        elapsedMs,
        reason:
          `All ${COMPARED_FIELDS.length} compared fields match between the application's read and ` +
          'an independent read of the same row over the managed MCP server. Two transports, two ' +
          'credentials, two code paths, one answer.',
        differences: [],
        observations,
        failure: null,
      };
    }

    return {
      ...base,
      verdict: 'DIVERGES',
      checkedAt,
      elapsedMs,
      reason:
        `${differences.length} of ${COMPARED_FIELDS.length} compared fields disagree between the ` +
        'application and an independent read of the same row. A divergence is a finding, not a ' +
        'warning: one of the two channels is wrong about a memory that something is relying on.',
      differences,
      observations,
      failure: null,
    };
  }

  if (row) {
    return {
      ...base,
      verdict: 'DIVERGES',
      checkedAt,
      elapsedMs,
      reason:
        'The application reports no such memory, but an independent read of the same cluster ' +
        'returns a row for that id. The application read path is filtering out a row that exists.',
      differences: [{ field: '(the row itself)', application: 'not found', channel: 'present' }],
      observations: observationsFrom(row),
      failure: null,
    };
  }

  if (memory) {
    return {
      ...base,
      verdict: 'DIVERGES',
      checkedAt,
      elapsedMs,
      reason:
        'The application holds this memory but an independent read of the same cluster does not ' +
        'find it. Either the write did not land where the application believes it did, or the two ' +
        'channels are pointed at different databases. Settled by measurement rather than assumed ' +
        'to be a timing artifact: this channel reads the present, and a row written over the ' +
        'application path was visible here 436 ms later.',
      differences: [{ field: '(the row itself)', application: 'present', channel: 'not found' }],
      observations: [],
      failure: null,
    };
  }

  return {
    ...base,
    verdict: 'AGREES',
    checkedAt,
    elapsedMs,
    reason:
      'Both channels agree this memory does not exist. The application found no row and an ' +
      'independent read of the same cluster found none either.',
    differences: [],
    observations: [],
    failure: null,
  };
}
