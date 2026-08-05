import { useEffect, useState } from 'preact/hooks';
import { getStatus } from '../scripts/api.ts';
import type { ApiFailure } from '../scripts/api.ts';
import type { StatusResponse } from '../scripts/types.ts';

/**
 * `/status` is the annunciator at full size, and this island is the whole page body.
 *
 * THE STARTING STATE IS UNLIT AND THAT IS THE ANSWER, not a placeholder for one. A static page is
 * built long before anyone asks the cluster anything, so before hydration the true answer to every
 * question here is that nobody has looked. What renders then is an unlit lamp with the last-looked
 * line reading NEVER.
 *
 * The three states are never collapsed into two. OK and DEGRADED are measurements. UNKNOWN means
 * the probe could not answer, and it takes no colour at all, because a colour would be a claim
 * nobody earned. An unlit lamp is not an OK lamp, and this page is the one place on the site where
 * getting that wrong would discredit everything else on it.
 */

interface Props {
  readonly apiBase: string;
}

const classFor = (state: string) =>
  state === 'OK' ? 'state s-ok' : state === 'DEGRADED' ? 'state s-deg' : 'state s-unk';

export default function StatusBoard({ apiBase }: Props) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [triedAt, setTriedAt] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getStatus(apiBase).then((result) => {
      if (!live) return;
      if (result.ok) setStatus(result.value);
      else setFailure(result.failure);
      setTriedAt(new Date().toISOString());
    });
    return () => {
      live = false;
    };
  }, [apiBase]);

  const lamps = status?.lamps ?? [
    { name: 'Vector index', state: 'UNKNOWN', detail: 'Nobody has asked the cluster yet.' },
    { name: 'Embeddings', state: 'UNKNOWN', detail: 'Nobody has asked the cluster yet.' },
    { name: 'MCP transport', state: 'UNKNOWN', detail: 'Nobody has asked the cluster yet.' },
  ];

  return (
    <div class="statusboard">
      <div class="bayhead">
        <span class="bayno">Legend</span>
        <h2 class="baylabel">What this system can do right now</h2>
        <p class="baynote">
          Each lamp is lit by a probe that asks the running database, not by configuration and not
          by what was true at boot. Nothing here is inferred from anything else here.
        </p>
      </div>

      <dl class="lamps" aria-live="polite">
        {lamps.map((lamp) => (
          <div class="biglamp" key={lamp.name}>
            <dt>{lamp.name}</dt>
            <dd>
              <span class={classFor(lamp.state)}>{lamp.state}</span>
              <p class={lamp.state === 'UNKNOWN' ? 'why doubt' : 'why'}>{lamp.detail}</p>
            </dd>
          </div>
        ))}
      </dl>

      <div class="rack">
        <div class="strip">
          <span class={status === null ? 'holder h-tomb' : 'holder h-res'}></span>
          <div>
            {/* No target row. The API deliberately does not publish the cluster host, port or
                database name to an unauthenticated caller, so there is nothing here to print. */}
            <div class="row r-three">
              <div class="cell">
                <b>Last looked</b>
                <span class={status === null ? 'val doubt' : 'val'}>
                  {status?.observedAt ?? (triedAt === null ? 'never' : 'tried, no answer')}
                </span>
              </div>
              <div class="cell">
                <b>Answering</b>
                <span class={status === null ? 'val doubt' : 'val'}>{status?.server ?? 'nothing yet'}</span>
              </div>
              <div class="cell">
                <b>Probe</b>
                {/* Three states, not two. Before hydration nothing has been ATTEMPTED, and the
                    built HTML used to ship "did not answer" beside a sibling cell correctly
                    reading "never" - the page contradicting itself on the one question it exists
                    to answer. */}
                <span class={status === null ? 'val doubt' : 'val'}>
                  {triedAt === null ? 'not attempted yet' : status === null ? 'did not answer' : 'answered'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {failure !== null && (
          <div class="empty">
            <span class="holder"></span>
            <div class="slip">
              <span class="k">Refusal slip</span>
              <div class="v">THE PROBE DID NOT ANSWER. VERDICT: UNKNOWN.</div>
              <p>{failure.detail}</p>
              <p>
                The lamps above stay unlit. None of them turned green, and none of them turned
                amber: this page cannot tell you the index is missing, only that it could not ask.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
