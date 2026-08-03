import type { Coverage, RecallResult, RetrievalPath } from './types.ts';

/**
 * The rule this whole product is built around: an empty result and a failed search are different
 * facts, and every other memory system returns the same thing for both.
 *
 * Nothing in this file talks to a database or a model. It decides a verdict from observed facts
 * about a search that already happened, so it can be tested exhaustively and so the verdict cannot
 * drift depending on who calls it.
 */

export interface CoverageInputs {
  /** The search could not be completed at all: embedding failed, the query errored, no path ran. */
  readonly retrievalFailed: boolean;
  /** Why it failed, in plain language. Required when `retrievalFailed` is true. */
  readonly failureReason: string | null;
  /** Which strategy actually executed. `none` means nothing ran. */
  readonly retrievalPath: RetrievalPath;
  /** The candidate cap was hit, so there may be matches that were never examined. */
  readonly candidateCapReached: boolean;
  /** A time budget ran out mid-search. Same consequence as the cap: real but incomplete. */
  readonly deadlineExceeded: boolean;
  /** How many rows were examined. Zero under COVERED is a genuine empty store. */
  readonly candidatesConsidered: number;
}

export interface CoverageVerdict {
  readonly coverage: Coverage;
  readonly reason: string;
}

/**
 * Decide coverage from what actually happened.
 *
 * The order matters and it is not arbitrary. A failure outranks a cap, because a search that
 * broke halfway through a truncated candidate set is UNKNOWN, not PARTIAL. Downgrading in the
 * other direction would let a broken search present itself as merely incomplete.
 */
export function decideCoverage(inputs: CoverageInputs): CoverageVerdict {
  if (inputs.retrievalFailed || inputs.retrievalPath === 'none') {
    const reason =
      inputs.failureReason ??
      'The search did not run and no reason was recorded, which is itself a defect worth reporting.';
    return { coverage: 'UNKNOWN', reason };
  }

  if (inputs.deadlineExceeded) {
    return {
      coverage: 'PARTIAL',
      reason:
        `The search ran out of time after examining ${inputs.candidatesConsidered} candidates. ` +
        'Matches beyond that point were never looked at.',
    };
  }

  if (inputs.candidateCapReached) {
    return {
      coverage: 'PARTIAL',
      reason:
        `The candidate cap of ${inputs.candidatesConsidered} was reached. ` +
        'There may be relevant memories that were never examined.',
    };
  }

  if (inputs.candidatesConsidered === 0) {
    return {
      coverage: 'COVERED',
      reason: 'The search ran over the whole workspace and it holds no memories yet.',
    };
  }

  // The wording depends on the path, because the two paths make genuinely different promises and an
  // earlier version made the stronger one for both.
  //
  // An exact scan compares every live row, so "examined everything" is true. An approximate nearest
  // neighbour index searches the whole workspace but may miss a close match BY DESIGN: that is what
  // approximate means, and it is the trade the index exists to make. Claiming exhaustiveness there
  // overstates what happened, in the one field a reader relies on to know how much to trust the
  // answer.
  return inputs.retrievalPath === 'ann_index'
    ? {
        coverage: 'COVERED',
        reason:
          `The search covered the whole workspace and examined ${inputs.candidatesConsidered} candidates ` +
          'through the approximate index. Approximate means a close match can be missed by design.',
      }
    : {
        coverage: 'COVERED',
        reason: `The search compared every live row in the workspace, ${inputs.candidatesConsidered} of them.`,
      };
}

/**
 * Thrown when a caller tries to draw a conclusion from a search that did not run.
 *
 * This is a distinct error type rather than a generic one so that an HTTP layer can map it to a
 * specific response and an agent tool can be forced to surface it, instead of catching everything
 * and shrugging.
 */
export class CoverageUnknownError extends Error {
  override readonly name = 'CoverageUnknownError';
  readonly reason: string;

  constructor(reason: string) {
    super(
      `Memory coverage is UNKNOWN, so "nothing found" cannot be concluded. Reason: ${reason}`,
    );
    this.reason = reason;
  }
}

/**
 * The boundary guard. Any code path that wants to say "there are no prior incidents" has to go
 * through this first, and under UNKNOWN it throws.
 *
 * This lives in code rather than in a prompt on purpose. A prompt is a request. A boundary is a
 * guarantee, and the failure this prevents is precisely an agent confidently reporting absence it
 * never established.
 */
export function assertAnswerable(result: RecallResult): void {
  // An ALLOWLIST, not a check for the literal 'UNKNOWN'. The types say coverage is one of three
  // strings; the runtime says it arrives from a database column or a JSON body where nothing
  // enforces that. A denylist here fails OPEN on 'unknown', on undefined, and on any value a
  // future migration adds, which is the precise failure this guard exists to prevent.
  const coverage = result.receipt.coverage;
  if (coverage !== 'COVERED' && coverage !== 'PARTIAL') {
    throw new CoverageUnknownError(
      result.receipt.coverageReason ||
        `Coverage was reported as ${JSON.stringify(coverage)}, which is not a value this system recognises.`,
    );
  }
}

/**
 * The sentence an agent has to lead with. Generated from the receipt, never written by the model,
 * so it cannot be softened, dropped, or rephrased into something reassuring.
 */
export function describeCoverage(result: RecallResult): string {
  const { receipt, memories } = result;
  const count = memories.length;

  switch (receipt.coverage) {
    case 'UNKNOWN':
      return (
        `I could not search memory, so I do not know whether anything relevant exists. ${receipt.coverageReason} ` +
        'Treat this as an unanswered question, not as an absence of prior incidents.'
      );
    case 'PARTIAL':
      return (
        `I found ${count} relevant ${count === 1 ? 'memory' : 'memories'}, but the search was incomplete. ` +
        `${receipt.coverageReason}`
      );
    case 'COVERED':
      return count === 0
        ? `I searched the whole workspace and found nothing relevant. ${receipt.coverageReason}`
        : `I found ${count} relevant ${count === 1 ? 'memory' : 'memories'} and the search was complete.`;
    default:
      // Unreachable through the type system and reachable in practice, for the same reason the
      // guard above is an allowlist. Without this arm the function returns undefined while its
      // signature promises a string, and an unrecognised coverage value reads as no statement at
      // all, which is the softest possible way to say something went wrong.
      return (
        `I cannot state what memory coverage was: it came back as ${JSON.stringify(receipt.coverage)}, ` +
        'which this system does not recognise. Treat this as an unanswered question.'
      );
  }
}
