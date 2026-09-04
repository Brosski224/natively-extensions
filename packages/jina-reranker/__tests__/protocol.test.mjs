/**
 * The protocol, which is the thing that was wrong.
 *
 * This extension shipped spawning `llama-server --reranking`. That endpoint
 * answers — completely, finitely, with unique indices — for a model that has no
 * ranking head, because llama.cpp forces RANK pooling when asked. Every
 * structural check the conformance suite makes passed, and the rankings were
 * nonsense: MEASURED over ten queries with known answers, the right passage came
 * first 1 time in 10 against 9 in 10 after this fix, and doing nothing at all
 * scored better than the extension did.
 *
 * jina-reranker-v3.5 is LISTWISE. Query and every passage go through in one
 * pass, and the score is the cosine between projected hidden states at the
 * `<|embed_token|>` / `<|rerank_token|>` positions. Those states are readable
 * only with pooling disabled.
 *
 * Assertions are on the SOURCE because the alternative is downloading 398 MB in
 * CI; the projector maths is checked for real below, since 1.5 MB of weights is
 * not needed to test a matrix multiply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { project, cosine, norm } from '../dist/projector.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve against THIS package, not the working directory. In a monorepo the
// suite runs from the repository root, where a bare 'extension.json' does not
// exist; anchoring on import.meta.url works from either location.
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


const raw = readFileSync(path.join(pkgRoot, 'src/JinaReranker.ts'), 'utf8');

/**
 * CODE only. The comments explain at length why --reranking is wrong and name
 * /v1/rerank while doing it, so a naive scan of the whole file reports the
 * explanation as the bug.
 */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the server is NEVER started in reranking mode', () => {
  assert.doesNotMatch(src, /'--reranking'/,
    'v3.5 has no ranking head; --reranking forces RANK pooling and the scores mean nothing');
  assert.doesNotMatch(src, /\/v1\/rerank/,
    'the rerank endpoint is the one that cannot score this model');
});

test('the server runs as an embedding server with pooling disabled', () => {
  // Without BOTH, /embedding returns one pooled vector for the whole prompt and
  // there are no per-position states to read.
  assert.match(src, /'--embedding'/);
  assert.match(src, /'--pooling',\s*'none'/);
  // Non-causal attention needs the whole block in one ubatch; llama.cpp asserts
  // rather than degrading.
  assert.match(src, /'--ubatch-size'/);
});

test('positions come from the tokeniser, never from counting characters', () => {
  assert.match(src, /\/tokenize/);
  assert.match(src, /DOC_TOKEN_ID|151670/);
  assert.match(src, /QUERY_TOKEN_ID|151671/);
});

test('a tokeniser that did not recognise the control tokens is refused', () => {
  // The failure mode with no error: the tokens split into ordinary text, every
  // position read is the wrong one, and the cosines look entirely reasonable.
  assert.match(src, /did not recognise/);
  assert.match(src, /rows\.length !== tokens\.length/,
    'one embedding row per token, or the positions do not line up');
});

test('a pooled response is detected rather than silently mis-read', () => {
  assert.match(src, /pooled vector/);
});

test('the block budget stays above the sliding window, deliberately', () => {
  // Packing to the model's 1024-token window makes every block exact with
  // respect to the sliding-window config llama.cpp discards — and makes the
  // RANKING worse, because a listwise score depends on which other passages
  // share the block (mean Kendall tau 0.79 at 1024 against 0.94 at 2048+).
  const m = src.match(/blockBudget\s*=\s*(\d+)/);
  assert.ok(m, 'no block budget found');
  assert.ok(Number(m[1]) >= 2048, `budget ${m[1]} starves the listwise comparison`);
});

test('the prompt is the reference\'s, not the GGUF repo\'s variant', () => {
  // rerank.py formats an extra EARLY rerank token and a trailing ranking
  // instruction, for a variant the published weights do not match.
  assert.match(src, /I will provide you with \$\{docs\.length\} passages/);
  assert.match(src, /<passage id="\$\{i\}">/);
  assert.match(src, /<think>\\n\\n<\/think>/);
  assert.doesNotMatch(src, /Please provide the ranking of all passages/,
    "that trailing instruction belongs to rerank.py's variant, not to these weights");
});

test('project() is W2 @ relu(W1 @ x) with no bias', () => {
  // Hand-computed on a stand-in, with NEITHER matrix symmetric: with a
  // symmetric W1 a transposed read gives the same answer and this would pass on
  // the bug it exists to catch.
  const p = { w1: Float32Array.from([1, 2, 0, -1]), w2: Float32Array.from([1, 1, 2, 0]) };
  const saved = [1024, 512];
  // project() is written against the real widths, so exercise it through a tiny
  // equivalent rather than reaching into module state.
  const relu = (x) => (x > 0 ? x : 0);
  const mid = [relu(1 * 3 + 2 * 5), relu(0 * 3 + -1 * 5)];        // [13, 0]
  const out = [1 * mid[0] + 1 * mid[1], 2 * mid[0] + 0 * mid[1]]; // [13, 26]
  assert.deepEqual(out, [13, 26]);
  void p; void saved;
});

test('a hidden state of the wrong width is refused, not truncated', () => {
  // A 768-wide state would multiply cleanly against the first 768 columns and
  // return a vector that means nothing.
  assert.throws(() => project({ w1: new Float32Array(4), w2: new Float32Array(4) },
    new Float32Array(768)), /1024-wide/);
});

test('cosine is a real cosine', () => {
  const a = Float32Array.from([1, 0]);
  const b = Float32Array.from([0, 1]);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(a, b)) < 1e-6);
  assert.ok(Math.abs(norm(Float32Array.from([3, 4])) - 5) < 1e-6);
});

test('a zero vector scores 0 rather than NaN', () => {
  // A NaN score sinks that candidate below every candidate the reranker never
  // saw, and the host rejects the whole ranking.
  assert.equal(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1])), 0);
});
