import { UNREACHABLE, UNRECOGNISED } from './api.ts';
import {
  instantFault,
  internal,
  isBlank,
  malformed,
  type ContradictionKind,
  type InstantFault,
  type Of,
} from './contradiction.ts';
import { labelled } from './presentation.ts';
import type { FailureResponse, LampState, LampView, StatusResponse } from './types.ts';

/**
 * What the two status surfaces can honestly print from one `GET /status`.
 *
 * THE THIRD SIBLING, AND THE FIRST WRITTEN BEFORE A REVIEW ASKED FOR IT. `archive-state.ts` exists
 * because the archive believed a receipt that argued with the rows beside it. `recall-state.ts`
 * exists because that fix stopped at the archive and the console had the same hole. `/status` was the
 * last surface, and nothing checked its body at all.
 *
 * TWO ISLANDS READ THIS BODY, NOT ONE, which is why every printed thing is derived here and read off
 * the result by both. `StatusBoard.tsx` is `/status` itself. `Annunciator.tsx` is the same three
 * lamps as a rail, mounted by `Board.astro` on every page that does not turn it off, so it is on four
 * of the five pages and a wrong lamp there is wrong nearly everywhere. Two surfaces deriving one
 * field twice is the arrangement that produced every defect on this branch, and this page already had
 * it: the lamp took its colour from one comparison and the reason took its emphasis from another, so
 * a state neither recognised came out unlit above a reason typeset as a measurement.
 *
 * A PURE MODULE, for the reason the other two are: a decision that cannot be tested without mounting
 * something does not get tested, and neither island had a test file when this was written.
 */

/**
 * One lamp, reduced to the SIX things a surface prints, so no surface derives any of them twice.
 *
 * Six, counted rather than eyeballed, and this said five. The board prints all six, and the rail
 * reads five of them and never `doubted`, because its reason is screen reader text with no emphasis
 * to take. A wrong count in a file whose argument is that the printed things were counted is that
 * argument failing on itself, which the archive's own docblock was corrected for one commit ago.
 *
 * `given` IS A SEVENTH FIELD AND IS NOT ONE OF THE SIX, because no surface prints it. It is here for
 * the duplicate rule alone, which compares the names a reader SEES and has to quote the name that
 * actually arrived. Counting it among the printed things is the mistake this docblock already made
 * once in the other direction.
 */
export interface LampReading {
  readonly name: string;
  /**
   * The name AS IT ARRIVED, before any substitution, which no surface prints.
   *
   * The slip quotes the value it is refusing, everywhere on this page. When two lamps arrive with no
   * name at all they collide on the substitute, and quoting the substitute made the page report that
   * the endpoint had given two lamps the name `This lamp arrived with no name`. The endpoint gave
   * them nothing, `readLamp` gave them that, and the opening on an `internal` contradiction attributes
   * what follows to the body. So the comparison is over the printed name and the quote is over this
   * one, which also shows the whitespace when whitespace is what collided.
   */
  readonly given: string;
  /** The state word AS IT ARRIVED, never a word chosen here. An odd word printed is odd and true. */
  readonly state: string;
  /** The reason as it arrived, or this board's own sentence when none did. */
  readonly detail: string;
  /** This board's remark about the lamp, in this board's voice, or null when it has none. */
  readonly note: string | null;
  readonly stateClass: string;
  /** True when the reason is not a measurement, so a surface can typeset it as doubt. */
  readonly doubted: boolean;
}

/**
 * WHY a surface has nothing to report, and these are four different facts about four different events.
 *
 * COLLAPSING THEM IS THE PRODUCT'S HEADLINE FAILURE COMMITTED BY THE PRODUCT'S OWN CHROME, and both
 * surfaces were committing it. Each carried ONE pending sentence, `Nobody has asked the cluster yet`,
 * and went on printing it after a probe had been made and had failed: on `/status` directly above a
 * slip reading THE PROBE DID NOT ANSWER, and on the rail in the screen reader text one lamp away from
 * `The console tried to reach the API and could not`. A page saying nobody looked, beside its own
 * sentence saying it looked, is the confusion this whole product argues against.
 *
 * The three that follow an attempt are told apart by the failure's own code, because they are told
 * apart by what happened: nothing answered, the API answered and declined, or something answered in a
 * shape no result can be read out of. `api.ts` mints `UNRECOGNISED` for a body its guard refuses and
 * this file mints it for a body whose fields argue with each other, and those are the same fact to a
 * reader: an answer arrived and it cannot be believed.
 */
