#!/usr/bin/env node
/**
 * Post-build patches for the @mastra/deployer-cloudflare bundle.
 *
 * 1. randomUUID swap
 *    Mastra calls `randomUUID()` (from node:crypto) at module top-level when
 *    constructing workflow steps. Cloudflare blocks ALL random generation in
 *    global scope, so the upload-time validation fails. We replace the
 *    `randomUUID` import with a deterministic counter-based stub that's only
 *    used during module init. Real per-request UUIDs still go through the
 *    normal Mastra ID generator inside fetch handlers.
 *
 * 2. Restore frontend wrangler.jsonc
 *    `mastra build` regenerates the root `wrangler.jsonc` to the API worker's
 *    config. We overwrite it back with the canonical frontend config so the
 *    next `npm run deploy` (frontend) doesn't accidentally upload the API.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const bundlePath = resolve(repoRoot, '.mastra/output/mastra.mjs');
if (!existsSync(bundlePath)) {
  console.error(`[patch-mastra-bundle] missing ${bundlePath} — run \`mastra build\` first`);
  process.exit(1);
}

const before = readFileSync(bundlePath, 'utf8');
const importLine = "import { createHash, randomUUID, randomBytes } from 'crypto';";
const stubReplacement =
  "import { createHash, randomBytes } from 'crypto'; " +
  "let __mUUIDCounter = 0; " +
  "const randomUUID = () => '00000000-0000-4000-8000-' + " +
  "(Date.now().toString(16) + (++__mUUIDCounter).toString(16).padStart(4, '0')).padStart(12, '0').slice(-12);";

if (before.includes(importLine)) {
  const after = before.replace(importLine, stubReplacement);
  writeFileSync(bundlePath, after);
  console.log('[patch-mastra-bundle] randomUUID stub installed');
} else if (before.includes('__mUUIDCounter')) {
  console.log('[patch-mastra-bundle] randomUUID stub already present (idempotent)');
} else {
  console.warn('[patch-mastra-bundle] expected import line not found — Mastra may have changed its bundle layout');
  console.warn('  check .mastra/output/mastra.mjs around line 11 and update this script');
  process.exit(2);
}

const wranglerJsoncPath = resolve(repoRoot, 'wrangler.jsonc');
const canonicalFrontend = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "deep-research-mastra",
  "main": "src/worker/index.ts",
  "compatibility_date": "2025-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "observability": {
    "enabled": true
  },
  "vars": {},
  "services": [
    {
      "binding": "MASTRA",
      "service": "deep-research-mastra-api"
    }
  ]
}
`;

if (existsSync(wranglerJsoncPath)) {
  const current = readFileSync(wranglerJsoncPath, 'utf8');
  if (current.includes('auto-generated through Mastra') || current.includes('deep-research-mastra-api')) {
    writeFileSync(wranglerJsoncPath, canonicalFrontend);
    console.log('[patch-mastra-bundle] restored frontend wrangler.jsonc');
  }
}
