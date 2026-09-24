/**
 * The release bundler must publish only what Natively can actually install.
 *
 * Natively refuses an extension whose entrypoint is not built, and `dist/` is
 * never committed — so a release is the ONLY installable form of this
 * repository. These pin the two rules that make a release safe:
 *
 *  1. A package with runtime dependencies is excluded. ettin-reranker needs
 *     onnxruntime-node, a NATIVE addon; a bundle built on one runner carries
 *     one platform's .node binary and breaks the other OS. The rule is derived
 *     from each package's own dependencies, so adding one silently removes that
 *     package from releases instead of shipping something broken.
 *  2. Every published artefact carries an https URL and a real sha256 of the
 *     bytes actually produced.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
let registry;

before(() => {
  // Run the real bundler. Asserting against a stale build/ would pass while the
  // bundler was broken, which is the failure this file exists to catch.
  execFileSync(process.execPath, ['scripts/bundle-release.mjs', 'v9.9.9-test'], {
    cwd: root, stdio: 'pipe',
  });
  registry = JSON.parse(readFileSync(path.join(buildDir, 'registry.json'), 'utf8'));
});

test('a package with runtime dependencies is not published', () => {
  const published = registry.extensions.map((e) => e.id);
  assert.ok(published.length > 0, 'a release with nothing in it is a broken release');

  for (const pkg of readdirSync(path.join(root, 'packages'))) {
    const deps = Object.keys(
      JSON.parse(readFileSync(path.join(root, 'packages', pkg, 'package.json'), 'utf8')).dependencies ?? {},
    );
    const id = JSON.parse(readFileSync(path.join(root, 'packages', pkg, 'extension.json'), 'utf8')).id;
    if (deps.length > 0) {
      assert.ok(!published.includes(id),
        `${pkg} has runtime dependencies (${deps.join(', ')}) and must not be published`);
    } else {
      assert.ok(published.includes(id), `${pkg} has no runtime dependencies and should be published`);
    }
  }
});

test('every entry has https downloads and a sha256 of the real bytes', () => {
  for (const e of registry.extensions) {
    for (const kind of ['code', 'manifest']) {
      const url = e.download[kind];
      assert.match(url, /^https:\/\//, `${e.id} ${kind} url must be https`);
      assert.match(e.download.sha256[kind], /^[a-f0-9]{64}$/, `${e.id} ${kind} sha256 malformed`);

      const file = path.join(buildDir, url.split('/').pop());
      assert.ok(existsSync(file), `${e.id}: ${path.basename(file)} was not produced`);
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
      assert.equal(actual, e.download.sha256[kind],
        `${e.id} ${kind}: recorded sha256 does not match the bytes produced`);
      assert.equal(readFileSync(file).length, e.download.bytes[kind], `${e.id} ${kind}: byte count wrong`);
    }
  }
});

test('the bundled code loads and satisfies the Reranker contract', async () => {
  for (const e of registry.extensions) {
    const file = path.join(buildDir, e.download.code.split('/').pop());
    const mod = await import(`file://${file}`);
    const Adapter = mod.default;
    const it = typeof Adapter === 'function' ? new Adapter() : Adapter;
    for (const m of ['init', 'rerank', 'dispose']) {
      assert.equal(typeof it[m], 'function', `${e.id} bundle is missing ${m}()`);
    }
    assert.equal(it.id, e.id, `${e.id}: bundle id disagrees with the registry`);
  }
});

test('the published manifest points at where Natively will write the code', () => {
  for (const e of registry.extensions) {
    const file = path.join(buildDir, e.download.manifest.split('/').pop());
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(manifest.entrypoint, 'dist/index.js');
    assert.equal(manifest.id, e.id);
  }
});

test('an extension needing an external binary says so', () => {
  // Qwen3 and Jina spawn llama-server, which is NOT bundled. The UI must be
  // able to say that rather than letting an install look ready.
  for (const e of registry.extensions) {
    const file = path.join(buildDir, e.download.manifest.split('/').pop());
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if ((manifest.allowedBinaries ?? []).length > 0) {
      assert.deepEqual(e.requiresExternalRuntime, manifest.allowedBinaries,
        `${e.id} declares allowedBinaries and the registry must surface them`);
    }
  }
});

test('the tag flows into every download URL', () => {
  assert.equal(registry.tag, 'v9.9.9-test');
  for (const e of registry.extensions) {
    assert.ok(e.download.code.includes('/v9.9.9-test/'),
      `${e.id}: download URL does not carry the release tag`);
  }
});
