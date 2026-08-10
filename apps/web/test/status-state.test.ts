import { describe, expect, it } from 'vitest';
import { describeStatus, type StatusInput, type StatusView } from '../src/scripts/status-state.ts';
import type { LampView, StatusResponse } from '../src/scripts/types.ts';

/**
 * The status body's guard, driven directly.
 *
 * WHAT THIS FILE RESTS ON IS THAT `describeStatus` IS TOTAL AND PURE. There is no page here and
 * nothing to hydrate, so no assertion can pass because something failed to render: every one reads a
 * value the function returned. The rendering half is `status-island.test.ts`, which mounts both
 * surfaces. The two files exist for different reasons rather than out of symmetry.
 *
 * NO ASSERTION HERE IS A NEGATIVE, and that is the part of this paragraph that has always been
 * true. A negative guards a WORDING and not a CLAIM: two were added on the previous branch against
 * substrings no rendered string contains, and a third watched a phrase its own commit had deleted
 * from production. A fourth was added by the commit that quoted this rule and deleted in the next.
 *
 * MOST SENTENCES ARE PINNED WHOLE WITH `toBe` AND FOUR ARE NOT, which is what this said before and
 * got wrong by saying every one. The four use `toContain` and all four assert the duplicate-name
 * clause, where the surrounding sentence is already pinned whole by `refuses a body carrying two
 * lamps under one name, and quotes the name`. Pinning the clause alone in the other four keeps five
 * cases readable as five values rather than as five copies of one paragraph. That test is NAMED
 * rather than placed, because the sentence here placed it and was wrong twice over: it sat in the
 * first describe and not the second, and seventh in it rather than at the top.
 */

const AT = '2026-08-09T20:04:05.123Z';

const lamp = (name: string, state: string, detail: string): LampView =>
  ({ name, state, detail }) as LampView;

const THREE: readonly LampView[] = [
  lamp('Vector index', 'OK', 'The planner chooses the vector index for the recall query.'),
  lamp('Embeddings', 'DEGRADED', 'The column holds 1536 dimensions and the embedder produces 1024.'),
  lamp('MCP transport', 'UNKNOWN', 'No verification channel is configured, so nobody has looked.'),
];

const body = (over: Partial<StatusResponse> = {}): StatusResponse => ({
  server: 'throughline-api',
  observedAt: AT,
  lamps: THREE,
  ...over,
});

const answered = (status: StatusResponse): StatusInput => ({ asked: true, failure: null, status });

/** The reading, or a failure naming what the guard did instead. Never a silent cast. */
function shown(input: StatusInput): Extract<StatusView, { kind: 'shown' }> {
  const view = describeStatus(input);
  if (view.kind !== 'shown') {
    throw new Error(`the guard would not show this body: ${view.failure?.detail ?? view.silence}`);
  }
  return view;
}

/** The unlit view, or a failure naming what the guard did instead. */
function unlit(input: StatusInput): Extract<StatusView, { kind: 'unlit' }> {
  const view = describeStatus(input);
  if (view.kind !== 'unlit') throw new Error('the guard showed a body this test expected it to refuse');
  return view;
}

