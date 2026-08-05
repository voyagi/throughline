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
import type { AgentTurnResponse, FailureResponse, StatusResponse } from './types.ts';

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
    error: 'unrecognised_response',
    detail: `The API answered ${status} in a shape this console does not recognise.`,
  };
}

async function call<T>(url: string, init: RequestInit, timeoutMs: number): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, failure: asFailure(body, response.status) };
    if (body === null) {
      return {
        ok: false,
        failure: { error: 'unrecognised_response', detail: 'The API answered with a body this console could not read.' },
      };
    }
    return { ok: true, value: body as T };
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
  );
}

export function getStatus(apiBase: string): Promise<ApiResult<StatusResponse>> {
  return call<StatusResponse>(`${apiBase}/status`, { method: 'GET' }, STATUS_TIMEOUT_MS);
}

export { UNREACHABLE };
