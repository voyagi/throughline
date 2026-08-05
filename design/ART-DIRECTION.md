# Throughline: art direction

Locked 2026-08-03. Every page derives from this document. If a page disagrees with this file, the
page is wrong.

Nothing in this project outputs an em dash or an en dash. Plain hyphen, or reword.

---

## 0. How this was decided

Two complete directions were developed independently from one brief, rendered as working HTML at
1440x1000, and judged side by side rather than argued about.

- Direction A, "the hydrographic chart room": an Admiralty chart sheet, with the reliability
  apparatus a chart carries on its own face. Buff land as the page field, white water panels,
  chart magenta for every caution, a plotted track down the page, and a source diagram in the
  corner rating how far each number can be trusted.
- Direction B, "the strip board": the anchor described in section 1 below.

**Direction B wins, with three laws grafted in from A.** The reasoning, because a taste call that
does not state its reasons cannot be argued with:

- Both passed the per-page anti-slop test. Neither reads as AI-built at a glance.
- B wins the STRUCTURAL test, which is the one the brief calls decisive. A's landing page is a
  title block followed by three content sections and a call to action. It is dressed beautifully,
  but that is the default flow with better clothes, which is the definition of a reskin. B's page
  is a persistent instrument: board chrome that never leaves the viewport, an annunciator rail, a
  clock rail where scrolling advances time rather than sections, and content that arrives as
  physical records posted into bays. A screenshot at any scroll position shows equipment.
- B's staleness device is better than A's. A prints stale values in italic. B rotates the record
  2.5 degrees out of alignment so it physically will not sit flush. The second one needs no legend.
- B's UNKNOWN is better than A's. A uses a dashed lozenge. B uses an empty holder with a printed
  refusal slip in it: absence given a physical shape, which is the exact product claim.
- B has a live-filmable motion grammar. The demo video is three minutes of records posting,
  cocking, and being refused. A's plotting grammar is quieter and harder to film.

What A had that B did not, and which is therefore grafted in below: a proper reading face with a
true italic, the semantic-slant law, and the law that UNKNOWN is never given a colour.

Rejected without regret: A's engraved 1760 display face, which is gorgeous and belongs to a
printed sheet, not to painted equipment. Carrying it over would have made a pastiche of two
anchors, which reads worse than either.

---

## 1. Anchor

**The paper flight-progress strip board of a pre-digital air traffic control watch, roughly 1965
to 1995.**

Before radar data blocks, every aircraft in a sector was a strip of buff card in a coloured
plastic holder, racked in bays on a painted metal board. The reason this is the right anchor for
Throughline and not for any other developer tool: the strip existed to keep a legal record of the
instructions actually issued, written in real time, under life-critical pressure, by people who
could not afford to trust their own recall. That is the product. Not a mood borrowed from it.

The vocabulary maps one to one and nothing had to be bent to make it fit:

| Strip board practice | Throughline |
|---|---|
| The strip is the legal record of what was said | Every recall returns a receipt |
| A strip is "cocked out" of alignment to flag an issue | Staleness: returned flagged, never dropped |
| Holder colour carries meaning | Five memory kinds, five holder colours |
| Annotations in different coloured pens by role | Provenance: who asserted this, from where |
| An empty holder is information | UNKNOWN is a verdict, not an empty result |
| The strip stays on the board after the aircraft leaves | Supersede and tombstone, never overwrite |

Wendy Mackay's four-month field study of Paris en-route controllers found they refused to give up
paper strips because the physical record was doing safety work no screen replicated ("Is paper
safer? The role of paper flight strips in air traffic control", ACM TOCHI 1999,
DOI 10.1145/331490.331491). Throughline answers the same anxiety thirty years later: an agent you
can only trust if it keeps the strips.

The obvious aviation picks, which this deliberately is not: the black box, the NTSB report, the
evidence room. All three are post-incident artefacts, records of the autopsy. The strip board is
the record made DURING, which is where on-call actually lives at 3am.

---

## 2. Type

Four voices with four jobs. The rule is the identity: **a reader can classify the authority of any
string on any page from its letterforms alone.**

| Voice | Family | Source and licence | Job |
|---|---|---|---|
| SIGNAGE | Big Shoulders | Google Fonts, OFL | Board headers, bay labels, page titles, buttons. Always caps. Names places, makes claims. |
| STAMP | Big Shoulders Stencil | Google Fonts, OFL | Stamped states only: WITHDRAWN, PROTECTED, COCKED, SUPERSEDED. Stencil is how you mark equipment, not how you talk. |
| READING | Petrona | Google Fonts, OFL, variable 100-900 with a true italic | All running prose. The long read on /how-it-works, bay notes, captions. |
| INSTRUMENT | B612 Mono | Google Fonts, OFL 1.1 | Machine truth only: queries, counts, paths, elapsed times, verdicts, identifiers. |
| HAND | Caveat | Google Fonts, OFL | Human annotation only. Capped at 19px. Never a heading, never system output. |