describe('a status body that argues with itself is not shown', () => {
  it('refuses a body whose probe time is not a timestamp, and says which value is not one', () => {
    const view = unlit(answered(body({ observedAt: 'when the cluster felt like it' })));

    expect(view.silence).toBe('unreadable');
    expect(view.failure?.error).toBe('unrecognised_response');
    expect(view.failure?.detail).toBe(
      'The status endpoint answered with a body carrying a value that is not a measurement: it ' +
        'reports "when the cluster felt like it" as when the probe ran, which is not a timestamp in ' +
        'the form this contract declares. No lamp here is lit from it.',
    );
  });

  it.each([
    ['the thirtieth of February', '2026-02-30T20:04:05.123Z', '2026-03-02T20:04:05.123Z'],
    ['the twenty ninth of a February that is not a leap year', '2025-02-29T00:00:00.000Z', '2025-03-01T00:00:00.000Z'],
    ['an hour of 24, which is the sibling the calendar check never looked at', '2026-08-09T24:00:00.000Z', '2026-08-10T00:00:00.000Z'],
    ['an hour of 24 on the last day of the year, which moves the YEAR', '2026-12-31T24:00:00.000Z', '2027-01-01T00:00:00.000Z'],
  ])('refuses a probe time naming %s, which the engine rolls forward', (_label, observedAt, reads) => {
    // MEASURED ON THIS ENGINE RATHER THAN ASSUMED, node v22.22.0 at `f572c95`. `Date.parse` returns
    // NaN for a month of 13, a day of 32 and an hour of 25, so rule 1 catches those, and the shape
    // rule above it passes every one of them. What it ACCEPTS and moves is a day that
    // overflows its own month and an hour of exactly 24. The third row here was SHOWN until this
    // change: the old rule rebuilt the written date and never read the time, so `2026-08-09` was a
    // day that exists and the value passed. The engine reads it as the tenth.
    const view = unlit(answered(body({ observedAt })));

    // The instant the engine actually reads, pinned so the row's third column cannot go stale
    // silently. This is the whole reason the value is refused.
    expect(new Date(Date.parse(observedAt)).toISOString()).toBe(reads);
    expect(view.silence).toBe('unreadable');
    expect(view.failure?.detail).toBe(
      'The status endpoint answered with a body carrying a value that is not a measurement: it ' +
        `reports "${observedAt}" as when the probe ran, which is not an instant that exists as ` +
        'written. No lamp here is lit from it.',
    );
  });

  it.each([
    ['a leap day', '2024-02-29T00:00:00.000Z', '00:00:00Z'],
    ['a century leap day', '2000-02-29T12:30:45.000Z', '12:30:45Z'],
    ['a year the shape rule admits and nothing else here covers', '0000-02-29T00:00:00.000Z', '00:00:00Z'],
    ['the last instant the shape rule admits', '9999-12-31T23:59:59.999Z', '23:59:59Z'],
  ])('still shows %s, which is the half that costs a reader a real answer', (_label, observedAt, clock) => {
    // THE OVER-REFUSAL SIDE, and it is what the round trip identity had to be measured against
    // before it replaced the calendar arithmetic. The rule is now `toISOString` disagreeing with the
    // string, so there is no year handling left in the module to get wrong: the old check rebuilt
    // the date with `setUTCFullYear`, and the comment here used to say 2000 was the year `Date.UTC`
    // would have got wrong. Measured: `Date.UTC(2000, 1, 29)` is correct. Only years 0 to 99 differ,
    // which is why `0000-02-29` is in this list and 2000 alone was never a control for anything.
    expect(shown(answered(body({ observedAt }))).clock).toBe(clock);
  });

  it.each([
    ['an expanded year, which is conforming ISO and rolls the same way', '+002026-02-30T20:04:05.123Z'],
    ['a textual date the engine also accepts and rolls', 'February 30 2026 UTC'],
    ['an offset instead of Z', '2026-08-09T22:04:05+02:00'],
    ['a date with no time in it', '2026-08-09'],
    ['a time with no milliseconds', '2026-08-09T20:04:05Z'],
  ])('refuses a probe time given as %s', (_label, observedAt) => {
    // ONE SHAPE RULE INSTEAD OF A REGEX THAT NEEDS A NEW SIBLING EVERY TIME. The first two of these
    // walked straight past the calendar check, because it was anchored at four digits and neither
    // starts with one, and both roll to the second of March. The rest are forms this page once
    // showed on the argument that they name real instants, which is true and is also the argument
    // that kept the first two open. The producer sends `.toISOString()` and nothing else.
    const view = unlit(answered(body({ observedAt })));

    expect(view.silence).toBe('unreadable');
    expect(view.failure?.detail).toBe(
      'The status endpoint answered with a body carrying a value that is not a measurement: it ' +
        `reports ${JSON.stringify(observedAt)} as when the probe ran, which is not a timestamp in ` +
        'the form this contract declares. No lamp here is lit from it.',
    );
  });

  it('refuses a contract-shaped timestamp that still names no instant at all', () => {
    // THE RULE BETWEEN THE OTHER TWO, and it is reachable: a month of 13 has the right shape, and
    // `Date.parse` returns nothing for it where a day of 30 in February returns the second of March.
    expect(unlit(answered(body({ observedAt: '2026-13-01T00:00:00.000Z' }))).failure?.detail).toBe(
      'The status endpoint answered with a body carrying a value that is not a measurement: it ' +
        'reports "2026-13-01T00:00:00.000Z" as when the probe ran, which is not a time. No lamp ' +
        'here is lit from it.',
    );
  });

  it('refuses a body that names no server as having answered', () => {
    expect(unlit(answered(body({ server: '   ' }))).failure?.detail).toBe(
      'The status endpoint answered with a body carrying a value that is not a measurement: it names ' +
        'no server as having answered. No lamp here is lit from it.',
    );
  });

  it('refuses a body carrying two lamps under one name, and quotes the name', () => {
    const view = unlit(
      answered(
        body({
          lamps: [
            lamp('Vector index', 'OK', 'The planner chooses the vector index.'),
            lamp('Vector index', 'DEGRADED', 'No vector index on the embedding column.'),
          ],
        }),
      ),
    );

    // ITS OWN FIELDS DISAGREE, not a value that is not a measurement. Both names are perfectly good
    // values, and this is the one status rule that compares two of them, so the malformed opening
    // asserted no comparison had happened directly in front of a phrase reporting one.
    // BOTH VALUES ARE NAMED EVEN WHEN THEY ARE IDENTICAL, and that is the case where the older
    // sentence was true. It was false on every other pair, because the comparison is over a name
    // this module derives and no single quoted value can stand for two lamps. One form that is true
    // everywhere beats one that is true here and needs a sibling for each way two names can differ.
    expect(view.failure?.detail).toBe(
      'The status endpoint answered with a body whose own fields disagree: it sends two lamps a ' +
        'reader cannot tell apart by name, "Vector index" and "Vector index". No lamp here is lit ' +
        'from it.',
    );
  });

  it('refuses a body reporting a probe with no lamp at all, as its own fields disagreeing', () => {
    expect(unlit(answered(body({ lamps: [] }))).failure?.detail).toBe(
      'The status endpoint answered with a body whose own fields disagree: it reports a probe at ' +
        '2026-08-09T20:04:05.123Z and names nothing at all that was looked at. No lamp here is lit ' +
        'from it.',
    );
  });
});

