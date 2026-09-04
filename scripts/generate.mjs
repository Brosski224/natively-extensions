#!/usr/bin/env node
/**
 * Generates every file that names the GitHub owner.
 *
 * Source of truth: extensions.config.json. Derived here:
 *   - packages/<pkg>/extension.json   (homepage)
 *   - packages/<pkg>/README.md        (install block)
 *   - registry.json                   (one entry per extension)
 *
 * `npm run check:generated` fails CI when any of these drifts.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const config = JSON.parse(readFileSync('extensions.config.json', 'utf8'));
const { owner, repo } = config;
if (!owner || !repo) throw new Error('extensions.config.json needs "owner" and "repo"');
if (owner === 'REPLACE_ME') {
  // Fail loudly rather than emit URLs that 404. This is the same rule the
  // manifests use for an unresolved model repo: never ship a guess.
  throw new Error('owner is still REPLACE_ME — run: npm run set-owner -- <github-account>');
}

const repoBase = `https://github.com/${owner}/${repo}`;
const MANIFEST_KEYS = ['id','name','version','apiVersion','type','entrypoint','author','homepage',
                       'engines','permissions','allowedHosts','allowedBinaries','models','config'];

const BEGIN = '<!-- BEGIN GENERATED: do not edit by hand, run `npm run generate` -->';
const END = '<!-- END GENERATED -->';

const packages = readdirSync('packages', { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();

const entries = [];

for (const pkg of packages) {
  const dir = path.join('packages', pkg);
  const base = JSON.parse(readFileSync(path.join(dir, 'manifest.base.json'), 'utf8'));
  const manifest = { ...base, homepage: repoBase };

  const ordered = {};
  for (const key of MANIFEST_KEYS) if (manifest[key] !== undefined) ordered[key] = manifest[key];
  writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(ordered, null, 2) + '\n');

  // The install steps describe what Natively actually supports: there is no
  // `natively` CLI, and the installer refuses an extension whose entrypoint has
  // not been built, so the build step is required rather than advisory.
  const block = [
    BEGIN, '',
    '```bash',
    `git clone ${repoBase}.git`,
    `cd ${repo}`,
    'npm install && npm run build',
    '```',
    '',
    'Then in Natively: **Settings → Reranker → Install from folder**, and choose',
    '`packages/' + pkg + '` inside the directory you just cloned.',
    '',
    `Repository: ${repoBase}`,
    '', END,
  ].join('\n');

  const readmePath = path.join(dir, 'README.md');
  let readme = readFileSync(readmePath, 'utf8');
  const start = readme.indexOf(BEGIN), end = readme.indexOf(END);
  if (start === -1 || end === -1) throw new Error(`${readmePath} is missing its generated block markers`);
  writeFileSync(readmePath, readme.slice(0, start) + block + readme.slice(end + END.length));

  entries.push({
    id: manifest.id,
    repo: `${owner}/${repo}`,
    path: `packages/${pkg}`,
    latestVersion: manifest.version,
    apiVersion: manifest.apiVersion,
    category: manifest.type,
    modelLicenses: [...new Set((manifest.models ?? []).map((m) => m.license.spdx))].sort(),
  });
}

writeFileSync('registry.json', JSON.stringify(
  { version: 1, updatedAt: new Date().toISOString().slice(0, 10), extensions: entries }, null, 2) + '\n');

console.log(`Generated ${packages.length} manifests, ${packages.length} README blocks and registry.json for ${owner}/${repo}`);
