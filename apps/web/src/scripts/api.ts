/**
 * The console's client for `apps/api`.
 *
 * ONE RULE, and it is the product's own argument turned on the browser: a failed call is never
 * allowed to look like an empty result. Every function here returns a discriminated union, so
 * there is no shape in which "the API did not answer" and "the API answered with nothing" are the
 * same value. A caller that forgets to check `ok` does not get an empty array, it gets a type
 * error.
 *
 * Nothing here throws. A thrown fetch would land in an error boundary and render as a blank pane,
 * which is the silent-absence failure this whole site exists to argue against.
 */
import { isAgentTurnResponse, isMemoryListResponse, isStatusResponse } from './shapes.ts';
import type {
  AgentTurnResponse,
  FailureResponse,
  MemoryKind,
  MemoryListResponse,
  StatusResponse,
} from './types.ts';

/** The console's name for a failure body, whether the API wrote it or this file did. */
export type ApiFailure = FailureResponse;

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ApiFailure };

/**
 * Long enough for a cold Lambda and a real model call, short enough that a hung request does not
 * leave the pane looking like it is still thinking forever.
 */
const TURN_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 8_000;

/** The console branches on `error`, never on the sentence, so unreachable gets a code of its own. */
const UNREACHABLE = 'api_unreachable';

/**
 * The code for an answer this console could not read a result out of, whatever its status was.
 *
 * IT SAYS NOTHING ABOUT WHETHER THE API REFUSED, and that is the whole point of the wording. It is
 * minted at three sites in this file: an unparseable body on a 200, a 200 whose shape the endpoint's
 * own guard rejects, and `asFailure`, which is reached from the `!response.ok` path whenever a
 * non-2xx does not carry `{error, detail}`. That third site is why a reader must not infer a status
 * from this code. `Archive.tsx` inferred one, and printed a sentence denying that the API had
 * refused, over a 429.
 *
 * A CONSTANT RATHER THAN HAND-TYPED COPIES: three mint sites here, two in `archive-state.ts` and
 * one in `recall-state.ts`, with `Archive.tsx` comparing against it. No total is written down, and
 * that is deliberate. This sentence gave one, a later file added a site, and the number went stale
 * inside a single branch, which is the same failure the constant exists to prevent applied to the
 * prose about it. Two code paths that must agree on a string is the case this repository settles
 * with one shared module, never with a comment asking for care.
 */
const UNRECOGNISED = 'unrecognised_response';

function unreachable(detail: string): ApiFailure {
  return { error: UNREACHABLE, detail };
}

/**
 * A failure body the API did not write, or wrote in a shape this console does not recognise.
 *
 * Reading a response the server did not send as if it were the expected one is how a console ends
 * up printing `undefined` at an operator during an incident. So the parse is checked, and anything
 * unrecognised becomes a named failure rather than a partially filled object.
 */
function asFailure(body: unknown, status: number): ApiFailure {
  if (typeof body === 'object' && body !== null && 'error' in body && 'detail' in body) {
    const candidate = body as { error: unknown; detail: unknown };
    if (typeof candidate.error === 'string' && typeof candidate.detail === 'string') {
      return body as ApiFailure;
    }
  }
  return {
    error: UNRECOGNISED,
    // "SOMETHING ANSWERED", NOT "THE API ANSWERED", and the status code stays because that is the
    // one thing this console does know. This arm is reached for ANY non 2xx whose body is not a
    // failure shape, which includes a CDN 502 carrying HTML and a load balancer 503 that never
    // reached this product at all, so naming the API as the answerer is a claim nobody earned. The
    // archive was corrected once for naming WHO refused and once for naming WHAT was reached, and
    // both status surfaces now word this state as something having answered. This is the string all
    // three read, so it is fixed here rather than three times.
    detail: `Something answered ${status} in a shape this console does not recognise.`,
  };
}