describe('the four ways a surface can have nothing to report are four sentences', () => {
  const reasons = (view: Extract<StatusView, { kind: 'unlit' }>): string[] =>
    view.lamps.map((one) => one.detail);

  it('says nobody has looked only before anybody has', () => {
    const view = unlit({ asked: false, failure: null, status: null });

    expect(view.silence).toBe('nobody-looked');
    expect(view.failure).toBe(null);
    expect(reasons(view)).toEqual(Array.from({ length: 3 }, () => 'Nobody has asked the cluster yet.'));
  });

  it('does not say nobody looked once the probe has looked and found nothing answering', () => {
    // THE DEFECT ON BOTH SURFACES. Each carried one pending sentence and went on printing it after a
    // probe had failed, directly above a slip saying the probe did not answer.
    const view = unlit({
      asked: true,
      failure: { error: 'api_unreachable', detail: 'The console could not reach the API.' },
      status: null,
    });

    expect(view.silence).toBe('unanswered');
    expect(reasons(view)[0]).toBe(
      'This page asked and nothing answered, so nothing here has been measured.',
    );
  });

  it('separates the API declining to report from the API not answering at all', () => {
    // A 429 off this demo's own daily ceiling is the API ANSWERING. Telling that visitor their
    // network could not reach the server misattributes the product's own limit to them.
    const view = unlit({
      asked: true,
      failure: { error: 'rate_limited', detail: 'The demo allows 50 turns a day.' },
      status: null,
    });

    expect(view.silence).toBe('refused');
    expect(reasons(view)[0]).toBe(
      'This page asked and the API declined to report, so nothing here has been measured.',
    );
  });

  it('treats a body its own shape guard refused as an answer that could not be read', () => {
    const view = unlit({
      asked: true,
      failure: { error: 'unrecognised_response', detail: 'The status endpoint answered oddly.' },
      status: null,
    });

    expect(view.silence).toBe('unreadable');
    expect(reasons(view)[0]).toBe(
      'This page asked, an answer came back, and it could not be read as one statement.',
    );
  });

  it('says an answer could not be read when a settled request produced neither body nor failure', () => {
    const view = unlit({ asked: true, failure: null, status: null });

    expect(view.silence).toBe('unreadable');
    expect(view.failure?.detail).toBe('The status endpoint settled without an answer this page could read.');
  });
});

