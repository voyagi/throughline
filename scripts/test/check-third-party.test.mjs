import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import {
  assessRun,
  auditSources,
  exitCodeFor,
  foreignHost,
  looksLikeLocator,
  metaRefreshTarget,
  referencesInCss,
  referencesInHtml,
  srcsetUrls,
  urlListUrls,
} from '../lib/third-party.mjs';

/**
 * The third-party gate's own controls, exercised against planted violations.
 *
 * THIS FILE EXISTS BECAUSE THE GATE COULD NOT FAIL. It was added to stop a one-time browser
 * measurement from rotting, on the argument that a manual pass "cannot fail on the day somebody
 * pastes the link back". A review then measured the gate against its own argument: five separate
 * one-line mutations, including `foreignHost()` returning null and the whole failure branch
 * disabled, each left the suite at 1022 passed. Under the first of them the verbatim Google Fonts
 * link went straight through and the gate printed its clean line.
 *
 * So every rule below is planted and named. The cases are not decorative: three of these shapes
 * were live bypasses in the shipped gate rather than hypotheticals. `<astro-island component-url>`
 * is how all ten of this site's JavaScript bundles are loaded and the gate could not see the
 * attribute at all. `<base href>` turns every safe relative reference on a page foreign while
 * naming nothing itself. And seven URL spellings a browser resolves to another host were invisible
 * to a hand-rolled parser.
 *
 * One case needs a literal U+0001, which is invisible in an editor and unmatchable by a text edit.
 * It is built with `String.fromCharCode` so the source says what it means.
 */

const host = (value) => foreignHost(value);
const FOREIGN = 'cdn.evil.example';
const START_OF_HEADING = String.fromCharCode(1);
const BACKSLASH = String.fromCharCode(92);

