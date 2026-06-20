import { defineConfig } from 'tsup';

/**
 * Single-artifact build. The ONLY emitted file is `dist/hook.cjs` — the
 * `EXTERNAL_HOOK_FILES` entry n8n loads with `require()`. There is no separate
 * library artifact: helper modules are consumed from source only.
 *
 * `sourcemap: false` keeps `dist/` to exactly one file (a require()-loaded hook
 * inside the image ships no source, so a map has near-zero value).
 */
export default defineConfig({
  entry: ['src/hook.ts'],
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  sourcemap: false,
  clean: true,
  dts: false,
  outDir: 'dist',
  // The image ships ONLY dist/hook.cjs into /opt/proxy-auth/ with no node_modules
  // alongside it, so a bare `require("jose")` is unresolvable from there (jose lives only
  // inside n8n's nested pnpm store). Bundle jose INTO the artifact so it is self-contained.
  // n8n internals (@n8n/di, @n8n/db, ./auth/auth.service.js) are intentionally NOT bundled:
  // they are resolved at runtime via the anchored createRequire, never a static import.
  noExternal: ['jose'],
  outExtension: () => ({ js: '.cjs' }),
  // Flatten esbuild's `module.exports = { default: hook }` to `module.exports = hook`
  // so n8n's `require()` sees `{ n8n: { ready: [fn] } }` at the top level.
  footer: { js: 'module.exports = module.exports.default;' },
});