export type Silence = 'nobody-looked' | 'unanswered' | 'refused' | 'unreadable';

/** What a surface may print for the whole body: a reading, or lamps that are unlit and say why. */
export type StatusView =
  | {
      readonly kind: 'shown';
      readonly server: string;
      /** The probe's own instant, as it arrived, for the surface that prints it whole. */
      readonly observedAt: string;
      /** The same instant as a wall clock, formatted HERE so no surface slices a string into one. */
      readonly clock: string;
      readonly lamps: readonly LampReading[];
    }
  | {
      readonly kind: 'unlit';
      readonly silence: Silence;
      readonly lamps: readonly LampReading[];
      /** What went wrong, for the surface that draws a slip. Null before anybody has looked. */
      readonly failure: FailureResponse | null;
    };

export interface StatusInput {
  /** True once an attempt has completed, whatever it completed with. */
  readonly asked: boolean;
  readonly failure: FailureResponse | null;
  readonly status: StatusResponse | null;
}

/**
 * The two kinds a status body can carry, and the absent third is the point.
 *
 * `rack` means a receipt's own count disagreeing with the rows that arrived beside it. A
 * `StatusResponse` is flat: it has no receipt and no rack, so every rule below reads one field on its
 * own or two fields of the same object. A `rack` sentence here would be a branch nothing can reach,
 * which this repository treats as worse than no branch, because it reads as coverage and provides
 * none. `Exclude` rather than a hand written pair, so a fourth kind added to the shared vocabulary
 * still fails the build here until somebody decides whether a status body can carry it.
 */
type StatusContradictionKind = Exclude<ContradictionKind, 'rack'>;

/**
 * A contradiction a status body can actually carry. See `StatusContradictionKind`.
 *
 * `Of` FROM THE SHARED MODULE rather than the same intersection written again here. That helper
 * exists for exactly this, and writing it out by hand left its docblock naming this file as its first
 * user while nothing here imported it.
 */
type StatusContradiction = Of<StatusContradictionKind>;

/**
 * The three words the contract declares for a lamp, as something a running program can test against.
 *
 * `Record<LampState, string>` enforces both directions, the way `COVERAGE_WORDS` does in `shapes.ts`:
 * a fourth state added to the contract fails to compile until it is given a class, and a word that is
 * not a `LampState` cannot be listed. An unrecognised word takes the UNKNOWN class, which is the same
 * direction `shapes.ts` chose when it deliberately validated `state` as a bare string.
 */
const LAMP_CLASS: Readonly<Record<LampState, string>> = {
  OK: 'state s-ok',
  DEGRADED: 'state s-deg',
  UNKNOWN: 'state s-unk',
};

/**
 * How each kind of refusal opens, so no sentence describes a comparison that did not happen.
 *
 * ONE TABLE RATHER THAN A TERNARY, for the reason both siblings carry one: a two armed ternary over
 * three cases is how the third case silently borrowed the second's sentence, twice.
 */
const OPENING: Readonly<Record<StatusContradictionKind, string>> = {
  malformed: 'The status endpoint answered with a body carrying a value that is not a measurement: ',
  internal: 'The status endpoint answered with a body whose own fields disagree: ',
};

/** What the lamps say while they are unlit, one sentence per event rather than one for all four. */
const REASON: Readonly<Record<Silence, string>> = {
  'nobody-looked': 'Nobody has asked the cluster yet.',
  unanswered: 'This page asked and nothing answered, so nothing here has been measured.',
  refused: 'This page asked and the API declined to report, so nothing here has been measured.',
  unreadable: 'This page asked, an answer came back, and it could not be read as one statement.',
};

/** The lamps both surfaces name before any believable answer has arrived. ONE COPY, and there were two. */
const PENDING_NAMES: readonly string[] = ['Vector index', 'Embeddings', 'MCP transport'];

/** Two digits, so a wall clock reads as one rather than as a number that happens to be small. */
const twoDigits = (value: number): string => String(value).padStart(2, '0');

/**
 * A wall clock in UTC, from an instant.
 *
 * A `Date` RATHER THAN A STRING, deliberately, so the one place a string becomes an instant is
 * `describeStatus`, which refuses the strings that are not one. The rail used to build this itself
 * with `observedAt.slice(11, 19) + 'Z'`, which reads the wrong instant off a timestamp carrying an
 * offset and produces a bare `Z` off a date with no time in it, both stamped UTC and both printed in
 * the class that means a real answer arrived. Its two call sites hold an instant that has already
 * parsed: the reading below, and the rail's own record of when it tried.
 */
