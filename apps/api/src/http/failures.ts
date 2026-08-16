import { z } from 'zod';
import { ConfigError, DatabaseError } from '@throughline/memory';
import { McpError } from '../mcp-client.ts';
import { LimitsError } from './limits.ts';

/**
 * Turning a thrown thing into a response, without ever letting it write that response.
 *
 * THE RULE IS STRUCTURAL, NOT A FILTER. No branch below interpolates `error.message`, a stack, a
 * cause, or any other string that came from outside this file. Every sentence a caller can see is
 * a literal written here. That is the difference between "we scrub ARNs out of provider errors" and
 * "a provider error cannot reach the response at all", and only the second one is still true after
 * somebody adds an error class nobody thought about.
 *
 * A scrubber would have to enumerate what a secret looks like. `AccessDeniedException: User
 * arn:aws:sts::123456789012:assumed-role/... is not authorized to perform bedrock:InvokeModel` is
 * the shape this was written against, quoted here with AWS's reserved documentation account id
 * because the real one has no business in a tracked file (gate:artifacts now refuses it by value),
 * and it carries an account id, a role name and a region. The connection string, the MCP API key
 * and the cluster UUID are three more, each with a different shape. Enumerating them is a losing
 * game; not passing the string through is not.
 *
 * The one thing that DOES come from the request is the list of failed FIELD PATHS on a 400, and
 * they are paths only. A zod issue's message can quote what arrived; a path cannot, because it is
 * built from the schema's own keys.
 *
 * The detail a human needs to debug this is not lost, it is LOGGED rather than served. The database
 * layer has already redacted its own errors by the time they reach a log here.
 */

export type FailureStatus = 400 | 413 | 429 | 500 | 502 | 503;

/**
 * A body that was not JSON at all, as opposed to JSON that failed the schema.
 *
 * Its own class rather than matching `SyntaxError`, which is what `Request.json()` actually throws.
 * `SyntaxError` is far too wide a net for a request handler: any genuine syntax failure anywhere
 * downstream would be reported to the caller as "your JSON is malformed", which is a lie that also
 * hides a real bug.
 */
export class MalformedJsonError extends Error {
  override readonly name = 'MalformedJsonError';
}

/** A body refused on SIZE, before it was parsed. Its own class so the caller gets a 413, not a 400. */
export class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

export interface FailureBody {
  /** A stable machine-readable code. The console branches on this, never on the sentence. */
  readonly error: string;
  /** One sentence for a human. Always a literal from this file. */
  readonly detail: string;
  /** Which request fields failed validation. Present only on a 400. */
  readonly fields?: readonly string[];
}

export interface FailureResponse {
  readonly status: FailureStatus;
  readonly body: FailureBody;
  /** Which rule below produced this, so a log line can name it and a test can assert coverage. */
  readonly rule: string;
}

/**
 * The rules, as DATA rather than as a chain of `if` statements.
 *
 * Data because the test that proves nothing leaks has to be able to READ this list. Four rounds of
 * review on `claimsAbsence` in this repository turned on exactly that distinction: a control
 * written from its author's model of a thing can only catch the bug its author already knew about,
 * while a control that iterates the thing itself cannot drift from it. So `failures.test.ts` walks
 * this array, and a rule added without a matching sample turns it red.
 *
 * Order matters and the array is walked in order: the first `matches` wins.
 */
export const FAILURE_RULES: readonly {
  readonly name: string;
  readonly matches: (error: unknown) => boolean;
  readonly status: FailureStatus;
  readonly body: FailureBody;
}[] = [
  {
    name: 'invalid-request',
    matches: (error) => error instanceof z.ZodError,
    status: 400,
    body: {
      error: 'invalid_request',
      detail: 'The request body did not match what this endpoint accepts.',
    },
  },
  {
    name: 'body-too-large',
    matches: (error) => error instanceof BodyTooLargeError,
    status: 413,
    body: {
      error: 'body_too_large',
      detail: 'That request body is larger than this endpoint will read.',
    },
  },
  {
    name: 'malformed-json',
    matches: (error) => error instanceof MalformedJsonError,
    status: 400,
    body: {
      error: 'invalid_request',
      detail: 'The request body was not valid JSON.',
    },
  },
  {
    name: 'database-unreachable',
    matches: (error) => error instanceof DatabaseError,
    status: 503,
    body: {
      error: 'memory_unavailable',
      detail:
        'The memory database did not answer, so this request was not attempted. Nothing was ' +
        'written and nothing was recalled.',
    },
  },
  {
    name: 'verification-channel-failed',
    matches: (error) => error instanceof McpError,
    status: 502,
    body: {
      error: 'verification_unavailable',
      detail:
        'The independent verification channel could not be reached, so this memory was neither ' +
        'confirmed nor contradicted. That is an unknown result, not a clean one.',
    },
  },
  {
    // Reaching a request handler means the process started with configuration it then could not
    // use. A 500 rather than a 503: nothing here will get better by retrying.
    name: 'server-misconfigured',
    matches: (error) => error instanceof ConfigError || error instanceof LimitsError,
    status: 500,
    body: {
      error: 'server_misconfigured',
      detail: 'This server is not configured correctly. The operator has the details in its log.',
    },
  },
];

/**
 * The rule for everything nobody enumerated, which is where a provider error lands.
 *
 * DELIBERATELY NOT a branch matching the Bedrock error classes by name. A name comparison would
 * silently stop matching the day a class is renamed, and the benefit it buys is a 502 instead of a
 * 500. The response is equally safe either way, because it is this literal, so the branch would add
 * a drift surface to improve a status code. The fallback is the safe direction and it is where an
 * `AccessDeniedException` carrying an ARN ends up.
 */
const FALLBACK: FailureResponse = {
  status: 500,
  rule: 'unclassified',
  body: {
    error: 'internal_error',
    detail: 'Something failed inside this server. The operator has the details in its log.',
  },
};

/** The field paths a zod error names. Paths only: an issue's message can quote what arrived. */
export function fieldPathsOf(error: z.ZodError): readonly string[] {
  const paths = new Set<string>();
  for (const issue of error.issues) {
    paths.add(issue.path.length > 0 ? issue.path.join('.') : '(body)');
  }
  return [...paths].sort();
}

export function describeFailure(error: unknown): FailureResponse {
  for (const rule of FAILURE_RULES) {
    if (!rule.matches(error)) continue;
    if (error instanceof z.ZodError) {
      return { status: rule.status, rule: rule.name, body: { ...rule.body, fields: fieldPathsOf(error) } };
    }
    return { status: rule.status, rule: rule.name, body: rule.body };
  }
  return FALLBACK;
}
