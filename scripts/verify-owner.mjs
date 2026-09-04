#!/usr/bin/env node
/**
 * Fails if the GitHub owner appears anywhere except extensions.config.json and
 * the files generate.mjs derives from it.
 *
 * This repository is expected to change hands, so a stray owner string is a
 * latent broken link. GitHub keeps a redirect after a transfer, so old URLs
 * keep resolving — but the canonical name should still be updated here.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const { owner } = JSON.parse(readFileSync('extensions.config.json', 'utf8'));
if (owner === 'REPLACE_ME') {
  console.log('owner is still the placeholder; nothing to verify yet.');
  process.exit(0);
}

const ALLOWED = (f) =>
  f === 'extensions.config.json' || f === 'registry.json' ||
  /(^|\/)README\.md$/.test(f) || /(^|\/)extension\.json$/.test(f);

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n').map((f) => f.trim()).filter(Boolean);

const offenders = files.filter((f) => {
  if (ALLOWED(f)) return false;
  try { return readFileSync(f, 'utf8').includes(owner); } catch { return false; }
});

if (offenders.length) {
  console.error(`The owner "${owner}" is hardcoded outside extensions.config.json:\n` +
    offenders.map((f) => '  - ' + f).join('\n') +
    '\n\nDerive it through scripts/generate.mjs instead.');
  process.exit(1);
}
console.log(`Owner is centralised (checked ${files.length} files).`);
