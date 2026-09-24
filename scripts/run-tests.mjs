#!/usr/bin/env node
/**
 * Discover and run every package's test files.
 *
 * NOT a glob. The old script handed `node --test` a wildcard pattern and relied
 * on the runner expanding it, which Node 20 does not do — CI failed on BOTH
 * macOS and Windows with "Could not find ..." while passing locally on Node 25.
 * Letting the shell expand it instead breaks on Windows, where cmd.exe does not
 * glob at all.
 *
 * Walking the directory works on every Node version and both platforms.
 */
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields '/C:/...', which
// is not a usable filesystem path.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findTests(dir) {
  const found = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTests(full));
    else if (entry.name.endsWith('.test.mjs')) found.push(full);
  }
  return found;
}

const packages = path.join(root, 'packages');
let files = [];
try {
  for (const pkg of readdirSync(packages)) {
    if (statSync(path.join(packages, pkg)).isDirectory()) {
      files.push(...findTests(path.join(packages, pkg, '__tests__')));
    }
  }
} catch { /* no packages directory */ }
// Repository-level tests (the release bundler) live here rather than inside a
// package, because what they check spans all of them.
files.push(...findTests(path.join(root, '__tests__')));

if (files.length === 0) {
  // A suite that silently runs nothing is worse than one that fails.
  console.error('No test files found under packages/*/__tests__.');
  process.exit(1);
}

console.log(`Running ${files.length} test file(s).`);
// Arguments as an array: no shell, so spaces and unicode in the path are the
// OS's problem rather than a quoting rule that differs per platform.
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
