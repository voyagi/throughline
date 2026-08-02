// Complexity budgets plus cross-browser compat. These are FLOORS, not style nags: 25 is roughly
// twice the common 15, so only genuinely tangled functions fire. A hit means refactor the hotspot
// or raise it for that one file with a written reason. Never blanket-disable.
import sonarjs from 'eslint-plugin-sonarjs';
import compat from 'eslint-plugin-compat';
import tseslint from 'typescript-eslint';

const tsParser = {
  parser: tseslint.parser,
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
};

// Vendored tooling: copied in wholesale as a tool rather than written as product code, so a
// product complexity budget would measure the wrong thing. Keep this list short and keep product
// code out of it. Anything added here stops being measured, which is a cost, not a convenience.
const VENDORED_TOOLING = ['verify-ship.mjs'];

export default [
  {
    ignores: [
      '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}',
      '**/*.config.{ts,js,mjs,cjs}',
      '**/{dist,build,coverage,cdk.out,.astro,node_modules}/**',
      ...VENDORED_TOOLING,
    ],
  },
  // Complexity budgets across all product source.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    languageOptions: { ...tsParser },
    plugins: { sonarjs },
    rules: {
      complexity: ['error', 25],
      'sonarjs/cognitive-complexity': ['error', 25],
    },
  },
  // Cross-browser gate, CLIENT code only. These globs name the real client directories in this
  // repo. Everything else is Node and would false-positive (Node exposes fetch and structuredClone
  // as globals, which compat reads against the browserslist target).
  {
    files: [
      'apps/web/src/islands/**/*.{ts,tsx,js,jsx}',
      'apps/web/src/components/**/*.{ts,tsx,js,jsx}',
      'apps/web/src/scripts/**/*.{ts,js}',
    ],
    languageOptions: { ...tsParser },
    plugins: { compat },
    rules: { 'compat/compat': 'error' },
  },
];
