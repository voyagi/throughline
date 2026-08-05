import { useEffect, useState } from 'preact/hooks';
import { getStatus } from '../scripts/api.ts';
import type { LampState, StatusResponse } from '../scripts/types.ts';

/**
 * The annunciator rail.
 *
 * IT STARTS UNLIT, and that is the honest starting state rather than a loading skeleton. A static
 * page is built long before anyone asks the cluster anything, so at first paint the true answer to
 * "is the vector index available" is that nobody has looked. UNKNOWN renders as an unlit lamp with
 * no colour, per the colour law in ART-DIRECTION section 3, and an unlit lamp must never read as
 * an OK lamp.
 *
 * If the API answers, the lamps light from a real probe. If it does not, they stay exactly as they
 * were and the rail says when it last tried. A rail that invented OK because it could not reach
 * the server would be the product's own headline failure, committed by the product's own chrome.
 */

const PENDING: readonly { name: string; state: LampState; detail: string }[] = [
  { name: 'Vector index', state: 'UNKNOWN', detail: 'Nobody has asked the cluster yet.' },
  { name: 'Embeddings', state: 'UNKNOWN', detail: 'Nobody has asked the cluster yet.' },
  { name: 'MCP transport', state: 'UNKNOWN', detail: 'Nobody has asked the cluster yet.' },
];

const classFor = (state: LampState) =>
  state === 'OK' ? 'state s-ok' : state === 'DEGRADED' ? 'state s-deg' : 'state s-unk';

interface Props {
  readonly apiBase: string;
}

export default function Annunciator({ apiBase }: Props) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [looked, setLooked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getStatus(apiBase).then((result) => {
      if (!live) return;
      // A failure leaves `status` null, so the lamps stay unlit. The attempt is still recorded:
      // "we looked and could not tell" is a different fact from "nobody looked", and the rail is
      // the one place on the site that has to keep those apart.
      if (result.ok) setStatus(result.value);
      setLooked(new Date().toISOString());
    });
    return () => {
      live = false;
    };
  }, [apiBase]);

  const lamps = status?.lamps ?? PENDING;
  const observedAt = status?.observedAt ?? looked;

  return (
    <dl class="annunciator" aria-label="System capability" aria-live="polite">
      {lamps.map((lamp) => (
        <div class="lamp" key={lamp.name}>
          <dt>{lamp.name}</dt>
          <dd>
            <span class={classFor(lamp.state)}>{lamp.state}</span>
            <span class="sr-only">. {lamp.detail}</span>
          </dd>
        </div>
      ))}
      <div class="lamp">
        <dt>Last looked</dt>
        <dd>
          {/* Keyed off `status`, NOT off whether an attempt was made. The first version went green
              the moment the fetch RESOLVED, which included resolving to a failure, so a console
              that could not reach the API at all showed a lit lamp with a timestamp beside three
              unlit ones. A lamp that reports the clock as a success is the same error this rail
              exists to prevent, made by the rail. */}
          <span class={status === null ? 'state s-unk' : 'state s-ok'}>
            {observedAt === null ? 'NEVER' : observedAt.slice(11, 19) + 'Z'}
          </span>
          <span class="sr-only">
            . {observedAt === null
              ? 'Nobody has probed the system from this page yet.'
              : status === null
                ? 'The console tried to reach the API and could not, so the lamps above are still unlit.'
                : 'These lamps were lit by a probe at that time.'}
          </span>
        </dd>
      </div>
    </dl>
  );
}
