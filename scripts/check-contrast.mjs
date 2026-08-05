#!/usr/bin/env node
// check-contrast.mjs - the first of the two accessibility gates.
//
// It recomputes the WCAG 2.1 contrast ratio for every colour pair the design system CLAIMS, from
// the tokens in apps/web/src/styles/board.css, and fails when a pair drops below AA or when the
// ratio written beside a token stops being true.
//
// WHY THIS RATHER THAN A SCANNER. An automated page scanner reports the contrast of what it can
// see rendered, which on this site is whatever happened to be on screen: an unlit lamp on a page
// where nothing degraded, a cocked strip on a page with no stale rows. The tokens are the thing
// that is actually asserted, they are asserted in writing in the stylesheet, and those written
// ratios are exactly the sort of comment that quietly stops being true when somebody nudges a hex
// value. So this gate reads the claim and checks it.
//
// IT DOES NOT REQUIRE A RECORDED RATIO. An earlier version of this comment said it failed when one
// was missing, and that was never true: deleting a recorded ratio leaves the pair checked against
// the AA floor and nothing else, and the gate exits 0. It stays that way on purpose, because two
// pairs below carry no recorded ratio at all and never did. What is enforced is the floor; what a
// recorded ratio adds is that it cannot go stale silently.
//
// Both watch states are checked. The night palette is not an inversion, it is a different set of
// measured values, and the first version of that palette failed on exactly the two marks the whole
// direction rests on, COCKED and UNKNOWN.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = join(HERE, '..', 'apps', 'web', 'src', 'styles', 'board.css');

/** WCAG 2.1 minimum for normal-size text. Everything listed below is text. */
const AA_TEXT = 4.5;

/**
 * The pairs the stylesheet claims, as (foreground, background).
 *
 * EVERY ENTRY IS A PAIR THAT REALLY OCCURS. A gate that checked plausible combinations rather than
 * real ones would fail on colours that never touch, and the fix for that failure is always to
 * weaken the gate.
 */
// `day` and `night` are the ratios `board.css` RECORDS for that pair, where it records one. They
// live here rather than being scraped out of the comments, and that is the second thing this gate
// learned: a comment says "4.81:1 on bay, 6.26:1 on rail" against ONE token, so a scraper attaches
// the first number it finds to every background that token is ever used on, and then reports a
// mismatch that exists only in the scraper. A ratio is a fact about a PAIR, so it is written
// against a pair.
const PAIRS = [
  { fg: '--ink-soft', bg: '--buff', label: 'field labels on a strip', day: 5.36, night: 5.08 },
  { fg: '--chalk-soft', bg: '--bay', label: 'bay notes on the board', day: 4.59 },
  { fg: '--chalk-dim', bg: '--bay', label: 'designator on the board', day: 4.81, night: 5.61 },
  { fg: '--chalk-dim', bg: '--rail', label: 'lamp legends on the rail', day: 6.26 },
  { fg: '--amber', bg: '--rail', label: 'the DEGRADED lamp', day: 5.92 },
  { fg: '--amber-ink', bg: '--buff', label: 'the COCKED stamp on paper', day: 5.8, night: 5.0 },
  { fg: '--rej-ink', bg: '--buff', label: 'a refusal stamp on paper', day: 5.01, night: 4.79 },
  { fg: '--prot-ink', bg: '--buff', label: 'the PROTECTED stamp on paper', day: 4.93 },
  { fg: '--stamp-grey', bg: '--buff', label: 'a superseded row on paper', day: 5.26, night: 5.08 },
  { fg: '--pen', bg: '--buff', label: 'human annotation on paper', day: 6.31 },
  { fg: '--pen-lit', bg: '--bay', label: 'human annotation on the board', day: 4.66, night: 7.26 },
  { fg: '--lit-ok', bg: '--rail', label: 'the OK lamp', day: 6.88 },
  { fg: '--unlit', bg: '--rail', label: 'the UNKNOWN lamp, which still has to be readable', day: 5.66, night: 5.57 },
  { fg: '--chalk', bg: '--bay', label: 'body text on the board' },
  { fg: '--ink', bg: '--buff', label: 'record text on paper' },
];

function parseTokens(css) {
  // The light palette is everything in the first :root block; the night palette is the same block
  // inside the dark media query, applied OVER the light one, because it overrides rather than
  // replaces.
  const rootBlock = /:root\s*\{([^}]*)\}/g;
  const blocks = [...css.matchAll(rootBlock)].map((match) => match[1]);
  if (blocks.length < 2) {
    throw new Error(
      `expected a :root block for each watch in ${CSS}, found ${blocks.length}. ` +
        'If the palette moved, this gate is reading the wrong file and is not checking anything.',
    );
  }

  const read = (block) => {
    const tokens = new Map();
    for (const line of block.split('\n')) {
      const declaration = /(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})/.exec(line);
      if (declaration) tokens.set(declaration[1], declaration[2]);
    }
    return tokens;
  };

  const light = read(blocks[0]);
  const dark = read(blocks[1]);
  // Night inherits every token the night block does not override, exactly as the cascade does.
  return { day: light, night: new Map([...light, ...dark]) };
}

const channel = (value) => {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
};

function luminance(hex) {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function ratio(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

const css = readFileSync(CSS, 'utf8');
const palettes = parseTokens(css);
const failures = [];
let checked = 0;

for (const [watch, palette] of Object.entries(palettes)) {
  for (const pair of PAIRS) {
    const foreground = palette.get(pair.fg);
    const background = palette.get(pair.bg);
    if (!foreground || !background) {
      failures.push(`[${watch}] ${pair.fg} on ${pair.bg} (${pair.label}): token missing from the palette`);
      continue;
    }

    checked += 1;
    const measured = ratio(foreground, background);
    if (measured < AA_TEXT) {
      failures.push(
        `[${watch}] ${pair.fg} ${foreground} on ${pair.bg} ${background} (${pair.label}): ` +
          `${measured.toFixed(2)}:1 is below AA ${AA_TEXT}:1`,
      );
      continue;
    }

    // A recorded ratio is optional, but one that is WRONG is worse than none: it is a measurement
    // somebody will trust instead of measuring.
    const claimed = pair[watch];
    if (claimed !== undefined && Math.abs(claimed - measured) > 0.05) {
      failures.push(
        `[${watch}] ${pair.fg} on ${pair.bg} (${pair.label}): the stylesheet says ${claimed}:1, ` +
          `the tokens compute ${measured.toFixed(2)}:1`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`[contrast] ${failures.length} failure(s) across ${checked} checked pair(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nFix the token, or fix the ratio written beside it. Do not delete the pair from this gate: ' +
      'a colour that stopped meeting AA is a colour somebody cannot read.',
  );
  process.exit(1);
}

console.log(`[contrast] clean (${checked} pair(s) recomputed against WCAG AA in both watches)`);