/**
 * What an endpoint requires of a 200 before this console will call it an answer.
 *
 * REQUIRED, not optional, and that is the fix rather than the checking itself. The defect a review
 * found was a property of `call`: it returned `ok: true` for ANY 200 whose body parsed, so `{}`
 * arrived as a success at all three endpoints. The first fix guarded ONE of them, which left the
 * same hole at the other two and no reason a fourth endpoint would be any different. Making this a
 * required argument means a new endpoint cannot be added without someone deciding what a usable
 * answer looks like - an optional validator is a guard the next person silently skips.
 *
 * `unrecognised` is per endpoint because the sentence has to deny the specific wrong conclusion a
 * reader would otherwise draw, and those differ: an empty archive, an unlit lamp, a missing answer.
 */
interface Expectation<T> {
  readonly is: (body: unknown) => body is T;
  readonly unrecognised: string;
}

async function call<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  expect: Expectation<T>,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, failure: asFailure(body, response.status) };
    if (body === null) {
      return {
        ok: false,
        failure: { error: UNRECOGNISED, detail: 'The API answered with a body this console could not read.' },
      };
    }
    if (!expect.is(body)) {
      return { ok: false, failure: { error: UNRECOGNISED, detail: expect.unrecognised } };
    }
    return { ok: true, value: body };
  } catch (error) {
    // The MESSAGE of a fetch failure is a browser string, not a server one, so it carries nothing
    // secret. It is still not shown: "TypeError: Failed to fetch" tells an operator less than the
    // sentence below, and a DOMException from the abort would read as a bug rather than a timeout.
    const timedOut = error instanceof DOMException && error.name === 'AbortError';
    return {
      ok: false,
      failure: unreachable(
        timedOut
          ? `The API did not answer within ${Math.round(timeoutMs / 1000)} seconds. Nothing here says the memory is empty.`
          : 'The API could not be reached from this browser. Nothing here says the memory is empty.',
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function postTurn(apiBase: string, message: string): Promise<ApiResult<AgentTurnResponse>> {
  return call<AgentTurnResponse>(
    `${apiBase}/agent/turn`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    },
    TURN_TIMEOUT_MS,
    {
      is: isAgentTurnResponse,
      unrecognised:
        'The agent answered in a shape this console does not recognise, so there is no answer to ' +
        'show and no receipt behind it. Nothing here says the memory is empty.',
    },
  );
}

export function getStatus(apiBase: string): Promise<ApiResult<StatusResponse>> {
  return call<StatusResponse>(`${apiBase}/status`, { method: 'GET' }, STATUS_TIMEOUT_MS, {
    is: isStatusResponse,
    unrecognised:
      'The status endpoint answered in a shape this console does not recognise, so no lamp here ' +
      'has been measured. An unlit lamp is not an OK lamp.',
  });
}

/**
 * The archive, bounded and filtered.
 *
 * `kinds` is built with `URLSearchParams` rather than by joining strings, because a kind reaching the
 * API unencoded is how a filter silently becomes a different filter. The API refuses a kind it does
 * not know with a 400, which this returns as a named failure rather than as an empty archive.
 *
 * NO `limit` PARAMETER IS SENT. The bound is the API's to choose: it clamps whatever arrives to
 * `policy.listCap` and reports the bound it applied in the receipt, so a console passing its own
 * number would be stating a preference it cannot enforce and would have to be kept in step with a
 * cap it does not own.
 */
export function getMemories(
  apiBase: string,
  kinds: readonly MemoryKind[] = [],
): Promise<ApiResult<MemoryListResponse>> {
  const params = new URLSearchParams();
  for (const kind of kinds) params.append('kind', kind);
  const query = params.toString();
  return call<MemoryListResponse>(
    `${apiBase}/memories${query === '' ? '' : `?${query}`}`,
    { method: 'GET' },
    STATUS_TIMEOUT_MS,
    {
      is: isMemoryListResponse,
      // The sentence denies the conclusion a reader would otherwise draw from an empty rack, which
      // is the specific reason it is written here and not once, generically, inside `call`.
      unrecognised:
        'The archive answered with a body this console does not recognise, so nothing here is a ' +
        'result. It is not an empty archive.',
    },
  );
}

export { UNREACHABLE, UNRECOGNISED };
