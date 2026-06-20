/**
 * The single `EXTERNAL_HOOK_FILES` entry n8n loads with `require()`.
 *
 * tsup bundles this to `dist/hook.cjs`. The source is ESM (`export default`); a tsup
 * `footer` flattens esbuild's `module.exports.default` to a top-level `module.exports`,
 * so `require('/opt/proxy-auth/hook.cjs')` returns `{ n8n: { ready: [fn] } }` directly
 * (n8n reads `.n8n.ready`, not `.default`).
 *
 * All testable logic lives in `./proxy-auth.ts`; this file is only the entry.
 */
import { hook } from './proxy-auth.js';

export default hook;
