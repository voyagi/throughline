import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
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
