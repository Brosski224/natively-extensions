/**
 * The protocol, which is the thing that was wrong.
 *
 * This extension shipped spawning `llama-server --reranking`. That endpoint
 * answers — completely, finitely, with unique indices — for a model that has no
 * ranking head, because llama.cpp forces RANK pooling when asked. Every
 * structural check the conformance suite makes passed, and the rankings were
 * nonsense: MEASURED over ten queries with known answers, the right passage came
 * first 2 times in 10 against 9 in 10 after this fix, and doing nothing at all
 * scored better than the extension did.
 *
 * So the conformance suite cannot catch this class of bug and these assertions
 * exist alongside it. They are on the SOURCE because the alternative is
 * downloading 484 MB in CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve against THIS package, not the working directory. In a monorepo the
// suite runs from the repository root, where a bare 'extension.json' does not
// exist; anchoring on import.meta.url works from either location.
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


const raw = readFileSync(path.join(pkgRoot, 'src/Qwen3Reranker.ts'), 'utf8');

/**
 * CODE only. The comments explain at length why --reranking is wrong and name
 * /v1/rerank while doing it, so a naive scan of the whole file reports the
 * explanation as the bug. Stripping them is what makes "this string does not
 * appear" mean "this call is not made".
 */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the server is NEVER started in reranking mode', () => {
  // The exact failure: llama.cpp says "model default pooling_type is [-1], but
  // [4] was specified" and then serves meaningless scores.
  assert.doesNotMatch(src, /'--reranking'/,
    'Qwen3-Reranker has no ranking head; --reranking forces RANK pooling and the scores mean nothing');
  assert.doesNotMatch(src, /\/v1\/rerank/,
    'the rerank endpoint is the one that cannot score this model');
});

test('scoring reads the next-token distribution, which is this model\'s protocol', () => {
  assert.match(src, /\/completion/, 'the yes/no answer comes from a completion');
  assert.match(src, /n_predict:\s*1/, 'exactly one token is needed');
  assert.match(src, /n_probs:/, 'the score is a probability, not the sampled token');
  assert.match(src, /top_logprobs/, 'llama-server returns logprobs, which need exp()');
  assert.match(src, /pYes \/ \(pYes \+ pNo\)|pYes\s*\/\s*total/,
    'the score is P(yes) against P(no), which cancels the vocabulary normaliser');
});

test('yes and no are resolved to TOKEN IDS, not matched as strings', () => {
  // A vocabulary where the piece carries a leading space or different case
  // would silently score every document 0.5.
  assert.match(src, /\/tokenize/);
  assert.match(src, /t\.id === this\.yesToken/);
  assert.match(src, /t\.id === this\.noToken/);
});

test('the prompt keeps the empty think block', () => {
  // Qwen3 emits a reasoning block unless one is already closed for it, and
  // without this the next token is not the yes/no answer at all.
  assert.match(src, /<think>\\n\\n<\/think>/);
  assert.match(src, /the answer can only be/, "Qwen's own system turn, from the model card");
});

test('the prompt cache is disabled between documents', () => {
  // Each document is a separate question. A cached prefix answers the previous
  // one, and the score still looks perfectly reasonable.
  assert.match(src, /cache_prompt:\s*false/);
});

test('one unscorable document fails the whole call', () => {
  // Natively rejects a partial ranking wholesale, so a hole would sink that
  // candidate below every candidate the reranker never saw.
  assert.match(src, /refusing|throw new Error\('the model put no probability/);
});
