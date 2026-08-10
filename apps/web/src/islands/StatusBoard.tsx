import { useEffect, useState } from 'preact/hooks';
import { getStatus } from '../scripts/api.ts';
import type { ApiFailure } from '../scripts/api.ts';
import { describeStatus, type Silence } from '../scripts/status-state.ts';
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
 *
 * WHAT A BODY SAYS IS NOW READ BEFORE IT IS PRINTED, by `status-state.ts`, and no lamp's class or
 * prose is derived here. Two classes are still derived in this file, `valClass` and the receipt
 * strip's holder, and both key off nothing but whether a reading exists. (That said ONE, and a
 * review counted two. The rail's parallel sentence was true and this one was not, in the same
 * commit, which is the asymmetry between two sibling surfaces that this branch exists to catch.)
 * Two derivations of one field is what this page had:
 * the lamp took its colour from `classFor` and the reason took its emphasis from a second comparison
 * against UNKNOWN, so a state neither recognised came out unlit above a reason typeset as a
 * measurement. The rail reads the same body through the same module, because a fix that stopped at
 * one of these two surfaces would be this branch's defect committed by its own remedy.
 */

interface Props {
  readonly apiBase: string;
}

/**
 * The three of the four silences that draw a slip, worded apart. The fourth is nobody having looked,
 * which is not a failure and gets no slip.
 *
 * A TABLE RATHER THAN A TERNARY, and the closing sentence is why. This page carried ONE closing for
 * what are three events, and it read "this page cannot tell you the index is missing, only that it
 * could not ask". That is true when nothing answered and false the moment anything did: a 429 from
 * the demo's own ceiling is the API answering, and a body this board cannot read means the page
 * asked and was answered. One sentence over several events is the defect this branch keeps finding.
 *
 * Keyed by `Silence` minus the state that draws no slip, so a fourth event fails the build here.
 */
const SLIP: Readonly<Record<Exclude<Silence, 'nobody-looked'>, { verdict: string; closing: string }>> = {
  unanswered: {
    verdict: 'THE PROBE DID NOT ANSWER. VERDICT: UNKNOWN.',
    // "ASKED AND NO ANSWER CAME BACK", NOT "COULD NOT ASK", and the difference is the whole product.
    // This closing said the page could not ask, three inches under three lamps saying the page
    // asked, which is the confusion `status-state.ts` names as the headline failure committed by the
    // chrome, in a fresh pair of sentences. It was also false on the commoner of the two events this
    // state covers: `api.ts` mints the same code for a rejected fetch AND for an eight second abort,
    // and on the abort the paragraph directly above this one says the API did not answer in time,
    // which is a page that asked. Worded now from what both events share.
    closing:
      'The lamps above stay unlit. None of them turned green, and none of them turned amber: this ' +
      'page asked and no answer came back, so it cannot tell you the index is missing either way.',
  },
  refused: {
    verdict: 'THE PROBE WAS REFUSED. VERDICT: UNKNOWN.',
    closing:
      'The lamps above stay unlit. The API answered and declined to report, so this page knows ' +
      'nothing about the index either way. That is a fact about the request and not about the cluster.',
  },
  unreadable: {
    verdict: 'THE ANSWER COULD NOT BE READ. VERDICT: UNKNOWN.',
    closing:
      'The lamps above stay unlit. Something did answer, and this page did ask: what came back is ' +
      'not one statement, so no part of it is reported here as a measurement.',
  },
};

/**
 * What happened to the request, in the five states it can actually be in.
 *
 * FIVE, AND THIS PAGE PRINTED THREE. Before hydration nothing has been ATTEMPTED, and the built HTML
 * used to ship "did not answer" beside a sibling cell correctly reading "never". An answer that was
 * refused, and an answer this board cannot read, are two more things again: something replied to
 * both, so "did not answer" would be this page's own false sentence about its own request.
 */
const PROBE: Readonly<Record<Silence, string>> = {
  'nobody-looked': 'not attempted yet',
  unanswered: 'did not answer',
  refused: 'answered and refused',
  unreadable: 'answered unreadably',
};