B612 was commissioned by Airbus with ENAC and Universite de Toulouse III and designed for aircraft
cockpit screens. It is not a font that looks aeronautical; it is the aeronautical font, and it is
free. Only the Mono cut is used here, and it is caged.

**The cage, stated exactly, because a vague version of this rule is unenforceable.** B612 Mono is
allowed in exactly three places: inside a record (a strip, a slip, a probe readout), in a verdict
lozenge, and on an identifier quoted from the schema or the codebase. It is banned everywhere else,
including page chrome, nav, bay labels, captions, counts, tab labels and the clock rail. Those are
signage or reading, so they take Big Shoulders or Petrona. This is the single rule that keeps the
site out of the banned code-editor look. The first render of these mockups broke it in five places,
which is why the rule now names its allowed places rather than gesturing at them.

Every family was verified live on 2026-08-03 by requesting the Google Fonts CSS2 API and checking
for @font-face blocks, and confirmed to sit under `ofl/` in the google/fonts repository.

### The semantic slant, grafted from Direction A

**Upright means stand on it. Italic means do not.** Applied without exception: a stale value, a
superseded row, an unverified claim, and the word UNKNOWN are always italic, in any face, at any
size. The cocked strip is the physical form of the same law; the italic is the form it takes when
there is no strip to rotate.

### Scale

Display 72/76 Big Shoulders 700 caps, tracking 0.012em. Bay label 34/38 Big Shoulders 600 caps.
Stamp 19-28 Big Shoulders Stencil 500 caps. Body 17/27 Petrona 400. Caption 14.5/21 Petrona 400
italic. Data 13/19 B612 Mono 400. Verdict 11 B612 Mono 700 caps, tracking 0.13em. Annotation 19
Caveat 500.

---

## 3. Palette

Dominant is **Bay Green**, the painted metal of the board. It is the page ground on every page in
both modes and roughly 55 percent of any viewport. **The page ground is never buff.** Buff belongs
to record surfaces: strips, slips, the active index tab, and buttons, all of which are objects
sitting on the board. So no frame of any page can read as a paper site, even where a buff tab meets
the viewport edge. The five holder colours are an index keyed to the memory kinds, not decoration.

Every colour below was measured against WCAG 2.1 AA on the surface it actually appears on, and the
ratios are recorded in `mockups/board.css` beside each token. Several signals need two values: the
lamp value that sits on the dark board, and an ink value for the same signal printed on buff. A
swatch that reads well on green is usually illegible on paper, and the first version of this
palette failed on exactly the two marks the whole direction rests on, COCKED and UNKNOWN.

### Day watch (light)

| Token | Hex | Role |
|---|---|---|
| Bay green | `#2E4B3C` | Dominant. Page ground, header, rails, footer. |
| Rail shadow | `#24382E` | Recesses, rail sides, board depth. |
| Strip buff | `#EDE4C9` | Record surfaces only. |
| Strip ink | `#20241E` | Text on buff. |
| Chalk | `#E9EDE2` | Text on green chrome. |
| Observation blue | `#3E6FB0` | Holder: observation |
| Resolution green | `#55924F` | Holder: resolution |
| Runbook yellow | `#D9A62E` | Holder: runbook fact |
| Rejected red | `#BC4633` | Holder: rejected hypothesis |
| Entity tan | `#8A5A33` | Holder: entity fact |
| Cocked amber | `#F0A23C` | Staleness. This colour means nothing else, anywhere. |
| Tombstone grey | `#ABA491` | Superseded and evicted paper. |
| Pen blue | `#2C4C9C` | Human annotation ink. Pairs with Caveat. |

### Night watch (dark)

Not an inversion. It is the 3am shift. Documented night-operations practice is to dim the room and
keep warm light on the paper, because dim warm light preserves dark adaptation while the record
still has to be readable. So the board goes near black, chrome recedes, strips stay lit warm buff,
and signal colours gain luminance because a signal has to carry at night. The furniture does not
move; the lighting changed.

Night cab `#131F19`, rail glow `#1B2B22`, lamp buff `#E2D4AC`, night ink `#191C16`, dim chalk
`#8B9887`, holders desaturated about 20 percent (`#46689B`, `#548150`, `#BE9737`, `#A44A39`,
`#7D5936`), night amber `#FFB454`, tombstone `#6E6A5D`. Ink values for signals printed on lamp
buff: amber `#7D4A00`, rejected `#A03222`, protected `#2F5A2C`, stamp grey `#5A553F`. Unlit is
`#93A390`.

