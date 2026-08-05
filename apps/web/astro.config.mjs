// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';

/**
 * The site and the console.
 *
 * STATIC OUTPUT, deliberately. Every page here can be rendered at build time, and the one thing
 * that cannot - the live console - talks to `apps/api` from the browser rather than from a server
 * this app would otherwise have to run. That keeps the deployed surface a bucket and a CDN, which
 * is a smaller thing to secure than a second Node process, and it means the pages still render
 * when the API is down. What the console does when the API is down is show that it is down, which
 * is the whole argument of the product applied to itself.
 *
 * `site` comes from the environment because this repository does not have a deployed URL yet, and
 * hardcoding a placeholder would put a canonical tag on every page pointing at somewhere that does
 * not exist. The loopback default is honest about that: it says "this build was made locally".
 * The deploy sets PUBLIC_SITE_URL. It is listed in HUMAN-TODO.md.
 */
const site = process.env.PUBLIC_SITE_URL ?? 'http://127.0.0.1:4321';

export default defineConfig({
  site,
  integrations: [preact()],
  // Loopback only, matching the rest of the repository. Never a bind-all address.
  server: { host: '127.0.0.1' },
  build: {
    // One stylesheet rather than per-page inlining. The board is the same instrument on every
    // page, so a visitor who moves between pages should not re-download it.
    inlineStylesheets: 'never',
  },
});