/**
 * When the cluster was last looked at, when the answer does not say.
 *
 * THE SIBLING CELL, AND THE FIRST VERSION OF THIS COMMIT LEFT IT BEHIND. `PROBE` above was given five
 * states because collapsing them printed a false sentence, and the cell one `div` to the left kept a
 * two arm ternary reading "tried, no answer" for every attempt that produced no body. So a visitor
 * over the daily ceiling saw LAST LOOKED "tried, no answer" beside PROBE "answered and refused", in
 * adjacent cells of one row, above a slip reading THE PROBE WAS REFUSED. A fix that closes one
 * instance and leaves its sibling is this repository's only recurring defect and it was committed
 * here by the change that exists to close it.
 */
const LAST_LOOKED: Readonly<Record<Silence, string>> = {
  'nobody-looked': 'never',
  unanswered: 'tried, nothing answered',
  refused: 'tried, refused',
  unreadable: 'tried, unreadable answer',
};

/**
 * Who answered, when the answer does not say.
 *
 * THE THIRD CELL IN THE SAME ROW, AND THE FIX BEFORE THIS ONE STOPPED AT THE SECOND. `PROBE` and
 * `LAST_LOOKED` became tables over four states because collapsing them printed a sentence the cell
 * beside them contradicted, and `Answering` was left as a two arm ternary reading "nothing yet". So
 * a refused probe rendered "tried, refused" and "answered and refused" on either side of a cell
 * saying nothing had answered yet. One row, three cells, and the third one still disagreeing.
 */
const ANSWERING: Readonly<Record<Silence, string>> = {
  'nobody-looked': 'nothing yet',
  unanswered: 'nobody',
  refused: 'answered, but named nobody',
  unreadable: 'answered, but named nobody',
};

export default function StatusBoard({ apiBase }: Props) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let live = true;
    void getStatus(apiBase).then((result) => {
      if (!live) return;
      if (result.ok) setStatus(result.value);
      else setFailure(result.failure);
      setAsked(true);
    });
    return () => {
      live = false;
    };
  }, [apiBase]);

  // ONE READING, and every cell below reads off it. A shown reading is the only thing on this page
  // entitled to be typeset as a measurement, so it is also the only thing the classes key off.
  const view = describeStatus({ asked, failure, status });
  const shown = view.kind === 'shown' ? view : null;
  const said = view.kind === 'unlit' && view.silence !== 'nobody-looked' ? SLIP[view.silence] : null;
  const valClass = shown === null ? 'val doubt' : 'val';

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
        {view.lamps.map((lamp) => (
          <div class="biglamp" key={lamp.name}>
            <dt>{lamp.name}</dt>
            <dd>
              <span class={lamp.stateClass}>{lamp.state}</span>
              <p class={lamp.doubted ? 'why doubt' : 'why'}>{lamp.detail}</p>
              {lamp.note !== null && <p class="why doubt">{lamp.note}</p>}
            </dd>
          </div>
        ))}
      </dl>

      <div class="rack">
        <div class="strip">
          <span class={shown === null ? 'holder h-tomb' : 'holder h-res'}></span>
          <div>
            {/* No target row. The API deliberately does not publish the cluster host, port or
                database name to an unauthenticated caller, so there is nothing here to print. */}
            <div class="row r-three">
              <div class="cell">
                <b>Last looked</b>
                <span class={valClass}>
                  {view.kind === 'shown' ? view.observedAt : LAST_LOOKED[view.silence]}
                </span>
              </div>
              <div class="cell">
                <b>Answering</b>
                <span class={valClass}>
                  {view.kind === 'shown' ? view.server : ANSWERING[view.silence]}
                </span>
              </div>
              <div class="cell">
                <b>Probe</b>
                <span class={valClass}>{view.kind === 'shown' ? 'answered' : PROBE[view.silence]}</span>
              </div>
            </div>
          </div>
        </div>

        {view.kind === 'unlit' && view.failure !== null && said !== null && (
          <div class="empty">
            <span class="holder"></span>
            <div class="slip">
              <span class="k">Refusal slip</span>
              <div class="v">{said.verdict}</div>
              <p>{view.failure.detail}</p>
              <p>{said.closing}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
