/**
 * The ship gate's spawn decisions, as data and two functions with no process exit and no loop.
 *
 * Split from `verify-ship.mjs` the way `tracked-files.mjs` split from its runner, for the same
 * reason: the runner executes at import, so nothing inside it could be tested without running the
 * whole gate, and the one security-relevant decision in it was pinned by nothing.
 *
 * THE DECISION: no step ever goes through a shell. The gate used to run
 * `spawnSync(step.cmd, { shell: true })`, handing each step string to cmd.exe or /bin/sh, which
 * expands variables, substitutes `$(...)`, splits on its own quoting rules and honours `&&`. Over
 * hardcoded constants that is latent rather than live, but it makes any future influence over a
 * step string command injection ready-made, and it imports the shell's environment-dependent
 * parsing into the one script whose job is to mean the same thing every run. Steps are argv
 * ARRAYS handed to `spawnSync(file, args, { shell: false })`, so a child receives arguments as
 * literal bytes and nothing in between interprets them.
 *
 * WHY npm RUNS AS `node npm-cli.js` RATHER THAN AS `npm`: Windows. `npm` there is `npm.cmd`, a
 * cmd.exe batch shim, and Node refuses to spawn a `.cmd` without a shell: measured on this
 * machine 2026-08-16, `spawnSync('npm.cmd', { shell: false })` errors EINVAL (the CVE-2024-27980
 * hardening) and bare `npm` errors ENOENT, while `spawnSync(process.execPath, [npm-cli.js,
 * '--version'])` answers 11.19.0. So "npm with no shell" means running npm's own JavaScript entry
 * under the node that is already running this script. `npm_execpath` names that entry whenever
 * npm invoked us, which `npm run verify:ship` guarantees; the fallback walks the two layouts npm
 * installs into beside the node binary, and a caller that resolves nothing gets `null`, never a
 * guess.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The verification surface, in run order, cheapest first. Each step is an npm invocation as an
 * argv tail: `['run', 'gate:types']` becomes `node npm-cli.js run gate:types`.
 */
export const STEPS = [
  { name: 'types', args: ['run', 'gate:types'] }, // tsc --noEmit
  // `tsc` cannot read a `.astro` file at all, and the root tsconfig excludes that workspace, so
  // step 1 says nothing whatsoever about the site. This is the step that does.
  { name: 'web', args: ['run', 'gate:web'] }, // astro check
  { name: 'tests', args: ['test'] }, // FULL suite, one-shot
  { name: 'lint', args: ['run', 'lint'] }, // WHOLE-repo lint
  { name: 'gate', args: ['run', 'gate'] }, // committed gate chain (floors)
];

/**
 * The path of npm's JavaScript entry, or null when there is nothing trustworthy to run.
 *
 * Null is a refusal, not a shrug: the runner turns it into a loud exit that names the fix (run
 * this through `npm run verify:ship`), because the alternative of guessing at a shell would put
 * back the exact behaviour this module exists to remove.
 */
export function resolveNpmCli(env = process.env, execPath = process.execPath) {
  const fromEnv = env.npm_execpath;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const nodeDir = path.dirname(execPath);
  const candidates = [
    // Windows layout, fnm multishells included: npm ships in node_modules beside node.exe.
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // POSIX layout: node lives in <prefix>/bin, npm in <prefix>/lib/node_modules.
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Run one argv, shell OFF, and hand back spawnSync's result untouched.
 *
 * The runner keeps its own timeout diagnosis (ETIMEDOUT arrives with a signal too, and the order
 * of those checks matters), so this returns the raw result rather than an opinion about it.
 * `stdio` is overridable for exactly one caller: the test that captures a child's argv to prove
 * nothing interpreted it.
 */
export function runStep(argv, { timeoutMs, stdio = 'inherit' } = {}) {
  const [file, ...args] = argv;
  return spawnSync(file, args, { shell: false, stdio, timeout: timeoutMs, encoding: 'utf8' });
}