export const clockOf = (at: Date): string =>
  `${twoDigits(at.getUTCHours())}:${twoDigits(at.getUTCMinutes())}:${twoDigits(at.getUTCSeconds())}Z`;

/**
 * Read a status body, or say why there is nothing to read.
 *
 * THE RULES ARE BUILT FROM WHAT THE TWO SURFACES PRINT, AND THE FIELDS WERE COUNTED RATHER THAN
 * RECALLED. Measured with a match-only grep over both islands as they stood at `b43dc12`, before
 * this module existed and while each still read the body directly: `StatusBoard.tsx` read `lamps`,
 * `lamp.name`, `lamp.state`, `lamp.detail`, `observedAt` and `server`, and `Annunciator.tsx` read all
 * of those except `server`. That is every field of `StatusResponse` and every field of `LampView`, so
 * no printed field is without a rule or a recorded reason for not having one. The census is dated to
 * that commit deliberately: it is what the rules below were derived FROM. Both surfaces now read this
 * module instead, and the same grep re-run against them confirms the set is unchanged, with the board
 * taking `observedAt` and `server` and the rail taking the formatted `clock` in place of `observedAt`
 * alone, because the rail never read `server` in the first place.
 *
 *   0. `observedAt` is not the timestamp shape this contract declares, which replaced a looser rule
 *      that three separate forms walked straight past.
 *   1. `observedAt` has the right shape and still names no instant. A month above 12 and an hour
 *      above 24 reach here and `Date.parse` returns nothing for them.
 *   2. `observedAt` names an instant that does not exist as written. `Date.parse` SILENTLY ROLLS
 *      FORWARD both a day that overflows its own month and an hour of 24, so the board printed the
 *      thirtieth of February, and printed `2026-12-31T24:00:00.000Z` for an instant in 2027, in the
 *      class that means a measurement. The hour is the sibling the first version of this rule missed
 *      because it only ever read the date.
 *
 *      Rules 0 to 2 are the three faults `instantFault` in `contradiction.ts` returns, in its order
 *      rather than in one this file chooses, and `INSTANT_FAULT_PHRASE` below turns each into the
 *      end of the sentence printed here. They moved there when the archive needed the same three
 *      questions about the instants it prints per row.
 *   3. `server` names nobody. The board prints it under ANSWERING, which is the cell a reader checks
 *      when they suspect something other than this API is replying.
 *   4. Two lamps print the same name, compared over the names the surfaces PRINT and with the ends
 *      trimmed. A repeat is two capabilities the reader cannot tell apart. It is ALSO two nodes
 *      under one preact key in two of the three cases, counted rather than waved at, and the
 *      sentence that stood here named only one of the two. Both surfaces key their lamp list on the
 *      PRINTED name, `key={lamp.name}` in `StatusBoard.tsx` and in `Annunciator.tsx`, which
 *      `readLamp` passes through untrimmed
 *      unless it is blank. So two byte identical names share a key. Two BLANK names share one too,
 *      because `readLamp` maps every blank name to the single substitute. Two names differing only
 *      by whitespace do NOT, since `Vector index ` keeps a key of its own while the browser
 *      collapses the space and the reader sees one heading twice. The reader is the reason this rule
 *      exists. The key is a consequence it sometimes also has.
 *   5. A probe instant with no lamps at all. The board's legend says each lamp is lit by a probe that
 *      asks the running database, and the rail would render a lone lit timestamp with nothing beside
 *      it, which is a rail reporting the clock as a success.
 *
 * WHAT IS DELIBERATELY NOT A RULE, with the reason, because an enumeration that hides its exclusions
 * is a sample wearing an enumeration's clothes:
 *
 *   - An unrecognised `state`, a lamp with a blank `detail`, and a lamp with a blank NAME. All three
 *     are handled per lamp by `readLamp` rather than by refusing the body, for the reason recorded at
 *     `LAMP_CHECKS` in `shapes.ts`: refusing a whole status page because one lamp came back wrong
 *     turns a legible partial answer into no answer. The blank name was the sibling of rule 3 and was
 *     missed while rule 3 was being written, which a review caught.
 *
 *   - `observedAt` later than the moment the browser received the answer. The browser's clock and the
 *     server's are different clocks and skew between them is ordinary, so this would refuse genuine
 *     answers on a machine whose time is merely wrong. Over-refusing is the failure a test caught on
 *     the console last time, and it would cost more here, because the rail is on four pages.
 *   - The lamp names themselves. `toLamps` writes three fixed names, but a surface that refused an
 *     unfamiliar name could never show a capability added later, and the name is printed rather than
 *     branched on.
 *   - The board also prints `view.failure.detail`, which is not a field of either type counted
 *     above. It never comes from the 200 this module reads. It is the API's own sentence when a non
 *     2xx carried a failure shape, and `api.ts` or this file writes it otherwise. Its blankness is
 *     guarded in `asFailure` so all three surfaces that draw a slip are covered by one rule rather
 *     than by three.
 *
 * A PARAGRAPH THAT STOOD ABOVE THIS LIST IS DELETED RATHER THAN REWRITTEN. It argued that the FORMAT
 * of `observedAt` should not be a rule, because an offset and a date with no time both name real
 * instants in another notation. True, and it is what let an expanded-year timestamp and a textual
 * date past the calendar check, since neither begins with four digits. Rule 0 now closes the
 * category, and the argument that kept it open is gone rather than narrowed. It sat between the
 * first exclusion and the rest, so two exclusions read as part of the deletion note.
 *
 * NONE OF THESE IS REACHABLE FROM THIS PROJECT'S OWN API, and each was read rather than assumed.
 * `server.ts` builds the body from `SERVER_NAME`, a non-empty module constant, from
 * `capabilities.observedAt.toISOString()`, which is a `Date` and cannot yield a string no engine can
 * parse, and from `toLamps`, which returns exactly three lamps under three distinct fixed names with
 * a typed state and a non-empty reason on every arm. A grep for `observedAt` across the repository
 * finds one producer. So this guard cannot fire on a conforming answer: anything reaching it came
 * from something that is not this API, which is the standing both siblings have and the reason they
 * exist. `api.ts` returns `ok: true` for any 200 whose body parses, and `shapes.ts` checks one field
 * at a time by design, so a body whose fields are each valid and jointly impossible reaches a page.
 */
