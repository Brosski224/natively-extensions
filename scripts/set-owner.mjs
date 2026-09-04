#!/usr/bin/env node
/**
 * Point this repository at a GitHub account, in one command.
 *
 *   npm run set-owner -- my-github-account
 *
 * Writes `extensions.config.json` and regenerates every derived file. Nothing
 * else in the tree may name the owner — `verify-owner.mjs` fails CI if it does —
 * so an ownership transfer stays a one-line change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const owner = process.argv[2];
if (!owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
  console.error('Usage: npm run set-owner -- <github-account>\n' +
    'A GitHub account is 1-39 chars of alphanumerics and hyphens, not starting or ending with one.');
  process.exit(1);
}

const path = 'extensions.config.json';
const config = JSON.parse(readFileSync(path, 'utf8'));
const previous = config.owner;
config.owner = owner;
writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
console.log(`owner: ${previous} -> ${owner}`);

execFileSync(process.execPath, ['scripts/generate.mjs'], { stdio: 'inherit' });
