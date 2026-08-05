import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // `scripts/test` carries the tests for the repo-level gate scripts, which are plain `.mjs` so
    // they run under bare `node` in a hook with no flags. Their tests are `.mjs` for the same
    // reason: a gate whose own controls are untested is a gate nobody has watched fail.
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'scripts/test/**/*.test.mjs',
    ],
    exclude: [...configDefaults.exclude, '**/*.fault.test.ts', '**/*.fault.example.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: ['**/cli/**', '**/*.d.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 75,
      },
    },
  },
});