export function describeStatus(input: StatusInput): StatusView {
  if (!input.asked) return unlit('nobody-looked', null);

  if (input.failure !== null) {
    // WHICH FAILURE, FROM ITS OWN CODE. `UNREACHABLE` is the only one that means nothing answered.
    // Everything else is the API answering, and saying otherwise tells a rate limited visitor their
    // network is broken, which is the misattribution `describeListing` was corrected for.
    if (input.failure.error === UNREACHABLE) return unlit('unanswered', input.failure);
    if (input.failure.error === UNRECOGNISED) return unlit('unreadable', input.failure);
    return unlit('refused', input.failure);
  }

  // A settled request with neither a failure nor a body is a shape nobody expected, and the honest
  // thing to say about it is the same thing said about a body that cannot be read.
  if (input.status === null) {
    return unlit('unreadable', {
      error: UNRECOGNISED,
      detail: 'The status endpoint settled without an answer this page could read.',
    });
  }

  // THE LAMPS ARE READ BEFORE THE BODY IS JUDGED, so the duplicate rule can compare the names the
  // surfaces will actually PRINT rather than the raw ones. A lamp that arrived with no name is given
  // one here, and that substitute has to be inside the comparison or it becomes a collision this
  // module invented. Reading a lamp has no side effect and cannot throw, so the order costs nothing.
  const lamps = input.status.lamps.map(readLamp);

  const contradiction = statusContradiction(input.status, lamps);
  if (contradiction !== null) {
    return unlit('unreadable', {
      error: UNRECOGNISED,
      detail: `${OPENING[contradiction.kind]}${contradiction.phrase}. No lamp here is lit from it.`,
    });
  }

  return {
    kind: 'shown',
    server: input.status.server,
    observedAt: input.status.observedAt,
    clock: clockOf(new Date(input.status.observedAt)),
    lamps,
  };
}

/** The unlit view, with every lamp saying the one true thing about why it is unlit. */
function unlit(silence: Silence, failure: FailureResponse | null): StatusView {
  return {
    kind: 'unlit',
    silence,
    failure,
    lamps: PENDING_NAMES.map((name) => ({
      name,
      // These lamps did not ARRIVE, this file writes them, so the name it prints is the only name
      // there is. `given` exists for the duplicate rule, which never runs on this path.
      given: name,
      state: 'UNKNOWN',
      detail: REASON[silence],
      note: null,
      stateClass: LAMP_CLASS.UNKNOWN,
      doubted: true,
    })),
  };
}

