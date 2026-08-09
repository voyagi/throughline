/**
 * What the demo seed should do about the workspace it found, and what it should say about it.
 *
 * A PURE MODULE, for the reason `archive-state.ts` and `originPolicyWarning` are: the decision lived
 * inside a CLI's `main()`, which opens a database connection, so nothing could test it without one.
 * A review proved the cost exactly. It restored the previous version's defect verbatim and the suite
 * stayed byte-identical at 993 passed, while the commit that fixed it cited that number directly
 * underneath. A fix nothing can go red for is not a fixed thing, it is an unwatched one.
 *
 * THE SECOND HALF, ADDED AFTER THE NEXT REVIEW FOUND THE FIRST HALF INCOMPLETE. Extracting `which
 * branch` while leaving `what the branch does` in `main()` moved the untestable part rather than
 * removing it: deleting `process.exitCode = 1` from two separate refusals, and disabling the guard
 * on an unreadable listing, each left the whole suite at 1004 passed. A run that refuses to seed and
 * exits 0 tells a script it succeeded. So the message and the exit code are decided here too, and
 * `main()` prints what it is handed.
 *
 * The order of the branches in `decideSeed` is the correctness of this module and every line of it
 * is pinned by a case that fails when it moves.
 */

import type { Coverage } from './types.ts';

/** What one listing of the workspace said. Every field here is read by a branch or a message. */
export interface SeedSurvey {
  /** Rows on the page the listing returned, which is NOT necessarily the whole archive. */
  readonly rows: number;
  /** How many of those carry a `supersededBy`. One chain is what a finished seed leaves behind. */
  readonly superseded: number;
  /** The listing receipt's own verdict, as the closed union rather than a string. */
  readonly coverage: Coverage;
  /** Why the receipt says what it says. Quoted back when the listing could not be read. */
  readonly coverageReason: string;
  /** The bound the API applied. Quoted back when the page is clamped. */
  readonly limit: number;
}

export type SeedDecision =
  /** Write the incident. `appending` is true when rows are already there and `--force` was passed. */
  | { readonly kind: 'write'; readonly appending: boolean }
  /** The listing itself failed, so nothing is known about this workspace. Refuse. */
  | { readonly kind: 'unreadable' }
  /** The page is bounded, so no count taken from it settles anything. Refuse, and say why. */
  | { readonly kind: 'bounded' }
  /** A finished seed is already here. Nothing to do, and that is a success. */
  | { readonly kind: 'finished' }
  /** Rows are here but they are not a finished seed. Describe it, do not diagnose it. */
  | { readonly kind: 'unclear' };

/**
 * Decide, most specific first.
 *
 * `unreadable` IS TESTED BEFORE EVERYTHING, INCLUDING `force`. This is the branch a review caught
 * being answered by the wrong line: `rows === 0` used to come first, and `repository.ts`'s
 * `emptyUnknownPage` returns an empty row list WITH an UNKNOWN receipt, so "there is nothing here"
 * and "I could not read this" arrived as the same survey and the empty branch answered both. The
 * function was correct only because a guard in a different file happened to stop UNKNOWN before it
 * arrived, which is not a property this function had. It has it now. `force` does not override it
 * either: the flag means "append on top of whatever is there", and nobody knows what is there.
 *
 * `force` WINS OVER THE REST, including `bounded`. A caller who passed it has said they want another
 * incident on top of what they can see, and this function is not the place to argue.
 *
 * `bounded` IS TESTED BEFORE `finished`, and that order carries the rest of the correctness. A page
 * the API clamped carries exactly `limit` rows whatever the archive holds, so the row-count half of
 * `finished` is satisfied by any bounded page at all and the test collapses to "is there one
 * superseded row among the newest fifty". Tested second, `bounded` is unreachable for exactly those
 * bounded pages that carry at least one superseded row, which is the qualifier an earlier version of
 * this sentence dropped: with no superseded row `finished` fails on its own second half and the
 * bounded branch is still reached. Both halves of that pair have a case below.
 */
