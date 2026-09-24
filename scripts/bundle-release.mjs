#!/usr/bin/env node
/**
 * Produce the artifacts a Natively install can actually consume.
 *
 * Natively refuses an extension whose entrypoint is not built, and `dist/` is
 * never committed — so a clone of this repository is not installable and a
 * repository tarball would not be either. A release has to carry BUILT code.
 *
 * Each bundleable package becomes exactly two files:
 *
 *   <id>-<version>.js    one self-contained ESM module
 *   <id>-<version>.json  its extension.json, entrypoint rewritten
 *
 * Two files rather than an archive, on purpose: Natively can write them
 * straight into a staging directory as dist/index.js + extension.json and let
 * its existing installer and trust prompt run unchanged. No tar parser, no new
 * dependency, and no archive-extraction path to get path traversal wrong.
 *
 * WHAT IS EXCLUDED, and why. A package with runtime dependencies is not
 * published here. ettin-reranker needs onnxruntime-node, a NATIVE addon: a
 * bundle built on one CI runner would carry one platform's .node binary and
 * break the other operating system. Natively ships Ettin itself, so nothing is
 * lost. `bundleable` is computed from the package's own dependencies rather
 * than a hardcoded list, so adding a dependency automatically removes a package
 * from releases instead of shipping something broken.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build');

const config = JSON.parse(readFileSync(path.join(root, 'extensions.config.json'), 'utf8'));
const { owner, repo } = config;
if (!owner || owner === 'REPLACE_ME') {
  throw new Error('owner is unset — run: npm run set-owner -- <github-account>');
}

/** Tag drives the download URLs. CI passes the real one. */
const tag = process.env.RELEASE_TAG || process.argv[2] || 'v0.0.0-dev';

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const packages = readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();

const entries = [];
const skipped = [];

for (const pkg of packages) {
  const dir = path.join(root, 'packages', pkg);
  const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const deps = Object.keys(pkgJson.dependencies ?? {});
  const manifest = JSON.parse(readFileSync(path.join(dir, 'extension.json'), 'utf8'));

  if (deps.length > 0) {
    skipped.push(`${pkg} (runtime dependencies: ${deps.join(', ')})`);
    continue;
  }

  const entryPoint = path.join(dir, manifest.entrypoint);
  try { statSync(entryPoint); } catch {
    throw new Error(`${pkg}: ${manifest.entrypoint} is missing — run \`npm run build\` first`);
  }

  const jsName = `${manifest.id}-${manifest.version}.js`;
  const jsonName = `${manifest.id}-${manifest.version}.json`;

  await build({
    entryPoints: [entryPoint],
    outfile: path.join(outDir, jsName),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    // Node built-ins stay external; everything of the package's own is inlined.
    packages: 'bundle',
    legalComments: 'inline',
    banner: { js: `// ${manifest.name} ${manifest.version} — MIT adapter code. No model weights.` },
  });

  // The published manifest points at the single file Natively will write.
  writeFileSync(
    path.join(outDir, jsonName),
    JSON.stringify({ ...manifest, entrypoint: 'dist/index.js' }, null, 2) + '\n',
  );

  const sha = (f) => createHash('sha256').update(readFileSync(path.join(outDir, f))).digest('hex');
  const size = (f) => statSync(path.join(outDir, f)).size;
  const base = `https://github.com/${owner}/${repo}/releases/download/${tag}`;

  entries.push({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    category: manifest.type,
    repo: `${owner}/${repo}`,
    path: `packages/${pkg}`,
    modelLicenses: [...new Set((manifest.models ?? []).map((m) => m.license.spdx))].sort(),
    // Natively requires an external runtime for these; the UI must say so
    // rather than letting an install look ready when llama-server is absent.
    requiresExternalRuntime: (manifest.allowedBinaries ?? []).length > 0
      ? manifest.allowedBinaries
      : undefined,
    download: {
      code: `${base}/${jsName}`,
      manifest: `${base}/${jsonName}`,
      sha256: { code: sha(jsName), manifest: sha(jsonName) },
      bytes: { code: size(jsName), manifest: size(jsonName) },
    },
  });

  console.log(`  bundled ${pkg} -> ${jsName} (${(size(jsName) / 1024).toFixed(1)} KB)`);
}

if (entries.length === 0) throw new Error('nothing bundleable — refusing to publish an empty release');

writeFileSync(
  path.join(outDir, 'registry.json'),
  JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    tag,
    // A sha256 published alongside the artefact proves INTEGRITY, not
    // authenticity: it catches a truncated or corrupted download, not a
    // compromised repository. Natively's install prompt is what stands between
    // the user and code they did not write.
    extensions: entries,
  }, null, 2) + '\n',
);

console.log(`  registry.json: ${entries.length} installable extension(s), tag ${tag}`);
for (const s of skipped) console.log(`  skipped ${s}`);
