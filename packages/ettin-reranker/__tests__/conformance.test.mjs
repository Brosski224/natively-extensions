/**
 * Shared conformance test.
 *
 * Verifies the adapter satisfies Natively's Reranker contract WITHOUT
 * downloading weights: the contract is structural, and CI must never pull
 * hundreds of megabytes. It imports the BUILT adapter, so `entrypoint` in
 * extension.json is checked to actually exist and load.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve against THIS package, not the working directory. In a monorepo the
// suite runs from the repository root, where a bare 'extension.json' does not
// exist; anchoring on import.meta.url works from either location.
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


const manifest = JSON.parse(readFileSync(path.join(pkgRoot, 'extension.json'), 'utf8'));
const mod = await import('../dist/index.js');
const Adapter = mod.default;

const make = () => (typeof Adapter === 'function' ? new Adapter() : Adapter);

test('the manifest entrypoint exists after a build', () => {
  assert.equal(existsSync(path.join(pkgRoot, manifest.entrypoint)), true,
    `${manifest.entrypoint} is declared in extension.json but was not built`);
});

test('the default export is a Reranker', () => {
  const it = make();
  assert.equal(typeof it.id, 'string');
  assert.equal(typeof it.name, 'string');
  for (const m of ['init', 'rerank', 'dispose']) {
    assert.equal(typeof it[m], 'function', `missing ${m}()`);
  }
});

test('the adapter id matches the manifest id', () => {
  assert.equal(make().id, manifest.id);
});

test('rerank() rejects rather than hanging when init() has not run', async () => {
  await assert.rejects(
    () => make().rerank('q', [{ id: '0', text: 'a' }],
      { topK: 1, signal: new AbortController().signal }),
    /init/i,
  );
});

test('dispose() is safe before init()', async () => {
  await make().dispose();
});

test('the manifest declares only permissions from the closed set', () => {
  const CLOSED = ['filesystem.models', 'filesystem.workspace',
                  'network.localhost', 'network.remote', 'process.spawn'];
  for (const p of manifest.permissions) {
    assert.ok(CLOSED.includes(p), `unknown permission "${p}"`);
  }
  if (manifest.permissions.includes('process.spawn')) {
    assert.ok(manifest.allowedBinaries?.length, 'process.spawn requires allowedBinaries');
  }
  if (manifest.permissions.includes('network.remote')) {
    assert.ok(manifest.allowedHosts?.length, 'network.remote requires allowedHosts');
  }
});

test('every model has a resolved repo, a licence, and a bare local filename', () => {
  assert.ok(manifest.models.length > 0);
  for (const m of manifest.models) {
    assert.ok(m.repo, `model "${m.key}" has an unresolved repo id`);
    assert.ok(m.license?.spdx, `model "${m.key}" has no licence`);
    assert.doesNotMatch(m.file, /[\\/]/, `model "${m.key}" file must be a bare filename`);
    if (m.repoPath) {
      assert.doesNotMatch(m.repoPath, /^\/|\.\./, `model "${m.key}" repoPath must be relative`);
    }
  }
});

test('a non-redistributable model requires acknowledgement', () => {
  // Natively refuses to load a requiresAcknowledgement model with no ledger
  // entry. A manifest that marks a model non-redistributable but skips the
  // acknowledgement gate would download it without ever showing the licence.
  for (const m of manifest.models) {
    if (m.license.redistributable === false) {
      assert.equal(m.license.requiresAcknowledgement, true,
        `model "${m.key}" is non-redistributable and must require acknowledgement`);
    }
  }
});
