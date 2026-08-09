// check-third-party.mjs - the gate that keeps a visitor's IP address on this site.
//
// It reads the BUILT output in apps/web/dist and fails when any construct a browser acts on
// without being asked NAMES A HOST. A visitor to an EU-facing site should not have their IP
// address, User-Agent and Referer handed to a third party as a side effect of reading a page, and
// until this gate existed the only thing standing between the site and that was somebody
// remembering not to paste a CDN link.
//
// "NAMES A HOST", NOT "IS CROSS-ORIGIN", and the difference is deliberate. Computing same-origin
// would mean this gate knowing the deployed origin, which lives in PUBLIC_SITE_URL and is not set
// at gate time, so the check would be strongest on a developer's laptop and weakest in the build
// that ships. Every subresource on this site is written as a root-relative path, so the rule
// enforced is the simple one: a subresource may not carry a scheme and a host.
//
// THAT RULE ALONE IS NOT ENOUGH, and a review proved it with one attribute. A relative URL is
// relative to the document's base, so a single `<base href="https://elsewhere/">` sends every
// root-relative reference on the page to that host while each one still names nothing. `<base>` is
// therefore read like any other attribute and reported like any other request.
//
// WHAT COUNTS AS A REQUEST. Every attribute of every element is read, including inside the markup a
// `<template>` carries, and a value that resolves to a host is reported unless the element and
// attribute appear in this gate's small list of URLs a browser does not act on by itself: the href
// of a link a visitor has to click, `cite`, metadata keys, an XML namespace, a microdata type, the
// island's JSON props, and a `<link>` whose every `rel` is canonical, alternate, author, license or
// me. That is the inverse of the first version, which listed the constructs it knew to fetch and
// therefore could not see `<astro-island component-url=...>`, which is how every one of this site's
// ten JavaScript bundles is loaded. srcset candidate lists, `ping` lists, `style` attributes, inline
// `<style>`, the nested document in a `srcdoc`, CSS `url()`, `@import` and `image-set()` are each
// read in their own shape, and a meta refresh is read because it moves the visitor to another site.
//
// WHAT IT DOES NOT COVER, so the green line is not read as more than it is:
//   - The API call the console makes at runtime. That is a deliberate cross-origin fetch() from
//     JavaScript to this project's own API, it is configured rather than hardcoded, and it happens
//     because a visitor asked a question. This gate reads markup and stylesheets, not JS control
//     flow, so it says nothing about it. The island `props` blob that carries that configured base
//     is exempt for the same reason.
//   - Any other URL built inside a JavaScript bundle at runtime.
//   - design/mockups/*.html. Those are design references, they are never built and never served,
//     and they still carry the CDN link on purpose so they render standalone.
//   - Anything a browser extension or the deployment platform injects.
//
// EVERY DECISION, INCLUDING EVERY LIVENESS DECISION, LIVES IN `lib/third-party.mjs` AND IS TESTED
// THERE. An earlier version of this file said it kept "nothing a test needs to hold still" while
// holding four UNKNOWN guards, the failure branch and the exit codes, and a review then mutated
// seven of its lines one at a time with the whole suite staying green. What is left here is the
// filesystem, the printing, and one call each to `assessRun` and `exitCodeFor`.
//
// Exit codes: 0 clean, 1 a third-party request is in the built output, 2 the scan could not run.
// A scan that could not run is never reported as clean, and that includes one that threw.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { assessRun, auditSources, exitCodeFor } from './lib/third-party.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The built output to read, overridable by one argument.
 *
 * THE ARGUMENT EXISTS SO THIS FILE CAN BE TESTED AT ALL. Everything it decides moved into `lib/`,
 * and a review then showed what was left was still a bypass: eight one-line mutants of the wiring
 * below survived the whole suite, and under one of them the gate printed `1 third-party request(s)`
 * and exited 0, which `verify-ship.mjs` reads as green. The decisions being tested elsewhere does
 * not help if the line that turns a verdict into an exit code is never run. `scripts/test` now
 * spawns this file against fixture directories, which is only possible because of this argument.
 *
 * `npm run gate:thirdparty` passes nothing and reads the real build.
 */
const DIST = process.argv[2] ? resolve(process.argv[2]) : join(HERE, '..', 'apps', 'web', 'dist');

function filesUnder(directory, extension) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full, extension));
    else if (entry.endsWith(extension)) found.push(full);
  }
  return found;
}

function report(assessment, pageCount, stylesheetCount) {
  if (assessment.status === 'unknown') {
    console.error(`[third-party] UNKNOWN: ${assessment.reason}`);
    console.error('[third-party] Refusing to report clean on a scan that did not run.');
    return;
  }
  if (assessment.status === 'findings') {
    console.error(`[third-party] ${assessment.findings.length} third-party request(s) in the built output:`);
    for (const finding of assessment.findings) {
      console.error(`  - ${finding.where}: ${finding.construct} requests ${finding.host} -> ${finding.value}`);
    }
    console.error(
      '\nA visitor should not have their address handed to another host for reading a page. Serve ' +
        'the asset from apps/web/public instead. If a third-party request is genuinely intended, it ' +
        'goes in ALLOWED_HOSTS in lib/third-party.mjs, in a pull request that argues for it.',
    );
    return;
  }
  console.log(
    `[third-party] clean (${assessment.checked} reference(s) across ${pageCount} built page(s) and ` +
      `${stylesheetCount} stylesheet(s), of which ${assessment.stylesheetReferences} are in CSS, and ` +
      'not one of them names a host)',
  );
}

function main() {
  const pages = filesUnder(DIST, '.html');
  const stylesheets = filesUnder(DIST, '.css');
  const relativeName = (file) => relative(DIST, file).replace(/\\/g, '/');
  const sources = [
    ...pages.map((file) => ({ where: relativeName(file), kind: 'html', content: readFileSync(file, 'utf8') })),
    ...stylesheets.map((file) => ({ where: relativeName(file), kind: 'css', content: readFileSync(file, 'utf8') })),
  ];

  const { findings, perSource, checked } = auditSources(sources, parseHTML);
  const assessment = assessRun({
    pageCount: pages.length,
    stylesheetCount: stylesheets.length,
    perSource,
    findings,
    checked,
  });
  report(assessment, pages.length, stylesheets.length);
  return exitCodeFor(assessment);
}

let code;
try {
  code = main();
} catch (error) {
  // A scan that threw did not run, so it is UNKNOWN and not a finding. An earlier version let an
  // exception from the audit phase fall through to the same exit code as "a third-party request is
  // in the built output", which reports a crash as a measurement.
  console.error(`[third-party] UNKNOWN: the scan could not run: ${error instanceof Error ? error.message : error}`);
  console.error('[third-party] It reads the built output, so it needs a build first: npm run build -w @throughline/web');
  // The same sentence the other UNKNOWN path prints. Both mean the same thing and a reader, or a
  // test, should not have to know which of the two produced the verdict.
  console.error('[third-party] Refusing to report clean on a scan that did not run.');
  code = 2;
}
process.exit(code);