**The authoritative list is `apps/web/src/styles/board.css`, and this line was corrected on
2026-08-05 when that file came into existence.** It used to name `mockups/board.css`, which was
right while the mockups were the only implementation and became a trap the moment they stopped
being: two stylesheets, one of them frozen, both claiming to be the list. If a colour is named here
and not in the product stylesheet, it does not exist. The mockups are kept as the bake-off record
and are no longer edited.

Every ratio recorded in that stylesheet is recomputed from the tokens by
`scripts/check-contrast.mjs` on every run of `npm run gate`, in both watches, against WCAG 2.1 AA.
A ratio written beside a token that stops being true now fails the build rather than sitting there
being quoted.

### The colour law, grafted from Direction A

**UNKNOWN is never given a colour.** Every other state gets one, because every other state is a
measurement. UNKNOWN means nobody looked, and a colour would be a claim we did not earn. It renders
as an unlit outline: an annunciator lamp that is off, an empty holder, a dashed border with no
fill. An unlit lamp is not an OK lamp, and the design must never let it read as one.

---

## 4. Structure

There is no hero. No centred headline block. No alternating text-and-image sections. No card grid.

**Every page is one persistent artefact, the board.** Its chrome never leaves the viewport, and
content arrives as records posted into bays.

Fixed chrome on every page:

- **Header strip.** THROUGHLINE in signage caps left; a designator block right in instrument type
  (TLN-01 / CRDB x AWS / AGENTIC MEMORY).
- **Annunciator rail.** VECTOR INDEX, EMBEDDINGS, MCP TRANSPORT, each lit OK, DEGRADED, or unlit
  for UNKNOWN. It mirrors /status and appears on every page except /status itself, where the page
  IS the annunciator at full size and a miniature copy of it above would be a second, smaller
  answer to the same question. The rail is everywhere else because the site's whole argument is
  that you should always be able to see what the system can currently do.
- **Source strip.** A footer record naming where this page's numbers came from and how far each can
  be trusted, on every page without exception. Grafted from Direction A's source diagram.

On `/` only, a third piece of chrome:

- **Watch rail.** A vertical tick ruler down the left edge marked in wall-clock time. Scrolling
  does not move through sections, it moves through the watch, and strips post into their bays as
  the clock passes their timestamps. It belongs to the landing page alone, because that is the only
  page whose scroll IS a passage of time. On the console the clock lives in the R/T log gutter
  where each entry carries its own timestamp, and on the archive and status pages there is no
  passage to rail against. A watch rail on those pages would be a decoration that looks like an
  instrument, which is worse than no instrument.

Per page:

- **`/` the board.** Four bays: THE FACT THAT EXPIRED, THE SEARCH THAT NEVER RAN, THE EVICTION THAT
  ATE THE NEWEST ENTRY, and ACTIVE. Each bay carries real strips rather than a paragraph about
  strips. Bay 1 is pinned with the real public-domain flight strip photograph and one Caveat
  annotation. The page ends at the console, not a signup form.
- **`/demo` position and board.** 40/60. Left is the R/T LOG, the incident conversation as a
  position log with timestamps in a fixed gutter and operator lines marked in pen blue. Right is
  THE BOARD, a live rack where every memory event posts a strip whose printed fields are the
  receipt. Between them runs the PRINTER SLOT, a thin rail that new strips visibly emerge from and
  travel into their bay, physically connecting what was said to what was recorded. That is the
  video's money shot. No modals: a strip expands by sliding out of its holder and unfolding.
- **`/memory` the archive.** The same strips, racked as a browsable archive, with filter tabs cut
  as holder tabs in the kind colours. Supersede chains rack vertically with the current strip
  proud and the ended ones behind it in tombstone grey.
- **`/how-it-works` the equipment drawing.** The board as an engineering schematic with part
  callouts, drawn as our own SVG. The long read sits in Petrona at a real reading measure.
- **`/status` the annunciator at full size.** Every legend lit from a real probe. UNKNOWN renders
  unlit, with the last time anyone actually looked printed underneath.

---

## 5. Motion grammar

Named **strip handling**. Paper moves; light dims. Records translate and rotate. They never scale,
never bounce, and never fade for meaning: opacity is reserved for lighting. Decoration never moves.
Motion happens only when the system does something.

| Move | What it means | Spec |
|---|---|---|
| POST | A record was created | Strip slides from the printer slot into its bay slot. translateX, 260ms, `cubic-bezier(.2,.9,.25,1)`, hard stop with a 1px settle. No fade: paper does not fade into existence. |
| COCK | Staleness flagged | Rotate to 2.5deg about the left edge, 140ms, `cubic-bezier(.3,0,.2,1)`. Stays cocked until acknowledged. |
| SQUARE | Acknowledged | Rotate back to 0, 120ms, same curve. |
| PULL | Eviction | Strip translates right out of the bay, 180ms ease-in. Its tombstone POSTs into the vacated slot 80ms later. |
| WATCH CHANGE | Theme | The only opacity move. A lighting overlay raises or dims over 420ms. Nothing repositions, because turning the lights down does not move the furniture. |

