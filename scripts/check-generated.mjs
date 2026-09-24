#!/usr/bin/env node
/**
 * Regenerate, then fail if anything derived from extensions.config.json drifted.
 *
 * The pathspecs are passed to git as an ARGUMENT ARRAY rather than inside a
 * shell string. Quoted inline with single quotes, this passed vacuously on
 * Windows: npm runs scripts through cmd.exe, which does not treat single quotes
 * as quoting, so git received the apostrophes literally, matched no path, and
 * exited 0 — a guard that always passes.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields '/C:/...'.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

execFileSync(process.execPath, ['scripts/generate.mjs'], { stdio: 'inherit', cwd: root });

const pathspecs = ['packages/*/extension.json', 'packages/*/README.md', 'README.md', 'registry.json'];
const diff = spawnSync('git', ['diff', '--exit-code', '--', ...pathspecs], { stdio: 'inherit', cwd: root });

if (diff.status !== 0) {
  console.error('\nGenerated files are stale. Run `npm run generate` and commit the result.');
  process.exit(1);
}
console.log('Generated files are up to date.');
