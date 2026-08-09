/**
 * The decisions behind `scripts/check-third-party.mjs`, extracted so they can be tested.
 *
 * The split matches `lib/tracked-files.mjs` and `lib/advisories.mjs`: this file owns every decision,
 * the script beside it owns the filesystem and turns one verdict into one exit code.
 *
 * WHY IT IS A SEPARATE FILE AT ALL. The first version of this gate kept everything inline and had
 * no test, and a review measured what that was worth: five one-line mutations, including
 * `foreignHost()` returning null and the whole failure branch disabled, each left the suite green.
 * Under the first of them the verbatim Google Fonts link, the one thing this gate exists to keep
 * out, sailed through and the gate printed its clean line.
 *
 * THE SECOND REVIEW FOUND THE EXTRACTION HALF-DONE. The decisions moved here, and every LIVENESS
 * decision stayed in the runner: four UNKNOWN guards, the failure branch and the exit codes, none
 * of which any test could reach. Seven mutants of the runner left the whole suite at 1086 passed,
 * including the three guards written to answer the review before it. `assessRun` and `exitCodeFor`
 * are here for that reason, and the runner is now a call and a `process.exit`.
 */

/**
 * A base whose host cannot collide with a real one, so "does this reference name a host" becomes
 * "does it resolve to somewhere other than here". `.invalid` is reserved by RFC 2606 for exactly
 * this.
 */
const RESOLUTION_BASE = 'https://gate.invalid/';
const BASE_HOST = 'gate.invalid';

/**
 * Hosts a built page is allowed to name.
 *
 * EMPTY, deliberately, and it should stay that way. The site is a static bucket: everything it
 * needs is beside it. An entry here is a promise that some visitor's address goes somewhere else,
 * so adding one is a decision to be argued in a pull request, not a way to make this gate quiet.
 */
export const ALLOWED_HOSTS = new Set();

/**
 * The `rel` values whose URL the browser never fetches on its own.
 *
 * EVERY OTHER `rel` IS TREATED AS A REQUEST. An allowlist of rel values that fetch would wave
 * through the next one nobody thought of. `preconnect` is the proof the conservative direction is
 * right: it fetches nothing at all and leaks the visitor's address anyway.
 */
export const NON_FETCHING_REL = new Set(['canonical', 'alternate', 'author', 'license', 'me']);

/**
 * Element and attribute pairs carrying a URL a browser does not fetch on its own.
 *
 * EVERYTHING NOT LISTED HERE IS TREATED AS A REQUEST, including attributes this file has never
 * heard of. The first version listed the constructs it knew fetched, and this site does not use one
 * of them for its JavaScript: all ten bundles load from `<astro-island component-url=...
 * renderer-url=...>`, two ordinary-looking attributes the gate could not see.
 *
 * `a[href]` and `area[href]` are here because a visitor has to click them, and `cite` refers to a
 * document rather than requesting it.
 *
 * THE METADATA KEYS ARE DELIBERATELY NOT HERE. A review counted what the old colon-anywhere filter
 * cost: 64 of 104 references were `og:type`, `twitter:card`, `(prefers-color-scheme: light)` and the
 * island's JSON props, and that junk made the per-page liveness guard unreachable, because a page
 * stripped of every real reference still counted twelve. The first fix added all five to this set,
 * and a plant then proved every one of those entries dead: `looksLikeLocator` now rejects them on
 * its own, so removing them from here changed nothing. They came back out. A set entry that changes
 * no behaviour reads as coverage and provides none.
 */
const DATA_ATTRIBUTES = new Set(['a|href', 'area|href', 'blockquote|cite', 'q|cite', 'ins|cite', 'del|cite']);

/**
 * Attribute names that identify a vocabulary rather than locate a document, on any element.
 *
 * An XML namespace and a microdata type look exactly like URLs and are never fetched. A review
 * measured the gate refusing `<svg xmlns="http://www.w3.org/2000/svg">` and `itemtype` pointing at
 * schema.org, which is over-refusal on markup no browser requests.
 */
const VOCABULARY_ATTRIBUTES = new Set(['xmlns', 'itemtype', 'itemid']);

/** Attributes holding a whitespace or comma separated list rather than one URL. */
const SRCSET_ATTRIBUTES = new Set(['srcset', 'imagesrcset']);
const URL_LIST_ATTRIBUTES = new Set(['ping']);

