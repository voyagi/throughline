#!/usr/bin/env node
// check-a11y.mjs - the second of the two accessibility gates.
//
// It reads the BUILT HTML in apps/web/dist and asserts the structural properties a page has to have
// before any of the visual work matters: a language, a title, one h1, an unbroken heading outline,
// a main landmark, a label on every control, alternative text on every image, discernible text in
// every link and button, and no positive tabindex.
//
// WHY THE BUILT OUTPUT AND NOT THE SOURCE. The pages are Astro components and Preact islands, so
// the markup a visitor receives does not exist in any single source file. A gate reading `.astro`
// files would be checking an intention. This reads what was actually shipped, which includes the
// server-rendered HTML of every island, so a control rendered by a component is covered the same
// way as one written in a template.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not run axe or a headless browser. Both would pull a
// large dependency tree and a browser download into a repository that sets a supply chain cooldown
// on new dependencies, and the checks below are the ones that actually regress when somebody edits
// a layout. A full audit against a real browser belongs in the pre-ship pass, not in every commit.
//
// The rules here are WCAG 2.1 A and AA success criteria: 3.1.1 language of page, 2.4.2 page titled,
// 1.3.1 info and relationships, 2.4.6 headings and labels, 1.1.1 non-text content, 2.4.4 link
// purpose, 2.4.3 focus order.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parseHTML } from 'linkedom';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'apps', 'web', 'dist');

function htmlFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...htmlFiles(full));
    else if (entry.endsWith('.html')) found.push(full);
  }
  return found;
}

/** Text a screen reader would announce for an element, including its accessible-name attributes. */
function accessibleName(element) {
  const label = element.getAttribute('aria-label');
  if (label && label.trim().length > 0) return label.trim();
  const text = (element.textContent ?? '').trim();
  if (text.length > 0) return text;
  // An image inside a link carries the name when the link has no text of its own.
  const image = element.querySelector('img[alt]');
  return image ? (image.getAttribute('alt') ?? '').trim() : '';
}

function checkDocument(document, report) {
  const html = document.documentElement;
  const lang = html?.getAttribute('lang');
  if (!lang || lang.trim().length === 0) report('3.1.1 the <html> element has no lang attribute');

  const title = document.querySelector('title');
  if (!title || (title.textContent ?? '').trim().length === 0) {
    report('2.4.2 the page has no non-empty <title>');
  }

  const mains = document.querySelectorAll('main');
  if (mains.length !== 1) report(`1.3.1 expected exactly one <main> landmark, found ${mains.length}`);
}

function checkHeadings(document, report) {
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const h1s = headings.filter((heading) => heading.tagName.toLowerCase() === 'h1');
  if (h1s.length !== 1) report(`2.4.6 expected exactly one <h1>, found ${h1s.length}`);

  // An outline that jumps from h1 straight to h3 reads as a missing section rather than as a
  // nested one. Levels may close by any amount; they may only OPEN by one at a time.
  let previous = 0;
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    if (previous !== 0 && level > previous + 1) {
      const text = (heading.textContent ?? '').trim().slice(0, 48);
      report(`1.3.1 heading level jumps from h${previous} to h${level} at "${text}"`);
    }
    previous = level;
  }
}

function checkImages(document, report) {
  for (const image of document.querySelectorAll('img')) {
    if (image.getAttribute('alt') === null) {
      report(`1.1.1 an <img src="${image.getAttribute('src') ?? '?'}"> has no alt attribute`);
    }
  }
}

// A control needs a name from SOMEWHERE: a wrapping or associated <label>, an aria-label, or an
// aria-labelledby pointing at something that exists.
function checkControls(document, report) {
  for (const control of document.querySelectorAll('input,select,textarea')) {
    const type = (control.getAttribute('type') ?? '').toLowerCase();
    if (type === 'hidden') continue;
    const id = control.getAttribute('id');
    const labelled =
      (id && document.querySelector(`label[for="${id}"]`)) ||
      control.closest('label') ||
      (control.getAttribute('aria-label') ?? '').trim().length > 0 ||
      (() => {
        const by = control.getAttribute('aria-labelledby');
        return by ? by.split(/\s+/).every((token) => document.getElementById(token) !== null) : false;
      })();
    if (!labelled) report(`1.3.1 a <${control.tagName.toLowerCase()}> control has no associated label`);
  }
}

function checkNames(document, report) {
  for (const link of document.querySelectorAll('a[href]')) {
    if (accessibleName(link).length === 0) {
      report(`2.4.4 an <a href="${link.getAttribute('href') ?? '?'}"> has no discernible text`);
    }
  }

  for (const button of document.querySelectorAll('button')) {
    if (accessibleName(button).length === 0) report('2.4.4 a <button> has no discernible text');
  }
}

function checkFocusOrder(document, report) {
  for (const element of document.querySelectorAll('[tabindex]')) {
    const value = Number(element.getAttribute('tabindex'));
    if (Number.isFinite(value) && value > 0) {
      report(`2.4.3 tabindex="${value}" imposes a manual focus order on <${element.tagName.toLowerCase()}>`);
    }
  }
}

/** The skip link is the first thing in the tab order and it has to point at something real. */
function checkSkipLink(document, report) {
  const skip = document.querySelector('a.skip');
  if (!skip) {
    report('2.4.1 no skip link');
    return;
  }
  const target = (skip.getAttribute('href') ?? '').replace(/^#/, '');
  if (target.length === 0 || document.getElementById(target) === null) {
    report(`2.4.1 the skip link points at "#${target}", which is not on the page`);
  }
}

const CHECKS = [checkDocument, checkHeadings, checkImages, checkControls, checkNames, checkFocusOrder, checkSkipLink];

let pages;
try {
  pages = htmlFiles(DIST);
} catch {
  console.error(
    `[a11y] no built output at ${DIST}. This gate reads what was shipped, so it needs a build ` +
      'first: npm run build -w @throughline/web',
  );
  process.exit(1);
}

// An empty run is UNKNOWN, not clean. A gate that reports success because it found nothing to check
// is the exact failure this repository keeps writing tests about.
if (pages.length === 0) {
  console.error(`[a11y] found no HTML in ${DIST}. Zero pages checked is not a pass.`);
  process.exit(1);
}

let failures = 0;
for (const page of pages) {
  const { document } = parseHTML(readFileSync(page, 'utf8'));
  const where = relative(DIST, page).replace(/\\/g, '/');
  const report = (problem) => {
    failures += 1;
    console.error(`  - ${where}: ${problem}`);
  };
  for (const check of CHECKS) check(document, report);
}

if (failures > 0) {
  console.error(`[a11y] ${failures} failure(s) across ${pages.length} page(s)`);
  process.exit(1);
}

console.log(`[a11y] clean (${pages.length} built page(s) checked against WCAG 2.1 A and AA structure)`);
