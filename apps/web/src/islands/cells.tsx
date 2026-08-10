import { readText } from '../scripts/contradiction.ts';
import { KIND_LABEL, labelled } from '../scripts/presentation.ts';
import type { MemoryKind } from '../scripts/types.ts';

/**
 * The cells both boards print about a memory, in one place.
 *
 * EXTRACTED BECAUSE `gate:dup` REFUSED THE SECOND COPY, and the gate was right rather than annoying.
 * The console's recall strip and the archive's row strip both state a memory's kind, its age and the
 * half-life for that kind, in that order, in the same three cells. That is one presentation decision
 * appearing twice, and this repository's rule is that such a decision lives in one module both
 * import: the two copies had already drifted once in spirit, since only one of them guarded the
 * `KIND_LABEL` lookup.
 *
 * What each board adds AFTER these three differs, and that difference is the point of the two
 * boards: the console adds `Score`, because a recall ranked the row. The archive adds `Freshness`,
 * because nothing ranked it and freshness is the only decay number that is honest without a query.
 */

interface Props {
  readonly kind: MemoryKind;
  readonly ageDays: number;
  readonly halfLifeDays: number;
}

export function KindAgeCells({ kind, ageDays, halfLifeDays }: Props) {
  return (
    <>
      <div class="cell">
        <b>Kind</b>
        {/* Guarded, because a kind the server adds later must print SOMETHING. An unlabelled cell on
            these boards reads as a missing fact rather than as a console that is out of date.

            THE GUARD DID THE OPPOSITE FOR ONE VALUE, and this module is the worst place in the
            repository for that, because BOTH boards import it. `ROW_CHECKS.kind` and
            `RECALLED_MEMORY_CHECKS.kind` are `isString`, so a kind of pure whitespace is non-null,
            the label lookup misses it, and the raw value prints nothing. One blank field emptied a
            cell on the archive rack and on the console rack at the same time. */}
        <span class="val">{labelled(KIND_LABEL, kind) ?? readText(kind, 'a kind this row did not name')}</span>
      </div>
      <div class="cell">
        <b>Age</b>
        <span class="val">{ageDays} d</span>
      </div>
      <div class="cell">
        <b>Half-life</b>
        <span class="val">{halfLifeDays} d</span>
      </div>
    </>
  );
}