/** Everything at or below this code point is stripped before a value is judged a locator. */
const FIRST_PRINTABLE_CODE_POINT = 32;

/**
 * The host a reference points at, or null when it stays on this origin.
 *
 * IT USES THE BROWSER'S OWN ALGORITHM rather than a hand-rolled parser, because a review measured
 * the hand-rolled one disagreeing with a browser in BOTH directions. It missed a backslash pair, a
 * slash then a backslash, a backslash then a slash, a TAB inside the double slash, a newline inside
 * the scheme, a leading U+0001 and four slashes, all seven of which a browser resolves to a foreign
 * host. It also reported a host for `https:host/x`, which resolves to the SAME origin.
 *
 * Anything that is not http or https is not a request to another host: `data:`, `blob:`, `mailto:`,
 * `tel:` and `javascript:` all return null.
 */
export function foreignHost(reference) {
  if (typeof reference !== 'string' || reference.trim().length === 0) return null;
  let url;
  try {
    url = new URL(reference, RESOLUTION_BASE);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.host.toLowerCase();
  return host === BASE_HOST ? null : host;
}

/** Control characters and spaces, which the URL parser removes before it looks at anything else. */
function withoutControls(value) {
  return [...value].filter((character) => character.charCodeAt(0) > FIRST_PRINTABLE_CODE_POINT).join('');
}

/**
 * Could this value locate a document, or is it a word that happens to contain punctuation?
 *
 * WHY IT CANNOT HIDE A HOST, which is an argument rather than a hope. A reference reaches another
 * host in exactly two ways: an http or https scheme, or a protocol-relative prefix of two slashes
 * in some mixture of forward and back slashes. Each clause below covers one of those, and the strip
 * runs first because the URL parser removes control characters before it looks at any of this, so a
 * value led by U+0001 is protocol-relative to a browser.
 *
 * THE SCHEME CLAUSE TESTS FOR http AND https RATHER THAN FOR A COLON. An earlier version tested for
 * a colon anywhere, which is how `og:url`, `twitter:card` and `(prefers-color-scheme: light)` all
 * counted as references. Nothing else can reach a host: `foreignHost` returns null for every other
 * scheme, so a value that is neither slash-led nor http(s)-schemed cannot produce a finding.
 */
export function looksLikeLocator(value) {
  const stripped = withoutControls(value);
  if (stripped.length === 0) return false;
  if (stripped.startsWith('/') || stripped.includes('\\')) return true;
  return /^https?:/i.test(stripped);
}

/** Every srcset candidate is `url [descriptor]`, comma separated. Only the url is a request. */
export function srcsetUrls(value) {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter((url) => url.length > 0);
}

/** `ping` is a space-separated list, and every entry is POSTed to on click. */
export function urlListUrls(value) {
  return value.split(/\s+/).filter((url) => url.length > 0);
}

/**
 * Where a meta refresh sends the visitor, following the WHATWG shared declarative refresh steps.
 *
 * A REGEX SHAPED LIKE THE OBVIOUS CASE MISSED FOUR SPELLINGS BROWSERS HONOUR, all measured against
 * the built site: the separator may be a comma or plain whitespace and not only a semicolon, the
 * `url=` prefix is optional, and a quoted value ends at its closing quote with anything after it
 * ignored. The old pattern anchored the closing quote to the end of the input, so trailing junk fell
 * into its optional-quote branch and it reported success on a value it had misparsed.
 */
export function metaRefreshTarget(content) {
  const match = /^\s*\d+(?:\.\d*)?\s*(?:[;,]|\s)\s*(?:url\s*=\s*)?([\s\S]*)$/i.exec(content);
  if (!match) return null;
  let rest = match[1].trim();
  if (rest.length === 0) return null;
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    rest = end === -1 ? rest.slice(1) : rest.slice(1, end);
  }
  rest = rest.trim();
  return rest.length === 0 ? null : rest;
}

/**
 * Every URL a stylesheet asks the browser to fetch.
 *
 * `url()` and `image-set()` both read a quoted value as a quoted value, so a closing bracket inside
 * quotes no longer ends them early. A review found `image-set()` still truncating that way one
 * function below the place `url()` had just been fixed, which is the same defect one call over.
 *
 * `@namespace` is removed first. It carries a URL that names an XML vocabulary and is never fetched,
 * and reporting it is over-refusal on a construct no browser requests.
 */
