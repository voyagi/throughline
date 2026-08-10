import { useEffect, useState } from 'preact/hooks';
import { getStatus } from '../scripts/api.ts';
import type { ApiFailure } from '../scripts/api.ts';
import { clockOf, describeStatus, type LampReading, type Silence } from '../scripts/status-state.ts';
import type { StatusResponse } from '../scripts/types.ts';

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
 *
 * THE RAIL IS ON FOUR OF THE FIVE PAGES, mounted by `Board.astro` wherever `rail` is not turned off,
 * so a wrong lamp here is wrong nearly everywhere. It reads the same body as `StatusBoard.tsx`
 * through the same `status-state.ts`, and no CAPABILITY lamp's class is derived here. The one class
 * this file derives is the Last looked lamp's, which the module has no lamp reading for because it is
 * this rail's own furniture rather than something the probe reported.
 */

interface Props {
  readonly apiBase: string;
}

/**
 * What the timestamp means, in the five states it can be in.
 *
 * FIVE, AND THIS RAIL SPOKE THREE. It had one sentence for every attempt that did not produce a body,
 * so a visitor whose request was refused by the demo's own daily ceiling was told the console could
 * not reach the API, and a body that arrived and could not be read was told the same. Those are
 * different facts about this product's own API, and this rail is the chrome that claims to keep such
 * things apart.
 */
const SPOKEN: Readonly<Record<Silence, string>> = {
  'nobody-looked': '. Nobody has probed the system from this page yet.',
  unanswered:
    '. The console tried to reach the API and could not, so the lamps above are still unlit.',
  refused: '. The API answered and declined to report, so the lamps above are still unlit.',
  // "SOMETHING ANSWERED" AND NOT "THE API ANSWERED", because on this arm nobody knows who answered.
  // `UNRECOGNISED` is minted for any non 2xx whose body is not a failure shape, which includes a CDN
  // 502 carrying HTML and a load balancer 503 that never reached this product at all. The archive was
  // corrected for exactly this, and the board's closing paragraph already said "Something did
  // answer" while the paragraph above it, minted by `api.ts`, still named the API. That string is
  // shared by all three surfaces and is fixed at its source in the same change as this one.
  unreadable:
    '. Something answered in a shape this rail could not read, so the lamps above are still unlit.',
};

export default function Annunciator({ apiBase }: Props) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [looked, setLooked] = useState<Date | null>(null);

  useEffect(() => {
    let live = true;
    void getStatus(apiBase).then((result) => {
      if (!live) return;
      // A failure leaves `status` null, so the lamps stay unlit. The attempt is still recorded:
      // "we looked and could not tell" is a different fact from "nobody looked", and the rail is
      // the one place on the site that has to keep those apart.
      if (result.ok) setStatus(result.value);
      else setFailure(result.failure);
      setLooked(new Date());
    });
    return () => {
      live = false;
    };
  }, [apiBase]);

  const view = describeStatus({ asked: looked !== null, failure, status });
  const shown = view.kind === 'shown' ? view : null;

  return (
    <dl class="annunciator" aria-label="System capability" aria-live="polite">
      {view.lamps.map((lamp) => (
        <div class="lamp" key={lamp.name}>
          <dt>{lamp.name}</dt>
          <dd>
            <span class={lamp.stateClass}>{lamp.state}</span>
            <span class="sr-only">{spoken(lamp)}</span>
          </dd>
        </div>
      ))}
      <div class="lamp">
        <dt>Last looked</dt>
        <dd>
          {/* Keyed off a READING, not off whether an attempt was made and not off whether a body
              arrived. The first version went green the moment the fetch RESOLVED, which included
              resolving to a failure, so a console that could not reach the API at all showed a lit
              lamp with a timestamp beside three unlit ones. Keying it off the body alone had the
              same fault one step further in: a body this rail cannot read is not a probe either. */}
          <span class={shown === null ? 'state s-unk' : 'state s-ok'}>
            {shown?.clock ?? (looked === null ? 'NEVER' : clockOf(looked))}
          </span>
          <span class="sr-only">
            {view.kind === 'shown' ? '. These lamps were lit by a probe at that time.' : SPOKEN[view.silence]}
          </span>
        </dd>
      </div>
    </dl>
  );
}

/** A lamp read aloud: its reason, and this rail's own remark when it has one. */
function spoken(lamp: LampReading): string {
  return lamp.note === null ? `. ${lamp.detail}` : `. ${lamp.detail} ${lamp.note}`;
}
