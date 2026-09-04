#!/usr/bin/env node
/** Validates registry.json. Metadata only: no code and no weights live here. */
import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync('registry.json', 'utf8'));
const problems = [];
if (registry.version !== 1) problems.push('version must be 1');
if (!Array.isArray(registry.extensions)) problems.push('extensions must be an array');

const seen = new Set();
for (const e of registry.extensions ?? []) {
  const where = `entry "${e.id ?? '(no id)'}"`;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(e.id ?? '')) problems.push(`${where}: invalid id`);
  if (seen.has(e.id)) problems.push(`${where}: duplicate id`);
  seen.add(e.id);
  if (!/^[^/]+\/[^/]+$/.test(e.repo ?? '')) problems.push(`${where}: repo must be "owner/name"`);
  if (e.apiVersion !== '1') problems.push(`${where}: unsupported apiVersion ${e.apiVersion}`);
  if (!Array.isArray(e.modelLicenses) || e.modelLicenses.length === 0) {
    problems.push(`${where}: modelLicenses must be a non-empty array`);
  }
}
if (problems.length) {
  console.error('registry.json is INVALID:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`registry.json is valid (${registry.extensions.length} extensions).`);