/**
 * Read one lamp.
 *
 * NOT A REFUSAL, AND THAT IS A DECISION WITH A REASON WRITTEN DOWN. `shapes.ts` validates a lamp's
 * `state` as a bare string on purpose and says why at `LAMP_CHECKS`. So an unrecognised word is
 * printed as itself, unlit, with this board's remark beside it, and the other lamps are untouched.
 *
 * THE ORDER IS NAME, THEN STATE, THEN REASON, and each step is a wider claim than the one before.
 * A lamp nobody can name cannot be reporting on a capability at all, so nothing else about it is
 * worth reading. A lamp whose state this board cannot place is not one whose reason it can vouch
 * for. Only then is a missing reason the thing that matters.
 */
function readLamp(lamp: LampView): LampReading {
  const known = labelled(LAMP_CLASS, lamp.state);
  const blank = isBlank(lamp.detail);
  const detail = blank
    ? 'This lamp arrived with no reason beside it, so there is nothing here to stand on.'
    : lamp.detail;

  // THE SIBLING OF THE BLANK SERVER RULE, AND IT WAS MISSED WHILE THAT ONE WAS WRITTEN. `shapes.ts`
  // checks `name` as a bare string, so whitespace passes it, no duplicate is found and the array is
  // not empty: a lamp named with a space rendered a LIT GREEN state over an empty heading, naming no
  // capability at all. A lamp nobody can name is not a lamp anybody can read, so it is not lit. (No
  // count of blankable fields is quoted here. The sentence that stood in this place said three, and
  // the census above names five printed strings, of which `observedAt` is caught by rule 0 and a
  // blank `state` falls into the unrecognised arm below. A number nobody can check from this line is
  // the thing this file keeps being wrong about.)
  const nameless = isBlank(lamp.name);
  const name = nameless ? 'This lamp arrived with no name' : lamp.name;

  if (nameless) {
    return {
      name,
      given: lamp.name,
      state: lamp.state,
      detail,
      note: 'A lamp that names no capability cannot report on one, so it is not lit.',
      stateClass: LAMP_CLASS.UNKNOWN,
      doubted: true,
    };
  }

  if (known === undefined) {
    return {
      name,
      given: lamp.name,
      state: lamp.state,
      detail,
      note: `This board does not know the state ${JSON.stringify(lamp.state)}, so the lamp is not lit.`,
      stateClass: LAMP_CLASS.UNKNOWN,
      doubted: true,
    };
  }

  // ONE DERIVATION FEEDING BOTH THE CLASS AND THE PROSE, which is the whole point of this module and
  // which the first draft of this function got wrong inside its own new file: it took the class from
  // the state and the doubt from the reason, so a lamp reading OK with no reason at all came back
  // green and doubted at once. That is the defect this file was written to close, committed in it.
  const doubted = blank || lamp.state === 'UNKNOWN';

  return {
    name,
    given: lamp.name,
    state: lamp.state,
    detail,
    note: blank ? 'A lamp with no reason is not a measurement, so it is not lit.' : null,
    stateClass: doubted ? LAMP_CLASS.UNKNOWN : known,
    doubted,
  };
}

/**
 * The end of the sentence this page prints for each way an instant fails to be one.
 *
 * `Record<InstantFault, string>` rather than three branches, so a fourth fault added to the shared
 * union is a compile error here until this page decides what it says about it. The three phrases are
 * the ones this page has always printed and they are pinned whole in `status-state.test.ts`.
 */
const INSTANT_FAULT_PHRASE: Readonly<Record<InstantFault, string>> = {
  shape: 'which is not a timestamp in the form this contract declares',
  time: 'which is not a time',
  exists: 'which is not an instant that exists as written',
};

/**
 * Which way a status body argues with itself, as a phrase, or null when it does not.
 *
 * The single fields come first, because a comparison against a value that is not a value at all is
 * meaningless rather than false. That ordering is the correction the console's guard needed most.
 */
