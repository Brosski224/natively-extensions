#!/usr/bin/env node
/**
 * Fails if any model weight, or any file over 10 MB, is tracked.
 *
 * Runs in CI and as a pre-commit hook, so "no weights in git" holds by
 * construction rather than by everyone remembering.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const MAX_BYTES = 10 * 1024 * 1024;
const WEIGHT_RE = /\.(gguf|onnx|safetensors|bin|pt|pth)$/i;

// Only files git tracks or has staged. An untracked local model that
// .gitignore already excludes is not a failure.
const staged = process.argv.includes('--staged');
const files = execFileSync('git',
  staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACM'] : ['ls-files'],
  { encoding: 'utf8' }).split('\n').map((f) => f.trim()).filter(Boolean);

const problems = [];
for (const file of files) {
  if (WEIGHT_RE.test(file)) {
    problems.push(`${file}: model weights must never be committed`);
    continue;
  }
  let size;
  try { size = statSync(file).size; } catch { continue; } // deleted in this commit
  if (size > MAX_BYTES) {
    problems.push(`${file}: ${(size / 1024 / 1024).toFixed(1)} MB exceeds the 10 MB limit`);
  }
}

if (problems.length) {
  console.error('Weight guard FAILED:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`Weight guard passed (${files.length} files checked).`);