describe('the wall clock is taken from the instant rather than sliced out of the string', () => {
  it('reads the time out of an ordinary UTC instant', () => {
    expect(shown(answered(body())).clock).toBe('20:04:05Z');
  });

  it('reads midnight and the end of a day out of the instant rather than off string positions', () => {
    expect(shown(answered(body({ observedAt: '2026-08-09T00:00:00.000Z' }))).clock).toBe('00:00:00Z');
    expect(shown(answered(body({ observedAt: '2026-08-09T23:59:59.999Z' }))).clock).toBe('23:59:59Z');
  });

  // THE TWO TESTS THAT STOOD HERE PINNED AN OFFSET AND A DATE WITH NO TIME AS SHOWN, and both bodies
  // are refused now by the shape rule. They demonstrated `clockOf` reading the instant where a
  // `slice(11, 19)` would read the wrong one. `clockOf` is kept even though the shape rule makes the
  // two equivalent on every body that now reaches it, because it derives from the instant rather
  // than from string positions and so cannot drift if that rule is ever loosened. Its refusals are
  // pinned in the shape test above.
});

describe('a lamp is read once, so its class and its prose cannot disagree', () => {
  it('lights a measured lamp and does not doubt the reason that came with it', () => {
    const [index, embeddings] = shown(answered(body())).lamps;

    expect(index?.stateClass).toBe('state s-ok');
    expect(index?.doubted).toBe(false);
    expect(index?.note).toBe(null);
    expect(index?.detail).toBe('The planner chooses the vector index for the recall query.');
    expect(embeddings?.stateClass).toBe('state s-deg');
    expect(embeddings?.doubted).toBe(false);
  });

  it('leaves an UNKNOWN lamp unlit with its reason typeset as doubt', () => {
    const mcp = shown(answered(body())).lamps[2];

    expect(mcp?.stateClass).toBe('state s-unk');
    expect(mcp?.doubted).toBe(true);
    expect(mcp?.note).toBe(null);
  });

  it('prints an unrecognised state as itself, unlit, and says the board does not know it', () => {
    const only = shown(
      answered(body({ lamps: [lamp('Vector index', 'ok', 'The planner chooses it.')] })),
    ).lamps[0];

    expect(only?.state).toBe('ok');
    expect(only?.stateClass).toBe('state s-unk');
    expect(only?.doubted).toBe(true);
    expect(only?.note).toBe('This board does not know the state "ok", so the lamp is not lit.');
    expect(only?.detail).toBe('The planner chooses it.');
  });

  it('refuses to light a lamp claiming OK with no reason beside it', () => {
    // The first draft of `readLamp` took the class from the state and the doubt from the reason, so
    // this lamp came back green and doubted at once. One derivation is what stops that.
    const only = shown(answered(body({ lamps: [lamp('Embeddings', 'OK', '   ')] }))).lamps[0];

    expect(only?.stateClass).toBe('state s-unk');
    expect(only?.doubted).toBe(true);
    expect(only?.detail).toBe(
      'This lamp arrived with no reason beside it, so there is nothing here to stand on.',
    );
    expect(only?.note).toBe('A lamp with no reason is not a measurement, so it is not lit.');
  });

  it('refuses to light a lamp that names no capability', () => {
    // THE SIBLING OF THE BLANK SERVER RULE, MISSED WHILE THAT ONE WAS WRITTEN. `shapes.ts` checks
    // `name` as a bare string, so a space passes it, `repeatedName` finds no duplicate and the array
    // is not empty. The lamp rendered a lit green OK over an empty heading, naming nothing.
    const only = shown(answered(body({ lamps: [lamp('   ', 'OK', 'The planner chooses it.')] }))).lamps[0];

    expect(only?.stateClass).toBe('state s-unk');
    expect(only?.doubted).toBe(true);
    expect(only?.name).toBe('This lamp arrived with no name');
    expect(only?.note).toBe('A lamp that names no capability cannot report on one, so it is not lit.');
    // THE REASON THAT ARRIVED IS STILL SHOWN. A lamp nobody can name is not a lamp with nothing to say.
    expect(only?.detail).toBe('The planner chooses it.');
  });

  it('reads two lamps whose names differ only by a space as one repeated name', () => {
    // THEY RENDER IDENTICALLY TO A READER, so they are the duplicate defect wearing a space, and
    // string equality does not see it.
    const view = unlit(
      answered(
        body({
          lamps: [
            lamp('Vector index', 'OK', 'The planner chooses the vector index.'),
            lamp('Vector index ', 'DEGRADED', 'No vector index on the embedding column.'),
          ],
        }),
      ),
    );

    // BOTH VALUES AS THEY ARRIVED, trailing space and all. Naming one of them was false here from
    // the start: these two lamps do not have the same name, they have names a reader cannot tell
    // apart, and the sentence now says which is which rather than picking one and claiming it twice.
    expect(view.failure?.detail).toContain(
      'it sends two lamps a reader cannot tell apart by name, "Vector index" and "Vector index "',
    );
  });

  it('refuses two nameless lamps, because they print one heading over different text', () => {
    // THIS TEST ASSERTED THE OPPOSITE AND THE REASON GIVEN FOR IT WAS FALSE. It said each nameless
    // lamp reports itself so the body can still be shown, resting on a claim that two of them render
    // the same doubted content. They do not: each keeps its own state word and its own reason, so
    // two of them shared one preact key while printing different text. Refusing is what this rule
    // does for every other pair of lamps a reader cannot tell apart.
    const view = unlit(
      answered(body({ lamps: [lamp(' ', 'OK', 'One.'), lamp('  ', 'DEGRADED', 'Two.'), ...THREE] })),
    );

    // BOTH NAMES AS THEY ARRIVED, one space and two, so the sentence is true of this body. Two
    // earlier versions of it were false in opposite directions: one quoted the substitute and
    // reported that the endpoint had sent `This lamp arrived with no name` twice, and the next
    // quoted the second lamp's raw name and reported that it had sent two spaces twice. The
    // comparison is over a name this file DERIVES, so no single quoted value can be true.
    //
    // The negative that stood here is deleted rather than reworded. It forbade the substitute, which
    // the positive above already excludes, since the detail carries exactly one such phrase. This
    // file's own docblock says every sentence is pinned whole and never with a negative, and adding
    // one was that rule broken by the commit that quotes it.
    expect(view.failure?.detail).toContain(
      'it sends two lamps a reader cannot tell apart by name, " " and "  "',
    );
  });

  it('refuses a body that pairs a nameless lamp with one named after the substitute', () => {
    // THE COLLISION THE BLANK-NAME FIX BUILT FOR ITSELF. The substitute is a plain sentence, so a
    // body can send it verbatim, and comparing RAW names let the pair through: two headings the
    // same, one preact key, and the second lamp LIT GREEN with a real reason.
    const view = unlit(
      answered(
        body({
          lamps: [
            lamp('   ', 'OK', 'A lamp with no name.'),
            lamp('This lamp arrived with no name', 'OK', 'A lamp named after the substitute.'),
          ],
        }),
      ),
    );

    expect(view.failure?.detail).toContain(
      'it sends two lamps a reader cannot tell apart by name, "   " and "This lamp arrived with no name"',
    );
  });

  it('quotes the name as it arrived rather than the trimmed key it collided on', () => {
    const view = unlit(
      answered(
        body({ lamps: [lamp('  Vector index ', 'OK', 'One.'), lamp('Vector index  ', 'DEGRADED', 'Two.')] }),
      ),
    );

    expect(view.failure?.detail).toContain(
      'it sends two lamps a reader cannot tell apart by name, "  Vector index " and "Vector index  "',
    );
  });

  it('reports the unknown state first when a lamp has neither a state nor a reason', () => {
    const only = shown(answered(body({ lamps: [lamp('Embeddings', 'banana', '')] }))).lamps[0];

    expect(only?.note).toBe('This board does not know the state "banana", so the lamp is not lit.');
    expect(only?.detail).toBe(
      'This lamp arrived with no reason beside it, so there is nothing here to stand on.',
    );
  });

  it('leaves the other lamps alone when one of them is unreadable', () => {
    // REFUSING THE PAGE FOR ONE ODD LAMP WOULD TURN A LEGIBLE PARTIAL ANSWER INTO NO ANSWER, which is
    // the judgement recorded at `LAMP_CHECKS` in `shapes.ts`. This is the assertion that keeps it.
    const view = shown(
      answered(body({ lamps: [lamp('Verification channel', 'sideways', 'A word nobody here knows.'), ...THREE] })),
    );

    expect(view.lamps).toHaveLength(4);
    expect(view.lamps[0]?.stateClass).toBe('state s-unk');
    expect(view.lamps[1]?.stateClass).toBe('state s-ok');
    expect(view.lamps[1]?.doubted).toBe(false);
  });

  it('shows a whole conforming body without refusing any part of it', () => {
    const view = shown(answered(body()));

    expect(view.server).toBe('throughline-api');
    expect(view.observedAt).toBe(AT);
    expect(view.lamps.map((one) => one.name)).toEqual([
      'Vector index',
      'Embeddings',
      'MCP transport',
    ]);
  });
});
