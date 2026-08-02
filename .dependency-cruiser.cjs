// Architecture boundaries for the Throughline monorepo. This file IS the documented architecture:
// if a rule here matches nothing, the wall it describes does not exist.
//
// Which of these rules has actually been seen to FAIL, and which are only configured, is recorded
// per rule in docs/gates.md. Read that rather than assuming this file is proven, and update it in
// the same change as any rule edit.
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  forbidden: [
    {
      name: 'memory-core-is-independent',
      severity: 'error',
      comment:
        'packages/memory is the artifact being judged. It must not import the demo built around it. ' +
        'If the memory layer needs something from an app, that something belongs in the memory layer.',
      from: { path: '^packages/memory/' },
      to: { path: '^(apps|infra)/' },
    },
    {
      name: 'memory-core-has-no-web-framework',
      severity: 'error',
      comment:
        'The memory layer must stay runnable outside a request. No HTTP framework, no browser runtime, ' +
        'no AWS SDK in its import graph. Ports are interfaces defined here and implemented by callers.',
      from: { path: '^packages/memory/' },
      // Two traps live in this one rule, both found by planting a violation and watching it NOT
      // fire. The path of an npm dependency is its RESOLVED path, so it must be matched under
      // node_modules; the bare package name matches nothing. And a `dependencyTypes: ['npm']`
      // filter excludes this exact violation, because an undeclared import resolves as
      // `npm-no-pkg`, so the narrower filter skipped the worst case. The path anchor alone is
      // both sufficient and precise.
      // `(^|/)node_modules/` rather than `^node_modules/`: npm can install a package into a
      // workspace's OWN node_modules instead of hoisting it, and the anchored form misses that
      // entirely. Verified by planting packages/memory/node_modules/hono and watching the
      // anchored rule report clean.
      // No `(/|$)` terminator on the names: `react(/|$)` matches `react` and misses `react-dom`
      // and `react-router`, which is the same class of silent miss as the two above. Prefix
      // matching is correct here, because every package starting with these names is the thing
      // this wall is about.
      to: {
        path:
          '(^|/)node_modules/(hono|astro|@astrojs/|preact|react|@aws-sdk/|aws-cdk-lib' +
          '|express|fastify|koa|next|svelte|vue)',
      },
    },
    {
      name: 'browser-code-stays-in-the-browser',
      severity: 'error',
      comment:
        'Island code is bundled and shipped to visitors. A server import here leaks credentials and ' +
        'Node APIs into a public bundle.',
      from: { path: '^apps/web/src/(islands|components|scripts)/' },
      to: { path: '^(apps/api|packages/memory)/' },
    },
    {
      name: 'browser-code-has-no-node-builtins',
      severity: 'error',
      comment: 'A Node builtin in island code is a bundle error waiting to happen and usually a leaked server path.',
      from: { path: '^apps/web/src/(islands|components|scripts)/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'infra-describes-does-not-run',
      severity: 'error',
      comment: 'The CDK app describes resources. It must never import application logic.',
      from: { path: '^infra/' },
      to: { path: '^(apps|packages)/' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'An import nobody can resolve is a typo or a missing dependency, and it is invisible to ' +
        'every other rule here: an unresolved module has no path to match against, so a mistyped ' +
        'import silently reports clean.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make code hard to reason about, test, and tree-shake.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules (imported by nothing) are usually dead code. Confirm or delete.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)(index|main|entry|handler)\\.[jt]sx?$',
          '\\.config\\.[jt]s$',
          '^apps/web/src/pages/',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Excludes THIS repo's build output only. The obvious pattern, `(^|/)(dist|...)/`, also
    // matches `node_modules/hono/dist/index.js`, which drops every npm package that ships from a
    // dist folder out of the graph entirely and silently disables the rule above. That was the
    // real behaviour here until a planted violation failed to fire.
    exclude: {
      path: '^(apps/[^/]+/(dist|\\.astro)|packages/[^/]+/dist|infra/cdk\\.out|coverage)/',
    },
    ...(fs.existsSync(path.join(__dirname, 'tsconfig.json'))
      ? { tsConfig: { fileName: path.join(__dirname, 'tsconfig.json') } }
      : {}),
    enhancedResolveOptions: { extensions: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'] },
  },
};
