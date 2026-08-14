/**
 * The one sentence both Bedrock adapters write when the provider refuses the call.
 *
 * WHY THIS IS A MODULE AND NOT TWO CLASSES. It was two classes, and they were the same code in two
 * files, and they had already diverged before anybody looked: the chat adapter printed a request id
 * of `\empty` when the wire sent an empty one, and the embedder printed nothing at all and told the
 * operator there was no request id, because one guard read `=== undefined` and its twin read as
 * truthiness. Those are different findings with different causes and the operator could not tell
 * them apart. That is the same shape as the escaping, which converged into `printable-name.ts` for
 * the same reason one round earlier: this pair has now produced three separate defects that all
 * reduce to one decision living in two places. A comment saying "keep in sync" would not have
 * caught any of them, and did not.
 *
 * WHAT IS SHARED IS EVERYTHING EXCEPT THE WORD. Both messages name the model, the provider's error
 * IDENTITY, its status and its request id, and both deliberately withhold the provider's PROSE. The
 * only difference is whether the caller says "chat" or "embedding", so that is the only thing the
 * subclasses pass.
 *
 * THE PROSE IS WITHHELD ON PURPOSE, AND THAT IS NOT TIDINESS. A Bedrock AccessDeniedException
 * message carries the caller ARN, so the account id and the role name. A review proved this exact
 * leak by rejecting a recall and reading a role ARN back out of a 200, because a tool result is a
 * response body. These classes are the only place that knows the error came from AWS, so they are
 * the only place that can stop it. The full error stays reachable on `cause` for a log that is
 * allowed to see it.
 */

import { printableName } from './printable-name.ts';

/**
 * What `describeProviderError` returns, named once.
 *
 * Present-and-undefined rather than optional, because `exactOptionalPropertyTypes` is on and the
 * producer returns keys that always exist and may hold undefined. An optional property would not
 * accept an explicit undefined, and the two adapters had two copies of this comment saying so.
 */
export type ProviderErrorMetadata = {
  httpStatusCode: number | undefined;
  requestId: string | undefined;
};

export class ProviderRejectionError extends Error {
  readonly modelId: string;
  readonly providerErrorName: string;
  readonly httpStatusCode: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    subject: string,
    modelId: string,
    providerErrorName: string,
    metadata: ProviderErrorMetadata,
    cause: unknown,
  ) {
    // PRESENCE, NOT TRUTHINESS. `describeProviderError` keeps any number and any string it is
    // given, so a `0` status and an `''` request id both survive it and reach these two lines. A
    // status of 0 is what a connection that never completed reports and an empty request id is a
    // header present and blank, so both are real failures with their own causes, and dropping them
    // tells the operator the provider said nothing when it said something empty.
    const status = metadata.httpStatusCode === undefined ? '' : ` (HTTP ${metadata.httpStatusCode})`;
    // BOTH OF THESE ARE STRINGS THE FAR SIDE CHOSE. Withholding the provider's prose while pasting
    // its chosen NAME in raw is one rule kept and its twin dropped, and the name is the better
    // carrier of the two: it lands mid-sentence in the operator's own line, so a newline or a bidi
    // override inside it forges a continuation that reads as this adapter speaking.
    const request =
      metadata.requestId === undefined ? '' : `, request ${printableName(metadata.requestId)}`;
    super(
      `The ${subject} provider rejected the call for model "${modelId}": ` +
        `${printableName(providerErrorName)}${status}${request}. The provider's own message is on ` +
        `the cause and is deliberately not repeated here, because this text reaches the on-call ` +
        'operator.',
      { cause },
    );
    this.name = 'ProviderRejectionError';
    this.modelId = modelId;
    this.providerErrorName = providerErrorName;
    this.httpStatusCode = metadata.httpStatusCode;
    this.requestId = metadata.requestId;
  }
}