export function decideSeed(survey: SeedSurvey, expectedRows: number, force: boolean): SeedDecision {
  if (survey.coverage === 'UNKNOWN') return { kind: 'unreadable' };
  if (force) return { kind: 'write', appending: survey.rows > 0 };
  if (survey.coverage !== 'COVERED') return { kind: 'bounded' };
  if (survey.rows === 0) return { kind: 'write', appending: false };
  if (survey.rows >= expectedRows && survey.superseded > 0) return { kind: 'finished' };
  return { kind: 'unclear' };
}

/** Where the seed is pointed, which the messages have to name. */
export interface SeedTarget {
  readonly workspace: string;
  readonly expectedRows: number;
}

/**
 * What the run should print and what it should exit with.
 *
 * `message` is null only where there is genuinely nothing to announce, which is the plain write into
 * an empty workspace: the per-row lines that follow are the output for that case.
 */
export interface SeedReport {
  readonly message: string | null;
  readonly exitCode: 0 | 1;
  /**
   * Which stream the message belongs on.
   *
   * IT IS CARRIED RATHER THAN DERIVED, so a case can pin it. Before the decision moved here the
   * unreadable listing was a `throw`, which `main().catch` printed to stderr with a `[seed] FAILED:`
   * prefix, and the other refusals printed to stdout. Moving all four to one `console.log` changed
   * that stream silently, in a commit whose message enumerated its behaviour changes and did not
   * mention this one. The rule now is one sentence: a run that failed says so on stderr.
   */
  readonly stream: 'stdout' | 'stderr';
  /** Whether the caller should go on to write rows. */
  readonly writes: boolean;
}

/**
 * Turn the decision into the run's output.
 *
 * THE EXIT CODES ARE THE POINT OF THIS FUNCTION. Three of the five outcomes write nothing, and two
 * of those three are failures: a caller that scripted this deserves to know it did not get a seeded
 * workspace. `finished` is the one refusal that is a success, because the workspace already holds
 * exactly what the run was going to put there. Deleting any one of these exit codes fails a case
 * below by name.
 *
 * The messages DESCRIBE rather than diagnose. A workspace holding four rows might be an interrupted
 * seed or might be rows the agent wrote itself, and nothing available here distinguishes them.
 */
export function describeSeedDecision(
  decision: SeedDecision,
  survey: SeedSurvey,
  target: SeedTarget,
): SeedReport {
  switch (decision.kind) {
    case 'unreadable':
      return {
        message:
          `[seed] Could not read "${target.workspace}" before writing to it, so this run cannot ` +
          `tell an empty archive from an unreadable one: ${survey.coverageReason}. Nothing was ` +
          `written.`,
        exitCode: 1,
        stream: 'stderr',
        writes: false,
      };

    case 'bounded':
      return {
        message:
          `[seed] This page is ${survey.coverage} at a bound of ${survey.limit}, so it is not the ` +
          `whole archive and nothing here can tell a finished seed from a broken one: the listing ` +
          `is newest first, so a superseded row can sit past the bound. Nothing was written. Look ` +
          `at "${target.workspace}" directly, or pass --force to append an incident.`,
        exitCode: 1,
        stream: 'stderr',
        writes: false,
      };

    case 'finished':
      return {
        message:
          `[seed] ${survey.rows} row(s) already here with ${survey.superseded} superseded, so ` +
          `nothing was written. Pass --force to APPEND a second incident.`,
        exitCode: 0,
        stream: 'stdout',
        writes: false,
      };

    case 'unclear':
      return {
        message:
          `[seed] This workspace holds ${survey.rows} row(s), ${survey.superseded} of them ` +
          `superseded. A finished seed is ${target.expectedRows} rows with at least one chain, so ` +
          `this is neither empty nor that. It may be an interrupted seed, or rows written by the ` +
          `agent itself, and nothing here can tell those apart. Nothing was written. Look at ` +
          `"${target.workspace}" and decide: clear it and seed again, or pass --force to append an ` +
          `incident to it.`,
        exitCode: 1,
        stream: 'stderr',
        writes: false,
      };

    case 'write':
      return {
        message: decision.appending
          ? `[seed] --force: appending a second incident on top of the ${survey.rows} row(s) ` +
            `already here. Nothing is deleted, this file has no delete path.`
          : null,
        exitCode: 0,
        stream: 'stdout',
        writes: true,
      };
  }
}