export function referencesInCss(css) {
  const withoutNamespaces = css.replace(/@namespace[^;{]*;/gi, '');
  const quoted = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
  const found = [];

  const urlPattern = new RegExp(String.raw`url\(\s*(?:(${quoted})|([^)'"]*))\s*\)`, 'gi');
  for (const match of withoutNamespaces.matchAll(urlPattern)) {
    const value = match[1] === undefined ? (match[2] ?? '') : match[1].slice(1, -1);
    if (value.trim().length > 0) found.push({ construct: 'css url()', value: value.trim() });
  }

  for (const match of withoutNamespaces.matchAll(/@import\s+(?:layer\s*(?:\([^)]*\))?\s*)?(['"])([^'"]+)\1/gi)) {
    found.push({ construct: 'css @import', value: match[2] });
  }

  const imageSetPattern = new RegExp(String.raw`image-set\(((?:${quoted}|[^)'"])*)\)`, 'gi');
  for (const match of withoutNamespaces.matchAll(imageSetPattern)) {
    for (const candidate of match[1].matchAll(new RegExp(quoted, 'g'))) {
      const value = candidate[0].slice(1, -1).trim();
      if (value.length > 0) found.push({ construct: 'css image-set()', value });
    }
  }

  return found;
}

function attributeNamesOf(element) {
  if (typeof element.getAttributeNames === 'function') return element.getAttributeNames();
  // Fail closed rather than silently reading nothing. A DOM without either shape means this gate
  // is inspecting an object it does not understand, and reporting zero references from that is the
  // exact false-clean this file exists to prevent.
  if (!element.attributes) throw new Error('element exposes neither getAttributeNames() nor attributes');
  return [...element.attributes].map((attribute) => attribute.name);
}

/**
 * Every URL in a document that a browser acts on without being asked.
 *
 * It walks every attribute of every element rather than a list of selectors, AND it descends into
 * the markup a `<template>` carries. A review found the sweep stopping at the template boundary,
 * which matters here because `<astro-island>` is exactly the element that uses one: the commit
 * before covered two of its attributes and left unread the child it hands its slot markup to.
 * `querySelectorAll('*')` does not cross into template content, so it is parsed on its own.
 */
export function referencesInHtml(html, parse) {
  const { document } = parse(html);
  const found = [];
  for (const element of document.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase();

    for (const name of attributeNamesOf(element)) {
      const value = element.getAttribute(name);
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      found.push(...referencesForAttribute(element, tag, name.toLowerCase(), value, parse));
    }

    if (tag === 'style') {
      found.push(...referencesInCss(element.textContent ?? ''));
    } else if (tag === 'template') {
      for (const nested of referencesInHtml(element.innerHTML ?? '', parse)) {
        found.push({ construct: `<template> ${nested.construct}`, value: nested.value });
      }
    }
  }
  return found;
}

/** One reference, or none, or several, depending on what the attribute is. */
function referencesForAttribute(element, tag, attribute, value, parse) {
  if (tag === 'link' && attribute === 'href') return linkReferences(element, value);
  if (tag === 'meta' && attribute === 'content') return metaReferences(element, value);
  if (DATA_ATTRIBUTES.has(`${tag}|${attribute}`)) return [];
  if (VOCABULARY_ATTRIBUTES.has(attribute) || attribute.startsWith('xmlns:')) return [];
  if (SRCSET_ATTRIBUTES.has(attribute)) {
    return srcsetUrls(value).map((url) => ({ construct: `<${tag} ${attribute}>`, value: url.trim() }));
  }
  if (URL_LIST_ATTRIBUTES.has(attribute)) {
    return urlListUrls(value).map((url) => ({ construct: `<${tag} ${attribute}>`, value: url.trim() }));
  }
  if (attribute === 'style') return referencesInCss(value);
  if (attribute === 'srcdoc') {
    // A nested document fetches on its own behalf, from inside this page.
    return referencesInHtml(value, parse).map((nested) => ({
      construct: `<${tag} srcdoc> ${nested.construct}`,
      value: nested.value,
    }));
  }
  if (!looksLikeLocator(value)) return [];
  return [{ construct: `<${tag} ${attribute}>`, value: value.trim() }];
}

function linkReferences(element, value) {
  const rels = (element.getAttribute('rel') ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((one) => one.length > 0);
  // A <link> with no rel at all is reported. It does nothing useful, and reading it as harmless
  // would make omitting an attribute the way to get a URL past this gate.
  const isData = rels.length > 0 && rels.every((one) => NON_FETCHING_REL.has(one));
  if (isData) return [];
  return [{ construct: `<link rel="${rels.join(' ') || '(none)'}">`, value: value.trim() }];
}

function metaReferences(element, value) {
  // Metadata is a statement, except the one that moves the visitor to another site.
  const equiv = (element.getAttribute('http-equiv') ?? '').trim().toLowerCase();
  if (equiv !== 'refresh') return [];
  const target = metaRefreshTarget(value);
  return target === null ? [] : [{ construct: '<meta http-equiv="refresh">', value: target.trim() }];
}

/**
 * Audit a set of already-read sources.
 *
 * Returns the findings AND a per-source reference count, because a review proved the aggregate
 * count is not enough: parking the four built stylesheets left the gate reporting clean over
 * `0 stylesheet(s)`, and the thirteen references that vanished with them were all thirteen font
 * `url()`s, which is the entire subject of the change this gate was written for.
 */
export function auditSources(sources, parse) {
  const findings = [];
  const perSource = [];
  for (const source of sources) {
    const references =
      source.kind === 'html' ? referencesInHtml(source.content, parse) : referencesInCss(source.content);
    perSource.push({ where: source.where, kind: source.kind, references: references.length });
    for (const reference of references) {
      const host = foreignHost(reference.value);
      if (host !== null && !ALLOWED_HOSTS.has(host)) {
        findings.push({ where: source.where, construct: reference.construct, host, value: reference.value });
      }
    }
  }
  return { findings, perSource, checked: perSource.reduce((sum, one) => sum + one.references, 0) };
}

/**
 * One verdict for a whole run: `clean`, `findings`, or `unknown` with the reason.
 *
 * EVERY LIVENESS DECISION IS HERE rather than in the runner, because a review proved what happens
 * when they are not. Four UNKNOWN guards and the failure branch lived in the script, and seven
 * one-line mutants of it left the whole suite passing, including the three guards written to answer
 * the review before that one.
 *
 * A run that inspected nothing is UNKNOWN and never clean. That distinction is the repository's own
 * recurring lesson, and each guard below is a different way for the enumeration to have failed
 * while still producing a confident-looking zero.
 */
export function assessRun({ pageCount, stylesheetCount, perSource, findings, checked }) {
  const unknown = (reason) => ({ status: 'unknown', reason });

  if (pageCount === 0) return unknown('found no HTML in the built output. Zero pages checked is not a pass.');
  if (stylesheetCount === 0) {
    return unknown('found no CSS in the built output. This site builds its stylesheets to files, so zero is not a pass.');
  }

  // PER PAGE, NOT IN TOTAL. Every page carries at least a stylesheet link and an icon, so a page
  // yielding nothing was not read, whatever the other four contributed.
  const silent = perSource.filter((one) => one.kind === 'html' && one.references === 0);
  if (silent.length > 0) {
    return unknown(
      `${silent.length} built page(s) yielded zero references: ${silent.map((one) => one.where).join(', ')}. ` +
        'Every page on this site carries at least a stylesheet link and an icon.',
    );
  }

  const stylesheetReferences = perSource
    .filter((one) => one.kind === 'css')
    .reduce((sum, one) => sum + one.references, 0);
  if (stylesheetReferences === 0) {
    return unknown(
      `${stylesheetCount} stylesheet(s) yielded zero references. This site declares 13 @font-face src ` +
        'urls, so a stylesheet half with nothing in it means they stopped being read.',
    );
  }

  // There is deliberately no `checked === 0` guard. Writing one was the obvious next line and a test
  // proved it unreachable: past the two guards above, every page has contributed at least one
  // reference and the stylesheets have contributed at least one, so the total cannot be zero. A
  // branch that can never be true reads as coverage and provides none.
  if (findings.length > 0) return { status: 'findings', findings };
  return { status: 'clean', checked, stylesheetReferences };
}

/** 0 clean, 1 a third-party request is in the built output, 2 the scan could not run. */
export function exitCodeFor(assessment) {
  if (assessment.status === 'clean') return 0;
  if (assessment.status === 'findings') return 1;
  return 2;
}