Scroll-driven POSTs on `/` are position-mapped to the watch rail clock. No parallax, no scroll
jacking. Under `prefers-reduced-motion` every strip is placed instantly **with its cocked angle
intact**, because the cock is information, not animation.

---

## 6. Real media

Abstract decoration is banned as a primary visual. What actually carries the pages:

1. **A real flight strip.** Wikimedia Commons `File:French_flight_strip_2008.jpg`, a scan of a
   strip produced during an ATC training simulation at ENAC, France. Licence verified via the
   Commons API on 2026-08-03: public domain, author "StC". Downloaded to
   `design/assets/french-flight-strip-2008.jpg`. Carries bay 1 of `/` and the header of
   `/how-it-works`.
2. **Our own live telemetry as media.** Real receipts from the proven CockroachDB cluster with
   real query text, real candidate counts, real elapsed milliseconds. Every number printed on a
   strip is a number the system produced. Nothing anti-slops harder than your own data.
3. **Made-for-this photography.** Print Throughline's own strips on buff card, annotate them by
   hand in blue and red pen, rack them, macro-photograph them. Ours, so the licence is ours. This
   is the one asset not yet produced; it is listed in HUMAN-TODO rather than claimed here.
4. **One citation as an artefact.** The Mackay pull-quote on `/how-it-works`, set as a strip with
   its DOI, so the engineer who wants to argue with the metaphor has something to argue with.

---

## 7. Voice

Active verbs, real numbers, no apology. The system says what it did and what it did not do.

- "ANN INDEX read 200 of 4,102 rows in 46 ms and stopped at the cap. Verdict: PARTIAL."
- "No search ran, so I will not claim there are no prior incidents. Verdict: UNKNOWN."
- "Eviction refused 3 entries still inside the 24 hour grace window. Receipt filed."
- "Superseded at 03:07. The old row stays on the board, end dated, still queryable."
- "Rejected hypothesis, kept on purpose: it was not the CDN, and we lost forty minutes proving it."
- Button verbs: "Open the console", "Audit the archive", "Send and record". Never "Submit",
  never "Get started". Not "Force an exact scan": that control cannot exist, because the exact
  scan needs the embedder too.
- Errors explain: "The embedding provider timed out at 2,004 ms. I stopped rather than answer from
  half a search."
- Empty state: "No strips on this board yet. The first incident posts the first one."

---

## 8. Real values, and why this section exists

Both bake-off mockups printed a grace window that the product does not have. The numbers on these
pages come from `packages/memory/src/policy.ts` and nowhere else:

| Policy value | Real setting |
|---|---|
| Grace window | 24 hours |
| Half-life, entity fact | 14 days |
| Half-life, observation | 30 days |
| Half-life, runbook fact | 90 days |
| Half-life, resolution | 180 days |
| Half-life, rejected hypothesis | 365 days |
| Stale floor | 0.5 |
| Similarity floor | 0.6 |
| Candidate cap | 200 |

A mockup that invents a number teaches the build to ship it. If this table and the code ever
disagree, the code is right and this file gets corrected.

**Numbers derived from those values are just as binding, and they are the ones that slip.** The
candidate cap is bound to `LIMIT` on both retrieval paths, so a recall receipt can never report
more than 200 candidates read. Three pages first printed counts of 1,214 and 4,102, which the cap
makes impossible; a receipt claiming them would be a lie told in the product's own house style. The
same applies to the retrieval story. An embedder outage is not something an exact scan can rescue,
and the reason is worth getting right, because the first version of this paragraph got it backwards.
The path is chosen first and the query is embedded second. What makes the outage total is that
*both* branches of the candidate query order by `embedding <=> $2`, so both need a query vector.
Neither path runs, and the verdict is UNKNOWN. Copy that offers "force an exact scan, it does not
need the embedder" is describing a product we did not build.

---

## 9. What would make this fail

Kept here so a later pass can check the direction rather than admire it.

- **The mono creeping out of its cage.** If B612 Mono reaches captions and chrome, the page becomes
  the banned code-editor look. Audit: no `font-family` of B612 Mono outside a record or a verdict.
- **Buff touching the viewport edge.** The moment a page ground is paper, this is a warm-paper site
  and the direction is dead. Audit: `body` background is bay green or night cab on every page.
- **The strips becoming a card grid.** Strips are full-width records in a rack, in one column per
  bay. Three strips side by side in equal boxes is the banned pattern wearing a holder.
- **Craft cosplay.** Caveat above 19px, or used for anything the machine said, turns the whole
  thing into a costume. It should appear about four times across five pages.
- **Cocking becoming decoration.** Only a stale record cocks. If anything cocks for visual interest
  the device stops carrying information and becomes an effect.
