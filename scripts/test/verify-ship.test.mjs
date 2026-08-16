import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolveNpmCli, runStep, STEPS } from '../lib/verify-ship.mjs';

/**
 * The controls on how the ship gate turns a step into a process.
 *
 * These exist because `verify-ship.mjs` ran every step through `spawnSync(step.cmd, { shell:
 * true })`, and nothing pinned that decision either way. The steps were hardcoded constants, so
 * nothing was exploitable on the day, but a gate that parses its own commands through cmd.exe or
 * /bin/sh imports the shell's expansion and quoting into the one script whose job is to mean the
 * same thing every run, and the first refactor to interpolate anything into a step would have
 * inherited command injection ready-made. The runner executes at import, like
 * `check-tracked-files.mjs`, so the decisions moved to `lib/verify-ship.mjs` where a test can
 * hold them still.
 */
describe('the ship gate spawn decisions', () => {
  it('hands arguments to the child EXACTLY, with no shell interpreting them', () => {
    // One probe per shell family: cmd.exe expands %VAR%, POSIX shells expand $VAR and $(...),
    // and both split on unquoted spaces. Under `shell: false` every probe must arrive as its
    // literal bytes in a single argv slot. Flipping the spawn back to `shell: true` makes at
    // least one of them expand or split on every platform, and the equality below fails.
    const probe = ['%OS%', '$HOME', '$(echo injected)', 'two words & echo more'];
    const result = runStep(
      [process.execPath, '-p', 'JSON.stringify(process.argv.slice(1))', ...probe],
      { timeoutMs: 30_000, stdio: 'pipe' },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(String(result.stdout))).toEqual(probe);
  });

  it('resolves npm as a JavaScript entry for this node to run, never as a shell shim', () => {
    // Windows is why this resolution exists at all: `npm` there is `npm.cmd`, a cmd.exe batch
    // shim, and Node refuses to spawn a `.cmd` without a shell (EINVAL, the CVE-2024-27980
    // hardening). Measured on this machine 2026-08-16: `spawnSync('npm.cmd', { shell: false })`
    // errors EINVAL while `spawnSync(node, [npm-cli.js])` answers with npm's version. So "npm
    // with no shell" means npm's own JavaScript under the already-running node, everywhere.
    const resolved = resolveNpmCli();
    expect(resolved).not.toBeNull();
    expect(existsSync(resolved)).toBe(true);
    expect(resolved.toLowerCase().endsWith('.cmd')).toBe(false);
  });

  it('prefers the npm that invoked this process', () => {
    const marker = import.meta.filename;
    expect(resolveNpmCli({ npm_execpath: marker }, process.execPath)).toBe(marker);
  });

  it('returns null rather than guessing when npm cannot be found', () => {
    expect(resolveNpmCli({}, 'C:/definitely/not/here/node.exe')).toBeNull();
  });

  it('keeps every step an argv array of plain npm script tokens', () => {
    // A step is data, and this pins its shape: bare tokens with nothing for any parser to find.
    // Under `shell: false` a token like `test && rm` would be a harmless literal argument, and
    // npm would refuse it as an unknown script; this assertion moves that refusal to the suite.
    expect(STEPS.length).toBeGreaterThan(0);
    for (const step of STEPS) {
      expect(Array.isArray(step.args)).toBe(true);
      expect(step.args.length).toBeGreaterThan(0);
      for (const token of step.args) {
        expect(token).toMatch(/^[\w:.-]+$/);
      }
    }
  });
});