function statusContradiction(
  status: StatusResponse,
  lamps: readonly LampReading[],
): StatusContradiction | null {
  // A DIRECT INDEX RATHER THAN `labelled`, and the difference is where the key came from. Every
  // other table in this module is indexed by a string off the wire, which is why `labelled` exists.
  // This one is indexed by a value `instantFault` just minted out of a closed union, so there is no
  // absent case to fall back from and a fallback here would be a branch nothing can reach.
  const fault = instantFault(status.observedAt);
  if (fault !== null) {
    return malformed(
      `it reports ${JSON.stringify(status.observedAt)} as when the probe ran, ` +
        INSTANT_FAULT_PHRASE[fault],
    );
  }
  if (isBlank(status.server)) {
    return malformed('it names no server as having answered');
  }
  // `internal` AND NOT `malformed`, and the sentence is the whole argument. `malformed` opens with
  // "carrying a value that is not a measurement", which the shared vocabulary defines as nothing
  // being compared with anything. This rule is the one status rule that DOES compare two values, and
  // both of them are perfectly good names. Minting it malformed printed an opening saying no
  // comparison happened directly in front of a phrase reporting one, which is the same fault as the
  // console chip and both rack openings that the commit before this one was written to fix.
  const repeated = repeatedName(lamps);
  if (repeated !== null) {
    return internal(
      `it sends two lamps a reader cannot tell apart by name, ${JSON.stringify(repeated[0])} and ` +
        JSON.stringify(repeated[1]),
    );
  }
  // `lamps`, not `status.lamps`, because the rule above it reads the derived array and adjacent
  // rules reading two different arrays is how the two stop agreeing. They cannot disagree today,
  // `lamps` is a one to one map of `status.lamps`, which is exactly why picking one costs nothing.
  if (lamps.length === 0) {
    return internal(
      `it reports a probe at ${status.observedAt} and names nothing at all that was looked at`,
    );
  }
  return null;
}

/**
 * A name printed by more than one lamp, or null. A `Set` rather than a scan inside a loop.
 *
 * OVER THE NAMES THE SURFACES ACTUALLY PRINT, not over the raw ones, and the difference was a defect
 * this module manufactured for itself. `readLamp` substitutes a display name for a lamp that arrived
 * with none, and that substitute is a plain sentence a body can send verbatim. Comparing raw names
 * meant a body pairing one whitespace name with one lamp literally named `This lamp arrived with no
 * name` produced two readings printing one heading under one preact key, the second of them LIT
 * GREEN with a real reason. That is precisely what this rule exists to refuse, built by the fix for
 * the blank name.
 *
 * BOTH RAW NAMES COME BACK, AND THE SENTENCE CHANGED RATHER THAN THE VALUE IT QUOTES. This is the
 * third rewrite of that sentence and the first two were both false, in opposite directions, for the
 * same underlying reason: the comparison is over a DERIVED name and the sentence quoted ONE value
 * while claiming something about TWO lamps. Quoting the substitute reported that the endpoint had
 * named two lamps `This lamp arrived with no name` when it had named neither. Quoting the second
 * lamp's raw name reported that it had given both lamps `"  "` when the first had sent `" "`. The
 * pre-existing case was false too: `Vector index` and `Vector index ` are not the same name. No
 * single quoted value can be true here, so the claim is now about what a READER cannot tell apart
 * BY NAME, and both values that arrived are named. That is true for every pair, including one where
 * the two raw names really are identical.
 *
 * `BY NAME` IS LOAD BEARING AND WAS MISSING FOR ONE COMMIT. Without it the sentence claimed a reader
 * cannot tell the two LAMPS apart, and the paragraph below this one says the opposite in the same
 * file: each keeps its own state word and its own reason, so they print different text. What cannot
 * be told apart is which capability each one reports on, which is what rule 4 in this module's own
 * header already said and what the rewrite dropped. (That cited a line number in the same file,
 * which this session's edits moved before anything else did.)
 *
 * TRIMMED, because two lamps named `Vector index` and `Vector index ` print the same heading and are
 * not equal as strings, which is the same defect wearing a space.
 *
 * NO BLANKS TO SKIP ANY MORE, and the special case that used to skip them rested on a claim a review
 * falsified. It said two nameless lamps render the same doubted content, so a shared key drew nothing
 * false. They do not: each keeps its own state word and its own reason, so two of them shared a key
 * while printing different text. Comparing display names refuses that body, which is the answer this
 * rule already gives for every other pair of lamps a reader cannot tell apart.
 */
function repeatedName(lamps: readonly LampReading[]): readonly [string, string] | null {
  const seen = new Map<string, string>();
  for (const lamp of lamps) {
    const key = lamp.name.trim();
    const first = seen.get(key);
    if (first !== undefined) return [first, lamp.given];
    seen.set(key, lamp.given);
  }
  return null;
}
