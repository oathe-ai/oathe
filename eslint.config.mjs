// oathe — the lint gate holds exactly the two rules this codebase has bled on (2026-08-31):
// a dead import invites the next reader to use it (atif.mjs shipped two, used zero times),
// and the harness-agnosticism ruling must be executable — no harness-name literal in code
// outside src/harnesses/ (the adapters ARE the names), tests/ (the spec and the fixtures),
// and the doc-vendoring source table (it carries non-adapter surfaces, so it cannot live on
// an adapter). Style is not linted here; the gate stays signal. Run: npm run lint — the
// linter arrives via pinned npx and never enters the tracked one-dep node_modules.

const HARNESS_LITERALS = ['claude', 'codex', 'cursor'].map((name) => ({
  selector: `Literal[value='${name}']`,
  message: `'${name}' is a harness name — consumers ask the catalog by capability `
    + '(R-HARNESS-TOUCHPOINTS); literals live only on the adapters, in tests, and in the '
    + 'doc-vendoring table.',
}));

export default [
  {
    files: ['**/*.mjs'],
    ignores: ['node_modules/**', 'vendor/**', 'notch/**', '.ai-docs/**'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-restricted-syntax': ['error', ...HARNESS_LITERALS],
    },
  },
  {
    files: ['src/harnesses/**/*.mjs', 'tests/**/*.mjs', 'scripts/pull-harness-docs.mjs', 'eslint.config.mjs'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