describe('foreignHost', () => {
  it.each([
    ['a root-relative path', '/fonts/Petrona-var-latin.woff2'],
    ['a bare relative path', 'fonts/x.woff2'],
    ['a fragment', '#main'],
    ['a query', '?filter=runbook_fact'],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('leaves %s alone', (_label, value) => {
    expect(host(value)).toBeNull();
  });

  it.each([
    ['data', 'data:image/svg+xml;base64,AAAA'],
    ['blob', 'blob:https://cdn.evil.example/abc'],
    ['mailto', 'mailto:someone@example.com'],
    ['tel', 'tel:+310000000'],
    ['javascript', 'javascript:void 0'],
  ])('does not treat a %s: url as a request to a host', (_label, value) => {
    expect(host(value)).toBeNull();
  });

  it('reads a plain absolute url', () => {
    expect(host(`https://${FOREIGN}/css2?family=Caveat`)).toBe(FOREIGN);
  });

  it('reads a protocol-relative url, the spelling most likely to be missed by eye', () => {
    expect(host(`//${FOREIGN}/css2`)).toBe(FOREIGN);
  });

  /**
   * THE SEVEN SPELLINGS A HAND-ROLLED PARSER MISSED. A browser resolves every one of these to a
   * foreign host, and every one returned null before this function used the URL parser. They are
   * asserted one by one rather than in a loop over a truthy check, so a failure names the spelling
   * that regressed.
   */
  it.each([
    ['a backslash pair', `\\\\${FOREIGN}/x`],
    ['a slash then a backslash', `/\\${FOREIGN}/x`],
    ['a backslash then a slash', `\\/${FOREIGN}/x`],
    ['a tab inside the double slash', `/\t/${FOREIGN}/x`],
    ['a newline inside the scheme', `ht\ntps://${FOREIGN}/x`],
    ['a leading U+0001', `${START_OF_HEADING}https://${FOREIGN}/x`],
    ['four slashes', `////${FOREIGN}/x`],
  ])('resolves %s to the foreign host', (_label, value) => {
    expect(host(value)).toBe(FOREIGN);
  });

  it('reads a bare backslash pair carrying no forward slash at all', () => {
    // This one is load bearing for the locator filter in referencesInHtml, which skips any
    // attribute value containing none of `/`, `\` or `:`. Drop the backslash from that set and
    // this spelling walks past the gate.
    expect(host(`\\\\${FOREIGN}`)).toBe(FOREIGN);
  });

  it.each([
    ['https:host/x', 'https:samehost/x'],
    ['https:/host/x', 'https:/samehost/x'],
  ])('does not invent a foreign host for %s, which stays on this origin', (_label, value) => {
    // The other direction of the same defect: the hand-rolled parser reported a host for these,
    // which is fail-closed and still a disagreement with the browser.
    expect(host(value)).toBeNull();
  });
});

describe('srcsetUrls', () => {
  it('takes the url from every candidate and drops the descriptors', () => {
    expect(srcsetUrls('/a.png 1x, https://cdn.evil.example/b.png 2x,  /c.png 480w')).toEqual([
      '/a.png',
      'https://cdn.evil.example/b.png',
      '/c.png',
    ]);
  });
});

describe('referencesInCss', () => {
  const values = (css) => referencesInCss(css).map((one) => one.value);

  it('reads a quoted url()', () => {
    expect(values('@font-face{src:url("/fonts/Petrona-var-latin.woff2") format("woff2")}')).toContain(
      '/fonts/Petrona-var-latin.woff2',
    );
  });

  it('reads an unquoted url()', () => {
    expect(values(`.hand{background:url(https://${FOREIGN}/pixel.png)}`)).toContain(`https://${FOREIGN}/pixel.png`);
  });

  it('reads every url in a comma-separated src', () => {
    const css = `@font-face{src:url("/a.woff2") format("woff2"),url("https://${FOREIGN}/b.woff") format("woff")}`;
    expect(values(css)).toEqual(['/a.woff2', `https://${FOREIGN}/b.woff`]);
  });

  it('does not stop at a closing bracket inside a quoted url', () => {
    // `[^)]+` cannot cross the `)` even when it sits inside quotes, which silently truncated the
    // value and made the host unreadable.
    expect(values(`.x{background:url("https://${FOREIGN}/a)b.png")}`)).toEqual([`https://${FOREIGN}/a)b.png`]);
  });

  it('reads a bare-string @import', () => {
    expect(values(`@import "https://${FOREIGN}/theme.css";`)).toContain(`https://${FOREIGN}/theme.css`);
  });

  it('reads an image-set candidate that carries no url() at all', () => {
    expect(values(`.x{background:image-set("/a.png" 1x,"https://${FOREIGN}/b.png" 2x)}`)).toContain(
      `https://${FOREIGN}/b.png`,
    );
  });

  it('does not stop at a closing bracket inside an image-set candidate', () => {
    // The identical defect that was fixed for url() survived one function below it, which is this
    // repository's recurring shape: the sibling nobody looked at.
    expect(values(`.x{background:image-set("https://${FOREIGN}/a)b.png" 1x)}`)).toEqual([
      `https://${FOREIGN}/a)b.png`,
    ]);
  });

  it('stays silent about an @namespace, which names an XML vocabulary and is never fetched', () => {
    expect(values('@namespace url(http://www.w3.org/1999/xhtml);')).toEqual([]);
  });

  it('still reads a url() that follows an @namespace', () => {
    // The namespace is removed before extraction, so this is the case that proves the removal does
    // not eat the declaration after it.
    const css = `@namespace url(http://www.w3.org/1999/xhtml);.x{background:url("https://${FOREIGN}/a.png")}`;
    expect(values(css)).toEqual([`https://${FOREIGN}/a.png`]);
  });
});

describe('metaRefreshTarget', () => {
  /**
   * Four spellings a browser honours were missed, all measured against the built site before this
   * function followed the WHATWG shared declarative refresh steps rather than the obvious case.
   */
  it.each([
    ['a semicolon separator', '0;url=https://x.example/a', 'https://x.example/a'],
    ['a comma separator', '0,url=https://x.example/a', 'https://x.example/a'],
    ['a whitespace separator', '0 url=https://x.example/a', 'https://x.example/a'],
    ['no url= prefix at all', '0;https://x.example/a', 'https://x.example/a'],
    ['a quoted value', `0;url='https://x.example/a'`, 'https://x.example/a'],
    ['trailing junk after the closing quote', `0;url='https://x.example/a' rubbish`, 'https://x.example/a'],
    ['spaces around the equals', '0; url = https://x.example/a', 'https://x.example/a'],
  ])('reads %s', (_label, content, expected) => {
    expect(metaRefreshTarget(content)).toBe(expected);
  });

  it.each([
    ['a bare time, which refreshes this page', '5'],
    ['a time and nothing after the separator', '5;'],
    ['an empty value', ''],
  ])('returns null for %s', (_label, content) => {
    expect(metaRefreshTarget(content)).toBeNull();
  });
});

describe('urlListUrls', () => {
  it('splits a whitespace separated list', () => {
    expect(urlListUrls('/local  https://cdn.example/track\n/other')).toEqual([
      '/local',
      'https://cdn.example/track',
      '/other',
    ]);
  });
});

describe('looksLikeLocator', () => {
  it.each([
    ['a root-relative path', '/a.css'],
    ['an http url', 'http://x.example/a'],
    ['an https url', 'HTTPS://x.example/a'],
    ['a protocol-relative url', '//x.example/a'],
    ['a backslash pair', `${BACKSLASH}${BACKSLASH}x.example`],
    ['a control-led protocol-relative url', `${START_OF_HEADING}//x.example/a`],
  ])('accepts %s', (_label, value) => {
    expect(looksLikeLocator(value)).toBe(true);
  });

  it.each([
    ['a mime type', 'text/css'],
    ['an og key', 'og:url'],
    ['a twitter key', 'twitter:card'],
    ['a media query', '(prefers-color-scheme: light)'],
    ['a json blob', '{"apiBase":[0,"x"]}'],
    ['a bare word', 'stylesheet'],
    ['a mailto', 'mailto:someone@example.com'],
  ])('rejects %s', (_label, value) => {
    // Rejecting costs nothing in safety: foreignHost returns null for every scheme that is not http
    // or https, so a value this drops could not have produced a finding. What it buys is a count
    // that can reach zero, which is the only thing the per-page liveness guard has to read.
    expect(looksLikeLocator(value)).toBe(false);
  });
});

describe('referencesInHtml', () => {
  const found = (html) => referencesInHtml(html, parseHTML);
  const hosts = (html) => found(html).map((one) => foreignHost(one.value)).filter((one) => one !== null);

  /**
   * THE CONSTRUCT THIS SITE ACTUALLY USES. Every JavaScript bundle on every page is fetched by a
   * custom element with two ordinary-looking attributes, and a gate that listed the constructs it
   * knew to fetch could not see either of them.
   */
  it.each([
    ['component-url', `<astro-island component-url="https://${FOREIGN}/_astro/Console.js"></astro-island>`],
    ['renderer-url', `<astro-island renderer-url="https://${FOREIGN}/_astro/client.js"></astro-island>`],
    ['before-hydration-url', `<astro-island before-hydration-url="https://${FOREIGN}/_astro/hy.js"></astro-island>`],
  ])('reports an astro-island %s pointing at another host', (_label, html) => {
    expect(hosts(html)).toEqual([FOREIGN]);
  });

  it('reports a base href, which makes every relative reference on the page foreign', () => {
    // One attribute converts a page of safe root-relative references into a page fetched entirely
    // from somewhere else, while each of those references still names no host.
    expect(hosts(`<base href="https://${FOREIGN}/">`)).toEqual([FOREIGN]);
  });

  it.each([
    ['a stylesheet link', `<link rel="stylesheet" href="https://${FOREIGN}/css2">`],
    ['a preconnect, which fetches nothing and leaks the address anyway', `<link rel="preconnect" href="https://${FOREIGN}">`],
    ['a rel nobody listed', `<link rel="manifest" href="https://${FOREIGN}/app.webmanifest">`],
    ['a link with no rel at all', `<link href="https://${FOREIGN}/whatever.css">`],
    ['a script src', `<script src="https://${FOREIGN}/a.js"></script>`],
    ['an img src', `<img src="https://${FOREIGN}/a.png" alt="">`],
    ['an iframe src', `<iframe src="https://${FOREIGN}/x"></iframe>`],
    ['an object data', `<object data="https://${FOREIGN}/x.swf"></object>`],
    ['a video poster', `<video poster="https://${FOREIGN}/p.jpg"></video>`],
    ['an svg use href', `<svg><use href="https://${FOREIGN}/s.svg#i"></use></svg>`],
    ['a body background', `<body background="https://${FOREIGN}/bg.png"></body>`],
    ['a preload imagesrcset with no href', `<link rel="preload" as="image" imagesrcset="https://${FOREIGN}/b.png 2x">`],
    ['an anchor ping, which POSTs on click', `<a href="/x" ping="https://${FOREIGN}/p">x</a>`],
    ['a form action, which POSTs the form off-site', `<form action="https://${FOREIGN}/collect"></form>`],
    ['a meta refresh, which moves the visitor', `<meta http-equiv="refresh" content="0;url=https://${FOREIGN}/x">`],
    ['a style attribute url()', `<div style="background:url(https://${FOREIGN}/a.png)"></div>`],
    ['an inline style element', `<style>.x{background:url("https://${FOREIGN}/a.png")}</style>`],
    ['a nested document inside srcdoc', `<iframe srcdoc="&lt;link rel=stylesheet href=https://${FOREIGN}/a.css&gt;"></iframe>`],
  ])('reports %s', (_label, html) => {
    expect(hosts(html)).toContain(FOREIGN);
  });

  it('reports a link whose rel MIXES a fetching value with a data one', () => {
    // THE CASE FOR THE `every` IN THE REL TEST, and the reason it needs one. A `rel` is a list, and
    // a link is data only when EVERY value in it is data. Relaxing that to "any value is data"
    // survived the whole suite, and `rel="stylesheet canonical"` then walked through the gate: the
    // reference disappeared entirely rather than being judged safe. The six cases around this one
    // all use a single-value rel, so none of them can tell the two spellings apart.
    expect(hosts(`<link rel="stylesheet canonical" href="https://${FOREIGN}/css2">`)).toEqual([FOREIGN]);
  });

  it('stays silent about a link whose rel values are ALL data', () => {
    // The other half of the same pair, so the rule reads as a rule rather than as one example.
    expect(hosts(`<link rel="alternate canonical" href="https://${FOREIGN}/nl/">`)).toEqual([]);
  });

  it('reports every candidate in a srcset, not just the first', () => {
    expect(hosts(`<img alt="" srcset="/a.png 1x, https://${FOREIGN}/b.png 2x">`)).toEqual([FOREIGN]);
  });

  /**
   * THE NEGATIVE CONTROLS. The risk in every review round of this repository has been the path
   * nobody looked at rather than over-refusal, but a gate that reported canonical would fail all
   * five pages the moment a real deploy URL was configured, so these are pinned too.
   */
  it.each([
    ['a canonical link, which is absolute by construction', `<link rel="canonical" href="https://${FOREIGN}/page/">`],
    ['an alternate link', `<link rel="alternate" hreflang="nl" href="https://${FOREIGN}/nl/">`],
    ['an anchor a visitor has to click', `<a href="https://${FOREIGN}/docs">docs</a>`],
    ['ordinary metadata', `<meta property="og:url" content="https://${FOREIGN}/page/">`],
    ['a blockquote cite', `<blockquote cite="https://${FOREIGN}/src">x</blockquote>`],
  ])('stays silent about %s', (_label, html) => {
    expect(hosts(html)).toEqual([]);
  });

  it('reports a bare backslash pair, which carries neither a colon nor a forward slash', () => {
    // THE CASE THAT MAKES THE BACKSLASH HALF OF THE LOCATOR FILTER LOAD BEARING. The filter drops
    // any value with no colon, no backslash and no leading slash, and this value has only
    // backslashes: a browser resolves it to a host and nothing else about it says so. A plant that
    // removed the backslash from the filter went unnoticed until this case existed.
    const html = `<astro-island component-url="${BACKSLASH}${BACKSLASH}${FOREIGN}"></astro-island>`;
    expect(hosts(html)).toEqual([FOREIGN]);
  });

  it('reports a value led by a control character, which a browser strips before resolving', () => {
    // THE CASE FOR THE STRIP CLAUSE OF THE LOCATOR FILTER, and the third of its three clauses to
    // get one. A review measured what its absence cost: removing the strip made this exact value
    // DISAPPEAR rather than be judged safe, because without it the value starts with U+0001 and so
    // has no colon, no backslash and no leading slash. It never reaches foreignHost. A browser
    // strips the control and fetches from the host.
    const html = `<astro-island component-url="${START_OF_HEADING}//${FOREIGN}/x.js"></astro-island>`;
    expect(hosts(html)).toEqual([FOREIGN]);
  });

  it('descends into the markup a template carries', () => {
    // `querySelectorAll('*')` does not cross into template content, and `<astro-island>` is exactly
    // the element that uses one: the commit that added coverage for two of its attributes left
    // unread the child it hands its slot markup to.
    const html = `<template><img src="https://${FOREIGN}/t.png" alt=""></template>`;
    expect(hosts(html)).toEqual([FOREIGN]);
  });

  it('descends into the template Astro actually emits for a slot', () => {
    const html =
      `<astro-island component-url="/_astro/Console.js"><template data-astro-template>` +
      `<link rel="stylesheet" href="https://${FOREIGN}/slot.css"></template></astro-island>`;
    expect(hosts(html)).toEqual([FOREIGN]);
  });

  it('reads a style element own attributes, not only its text', () => {
    // The element was special-cased for its CSS and skipped for its attributes, so the one element
    // whose contents are read most carefully was the one whose attributes were read least.
    const html = `<style media="screen" data-src="https://${FOREIGN}/x.css">.a{color:red}</style>`;
    expect(hosts(html)).toContain(FOREIGN);
  });

  it('reports every url in a ping list, not just the first', () => {
    const html = `<a href="/x" ping="/local https://${FOREIGN}/track">x</a>`;
    expect(hosts(html)).toEqual([FOREIGN]);
  });

  it.each([
    ['an xml namespace', `<svg xmlns="http://www.w3.org/2000/svg"></svg>`],
    ['a namespaced xml attribute', `<svg xmlns:xlink="http://www.w3.org/1999/xlink"></svg>`],
    ['a microdata vocabulary', `<div itemscope itemtype="https://schema.org/Person"></div>`],
  ])('stays silent about %s, which names a vocabulary rather than a document', (_label, html) => {
    // Over-refusal in this direction is not harmless: a gate that fails on markup no browser
    // fetches gets weakened by whoever has to make it quiet.
    expect(hosts(html)).toEqual([]);
  });

  it.each([
    ['an og property key', '<meta property="og:type" content="website">'],
    ['a twitter name key', '<meta name="twitter:card" content="summary">'],
    ['a media query', '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#2e4b3c">'],
    ['the island props blob', '<astro-island props=\'{"apiBase":[0,"http://127.0.0.1:8787"]}\'></astro-island>'],
    ['the island opts blob', '<astro-island opts=\'{"name":"Annunciator","value":true}\'></astro-island>'],
  ])('does not count %s as a reference', (_label, html) => {
    // A review counted these: 64 of 104 references were metadata keys and JSON, every one surviving
    // a filter that tested for a colon anywhere. That junk is what made the per-page liveness guard
    // unreachable, because a page stripped of every real reference still counted twelve.
    expect(found(html)).toEqual([]);
  });

  it('does not count an attribute that is not a locator at all', () => {
    // `rel="stylesheet"` and `type="image/svg+xml"` are read by the generic sweep and must not
    // arrive as references: the count is printed on the clean line and is what tells the runner a
    // page was read. A count that includes every attribute can never reach zero.
    const references = found('<link rel="stylesheet" type="text/css" href="/a.css">');
    expect(references.map((one) => one.value)).toEqual(['/a.css']);
  });

  it('stays silent about the site as it is actually built', () => {
    const real =
      '<html lang="en"><head><link rel="canonical" href="http://127.0.0.1:4321/memory/">' +
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' +
      '<link rel="stylesheet" href="/_astro/Board.CrsoFNVy.css">' +
      '<meta property="og:url" content="http://127.0.0.1:4321/memory/"></head>' +
      '<body><astro-island component-url="/_astro/Archive.B3_4mTV7.js" ' +
      'renderer-url="/_astro/client.UYo_IlaB.js"></astro-island></body></html>';
    expect(hosts(real)).toEqual([]);
    // And it did read them: silence has to come from finding nothing foreign, not from finding
    // nothing at all.
    expect(found(real).length).toBeGreaterThanOrEqual(4);
  });
});

describe('auditSources', () => {
  const parse = parseHTML;

  it('counts references per source so an empty half cannot hide behind a full one', () => {
    const { perSource, checked } = auditSources(
      [
        { where: 'index.html', kind: 'html', content: '<link rel="stylesheet" href="/a.css">' },
        { where: 'a.css', kind: 'css', content: '@font-face{src:url("/fonts/a.woff2")}' },
        { where: 'empty.css', kind: 'css', content: '.x{color:red}' },
      ],
      parse,
    );
    expect(perSource).toEqual([
      { where: 'index.html', kind: 'html', references: 1 },
      { where: 'a.css', kind: 'css', references: 1 },
      { where: 'empty.css', kind: 'css', references: 0 },
    ]);
    expect(checked).toBe(2);
  });

  it('reports the source, the construct and the host of every finding', () => {
    const { findings } = auditSources(
      [{ where: 'demo/index.html', kind: 'html', content: `<link rel="preconnect" href="https://${FOREIGN}">` }],
      parse,
    );
    expect(findings).toEqual([
      {
        where: 'demo/index.html',
        construct: '<link rel="preconnect">',
        host: FOREIGN,
        value: `https://${FOREIGN}`,
      },
    ]);
  });

  it('finds nothing in a build whose every reference is relative', () => {
    const { findings, checked } = auditSources(
      [
        { where: 'index.html', kind: 'html', content: '<link rel="stylesheet" href="/_astro/Board.css">' },
        { where: 'Board.css', kind: 'css', content: '@font-face{src:url("/fonts/Petrona-var-latin.woff2")}' },
      ],
      parse,
    );
    expect(findings).toEqual([]);
    expect(checked).toBe(2);
  });
});

/**
 * THE LIVENESS DECISIONS, which used to live in the runner where nothing could reach them.
 *
 * A review mutated seven of the runner's lines one at a time, including all four UNKNOWN guards and
 * the whole failure branch, and the suite stayed at 1086 passed every time. Three of those guards
 * had been added one commit earlier to answer the review before it, so the fix for a control that
 * could not fail was itself a control that could not fail.
 */
describe('assessRun', () => {
  const page = (where, references) => ({ where, kind: 'html', references });
  const sheet = (where, references) => ({ where, kind: 'css', references });
  const healthy = {
    pageCount: 5,
    stylesheetCount: 4,
    perSource: [page('index.html', 4), sheet('Board.css', 13)],
    findings: [],
    checked: 17,
  };

  it('reports clean on a run that inspected something and found nothing', () => {
    expect(assessRun(healthy)).toEqual({ status: 'clean', checked: 17, stylesheetReferences: 13 });
  });

  it('reports the findings when there are any', () => {
    const findings = [{ where: 'index.html', construct: '<link rel="preconnect">', host: 'x', value: 'https://x' }];
    expect(assessRun({ ...healthy, findings })).toEqual({ status: 'findings', findings });
  });

  it.each([
    ['no pages were found', { ...healthy, pageCount: 0 }, 'Zero pages checked is not a pass'],
    ['no stylesheets were found', { ...healthy, stylesheetCount: 0 }, 'so zero is not a pass'],
    [
      'a single page yielded nothing',
      { ...healthy, perSource: [page('index.html', 4), page('status/index.html', 0), sheet('Board.css', 13)] },
      'status/index.html',
    ],
    [
      'the stylesheet half yielded nothing',
      { ...healthy, perSource: [page('index.html', 4), sheet('Board.css', 0)] },
      'stopped being read',
    ],
    [
      'the perSource list carries no stylesheet at all',
      { ...healthy, perSource: [page('index.html', 4)], checked: 4 },
      'stopped being read',
    ],
  ])('is UNKNOWN rather than clean when %s', (_label, input, reason) => {
    const assessment = assessRun(input);
    expect(assessment.status).toBe('unknown');
    expect(assessment.reason).toContain(reason);
  });

  it('names every silent page, not just the first', () => {
    const assessment = assessRun({
      ...healthy,
      perSource: [page('a.html', 0), page('b.html', 0), sheet('Board.css', 13)],
    });
    expect(assessment.reason).toContain('a.html');
    expect(assessment.reason).toContain('b.html');
  });
});

/**
 * THE RUNNER ITSELF, spawned against fixture directories.
 *
 * Every decision moved into this module and a review then measured what was still unreachable:
 * eight one-line mutants of the runner's wiring survived the whole suite, and under one of them the
 * gate printed `1 third-party request(s)` and exited 0. `verify-ship.mjs` reads only the exit
 * status, so that combination ships green while announcing the thing it was built to stop.
 *
 * Testing a verdict is not testing the line that turns a verdict into an exit code.
 */
describe('the runner, end to end', () => {
  const RUNNER = fileURLToPath(new URL('../check-third-party.mjs', import.meta.url));

  // Every fixture directory this file makes, removed when the file is done. A review counted seven
  // left behind per run, pass or fail, in a test the ship gate runs.
  const made = [];
  afterAll(() => {
    for (const directory of made) rmSync(directory, { recursive: true, force: true });
  });

  const buildFixture = (files) => {
    const directory = mkdtempSync(join(tmpdir(), 'throughline-thirdparty-'));
    made.push(directory);
    for (const [name, content] of Object.entries(files)) {
      const full = join(directory, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    return directory;
  };

  const run = (distPath) => {
    const result = spawnSync(process.execPath, [RUNNER, distPath], { encoding: 'utf8' });
    return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  const CLEAN_PAGE =
    '<html lang="en"><head><link rel="stylesheet" href="/_astro/a.css">' +
    '<link rel="icon" href="/favicon.svg"></head><body></body></html>';
  const CLEAN_CSS = '@font-face{src:url("/fonts/Petrona-var-latin.woff2") format("woff2")}';

  // THE STYLESHEET LIVES IN A SUBDIRECTORY, exactly as the real build puts all four of its own in
  // `_astro/`. Every fixture here was flat, so the recursion in `filesUnder` was never exercised: a
  // review mutated it to stop descending and the suite stayed green. Against the real build that
  // mutant fails closed, at exit 2 rather than 0, but a control that only works by luck elsewhere
  // is not a control.
  const CSS_PATH = '_astro/a.css';

  it('exits 0 and says so when every reference is relative', () => {
    const { code, output } = run(buildFixture({ 'index.html': CLEAN_PAGE, [CSS_PATH]:CLEAN_CSS }));
    expect(code).toBe(0);
    expect(output).toContain('[third-party] clean');
    expect(output).toContain('not one of them names a host');
  });

  it('exits 1 and names the host when a page reaches another one', () => {
    const page = CLEAN_PAGE.replace('/_astro/a.css', `https://${FOREIGN}/a.css`);
    const { code, output } = run(buildFixture({ 'index.html': page, [CSS_PATH]:CLEAN_CSS }));
    expect(code).toBe(1);
    expect(output).toContain(FOREIGN);
    expect(output).toContain('third-party request(s)');
  });

  it('exits 1 when a STYLESHEET reaches another host, not only a page', () => {
    const css = `${CLEAN_CSS}\n.x{background:url("https://${FOREIGN}/pixel.png")}`;
    const { code, output } = run(buildFixture({ 'index.html': CLEAN_PAGE, [CSS_PATH]:css }));
    expect(code).toBe(1);
    expect(output).toContain(FOREIGN);
  });

  it.each([
    ['there is no built output at all', null],
    ['the directory holds no HTML', { [CSS_PATH]:CLEAN_CSS }],
    ['the directory holds no CSS', { 'index.html': CLEAN_PAGE }],
    ['a page yielded no references', { 'index.html': '<html lang="en"><body>nothing</body></html>', [CSS_PATH]:CLEAN_CSS }],
    ['the stylesheets yielded no references', { 'index.html': CLEAN_PAGE, [CSS_PATH]:'.x{color:red}' }],
  ])('exits 2 rather than 0 when %s', (_label, files) => {
    // A scan that could not run is never reported as clean, and it is never reported as a finding
    // either: exit 1 would turn a failure to measure into a measurement.
    const distPath = files === null ? join(tmpdir(), 'throughline-thirdparty-absent-directory') : buildFixture(files);
    const { code, output } = run(distPath);
    expect(code).toBe(2);
    expect(output).toContain('UNKNOWN');
    expect(output).toContain('Refusing to report clean');
  });
});

describe('exitCodeFor', () => {
  // The assessment object is LAST. Put it second and every name in this table prints it in the slot
  // that claims to be the exit code. That defect has now appeared three times in this session's own
  // tables, each time caught by a plant firing under a name that did not match.
  it.each([
    ['clean', 0, { status: 'clean', checked: 1, stylesheetReferences: 1 }],
    ['findings', 1, { status: 'findings', findings: [{}] }],
    ['unknown', 2, { status: 'unknown', reason: 'anything' }],
  ])('maps %s to exit %s', (_label, code, assessment) => {
    // A scan that could not run is 2 and never 1: reporting a crash as "a third-party request is in
    // the built output" is reporting a failure to measure as a measurement.
    expect(exitCodeFor(assessment)).toBe(code);
  });
});
