import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import type { ExtensionContext, RankedCandidate, RerankCandidate, Reranker } from './types.js';
import { cosine, loadProjector, norm, project, type Projector } from './projector.js';

/**
 * llama.cpp-backed reranker.
 *
 * Spawns `llama-server` as an EMBEDDING server with pooling disabled, and
 * scores through jina-reranker-v3.5's actual listwise protocol.
 *
 * NOT `--reranking`. v3.5 has no ranking head, so `--reranking` makes llama.cpp
 * force RANK pooling onto it anyway — the server announces this on startup:
 *
 *     model default pooling_type is [-1], but [4] was specified
 *
 * and then serves /v1/rerank happily. Every response is complete, finite and
 * well-formed; nothing downstream can tell. The rankings are just meaningless.
 * MEASURED over ten queries with known answers, against a pool an embedding
 * model had already ordered: the right passage came first 1 time in 10, mean
 * rank 5.4, where doing NOTHING scored 0.3.
 *
 * The real protocol is listwise. Query and every passage go through in ONE
 * pass; each passage carries an `<|embed_token|>` and the query an
 * `<|rerank_token|>`, and the score is the cosine between the projected hidden
 * states at those positions. `--embedding --pooling none` is what makes those
 * per-position states readable: /embedding then returns one row per token
 * instead of a single pooled vector, and /tokenize gives the positions to read.
 *
 * Jina's own README says this needs a forked llama.cpp. Two of the three
 * patches it names are about their Python driver rather than the model — what
 * `--output-token-ids` exposes is exactly what `--pooling none` already gives
 * here, and the published `modeling.py` subclasses `Qwen3ForCausalLM` without
 * overriding the mask, so the non-causal mode is not needed either. Needs `process.spawn` and `network.localhost`; both
 * are declared in extension.json and enforced by Natively's broker, so reaching
 * for anything undeclared is a loud error rather than silent capability use.
 *
 * v1 does NOT vendor or download llama.cpp. The binary is found on PATH or at a
 * configured path and the user is prompted if it is missing — shipping a
 * third-party native binary is a signing, notarisation and auto-update problem
 * an extension should not quietly take on.
 */
const READY_TIMEOUT_MS = 60_000;

/** `<|embed_token|>` — one per passage. */
const DOC_TOKEN = '<|embed_token|>';
const DOC_TOKEN_ID = 151670;
/** `<|rerank_token|>` — one per block, on the query. */
const QUERY_TOKEN = '<|rerank_token|>';
const QUERY_TOKEN_ID = 151671;

const SYSTEM_PREFIX =
  '<|im_start|>system\n'
  + 'You are a search relevance expert who can determine a ranking of the passages based on how relevant they are to the query. '
  + 'If the query is a question, how relevant a passage is depends on how well it answers the question. '
  + 'If not, try to analyze the intent of the query and assess how well each passage satisfies the intent. '
  + 'If an instruction is provided, you should follow the instruction when determining the ranking.'
  + '<|im_end|>\n<|im_start|>user\n';

const ASSISTANT_SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n';

export class JinaReranker implements Reranker {
  readonly id = 'jina-reranker-v35';
  readonly name = 'Jina Reranker v3.5';

  private server: ChildProcess | null = null;
  private port = 0;
  private ready = false;
  private projector: Projector | null = null;
  /**
   * Tokens per block.
   *
   * The GGUF declares a 1024-token sliding window over 16 of its 28 layers and
   * llama.cpp discards it, so a prompt under 1024 tokens is scored exactly
   * right. Packing to 1024 to get that is nonetheless WRONG: a listwise score
   * depends on which other passages share the block, and starving that costs
   * more than the discarded window does. Measured against the published model,
   * mean Kendall tau was 0.79 at a 1024 budget against 0.94 at 2048 and above.
   */
  private blockBudget = 4096;

  async init(ctx: ExtensionContext): Promise<void> {
    const modelPath = join(ctx.modelDir, 'jina-reranker-v3.5-Q4_K_M.gguf');
    const projectorPath = join(ctx.modelDir, 'projector.safetensors');
    const binary = typeof ctx.config.llamaServerPath === 'string' && ctx.config.llamaServerPath
      ? ctx.config.llamaServerPath
      : 'llama-server';

    // Load the head BEFORE spawning anything: a missing or malformed projector
    // means this extension can never produce a score, and finding that out
    // after a 400MB model is resident wastes the memory and the wait.
    this.projector = loadProjector(projectorPath);

    if (typeof ctx.config.blockBudget === 'number' && ctx.config.blockBudget >= 2048) {
      this.blockBudget = ctx.config.blockBudget;
    }
    this.port = 20000 + Math.floor(Math.random() * 20000);

    // Arguments go as an ARRAY and are never interpolated into a shell, so a
    // model directory containing spaces or unicode is handled by the OS rather
    // than by quoting rules that differ between macOS and Windows.
    const args = [
      '--model', modelPath,
      // The two that make per-position hidden states readable. See the class
      // comment for why this is not --reranking.
      '--embedding',
      '--pooling', 'none',
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--ctx-size', String(this.blockBudget),
      // Non-causal attention needs the whole block in one ubatch, and llama.cpp
      // asserts on this rather than degrading.
      '--ubatch-size', String(this.blockBudget),
      '--batch-size', String(this.blockBudget),
      '--threads', String(ctx.config.threads ?? 4),
      '--no-webui',
    ];

    ctx.logger.info(`starting ${binary} on 127.0.0.1:${this.port}`);
    this.server = spawn(binary, args, { stdio: 'ignore' });
    this.server.on('error', (e: Error) => ctx.logger.error(`could not start ${binary}: ${e.message}`));

    await this.waitForServer(ctx);
    this.ready = true;
  }

  private async waitForServer(ctx: ExtensionContext): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last = 'never responded';
    while (Date.now() < deadline) {
      if (this.server && this.server.exitCode !== null) {
        throw new Error(
          `llama-server exited with code ${this.server.exitCode} before becoming ready. ` +
          'Is the binary present and the model downloaded?');
      }
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (r.ok) { ctx.logger.info('llama-server is ready'); return; }
        last = `health returned ${r.status}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`llama-server did not become ready within ${READY_TIMEOUT_MS}ms (${last})`);
  }

  /**
   * The listwise prompt, byte-for-byte as the reference builds it
   * (`format_docs_prompts_func` in jinaai/jina-reranker-v3.5's modeling.py).
   *
   * The empty `<think>` block is `no_thinking=True` there: Qwen3 emits a
   * reasoning block unless one is already closed for it. Nothing is generated
   * here — only hidden states are read — but the prompt must still match what
   * the model was trained on, token for token.
   *
   * NOT the prompt in the GGUF repo's `rerank.py`, which adds an extra EARLY
   * rerank token and a trailing ranking instruction for a variant the published
   * weights do not match.
   */
  private buildPrompt(query: string, docs: string[]): string {
    const clean = (t: string) => t.split(DOC_TOKEN).join('').split(QUERY_TOKEN).join('');
    const q = clean(query);
    const body =
      `I will provide you with ${docs.length} passages, each indicated by a numerical identifier. `
      + `Rank the passages based on their relevance to query: ${q}\n`
      + docs.map((d, i) => `<passage id="${i}">\n${clean(d)}${DOC_TOKEN}\n</passage>`).join('\n') + '\n'
      + `<query>\n${q}${QUERY_TOKEN}\n</query>`;
    return SYSTEM_PREFIX + body + ASSISTANT_SUFFIX;
  }

  private async tokenize(text: string, signal: AbortSignal): Promise<number[]> {
    const res = await fetch(`http://127.0.0.1:${this.port}/tokenize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`/tokenize failed: ${res.status}`);
    const { tokens } = await res.json() as { tokens?: number[] };
    if (!Array.isArray(tokens)) throw new Error('/tokenize returned no tokens');
    return tokens;
  }

  /**
   * Per-token hidden states for one block, projected.
   *
   * `/embedding` with pooling disabled returns one row per token, in order, so
   * the rows at the control-token positions ARE the states the protocol wants.
   * The count is checked rather than assumed: a tokenizer that did not
   * recognise `<|embed_token|>` would split it into ordinary text and every
   * position read here would be the wrong one — which produces perfectly
   * ordinary-looking cosines, never an error.
   */
  private async embedBlock(docs: string[], query: string, signal: AbortSignal): Promise<{
    docs: Float32Array[]; query: Float32Array;
  }> {
    const prompt = this.buildPrompt(query, docs);
    const tokens = await this.tokenize(prompt, signal);

    const wanted: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === DOC_TOKEN_ID || tokens[i] === QUERY_TOKEN_ID) wanted.push(i);
    }
    if (wanted.length !== docs.length + 1 || tokens[wanted[wanted.length - 1]] !== QUERY_TOKEN_ID) {
      throw new Error(
        `expected ${docs.length + 1} control-token positions ending in the query token, `
        + `found ${wanted.length} — the tokenizer did not recognise <|embed_token|>/<|rerank_token|>`);
    }

    const res = await fetch(`http://127.0.0.1:${this.port}/embedding`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ content: prompt }),
    });
    if (!res.ok) throw new Error(`/embedding failed: ${res.status}`);
    const payload = await res.json() as Array<{ embedding?: number[][] }> | { embedding?: number[][] };
    const rows = (Array.isArray(payload) ? payload[0] : payload)?.embedding;
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) {
      throw new Error('/embedding returned a pooled vector — the server is not running with --pooling none');
    }
    if (rows.length !== tokens.length) {
      throw new Error(`/embedding returned ${rows.length} rows for ${tokens.length} tokens`);
    }

    const p = this.projector!;
    return {
      docs: wanted.slice(0, -1).map(i => project(p, rows[i])),
      query: project(p, rows[wanted[wanted.length - 1]]),
    };
  }

  /** Greedy packing, re-measured: the header names the passage COUNT, so a
   *  block's length is not the sum of its documents' and cannot be added up. */
  private async planBlocks(query: string, docs: string[], signal: AbortSignal): Promise<number[][]> {
    const blocks: number[][] = [];
    let start = 0;
    while (start < docs.length) {
      let end = start + 1;
      while (end < docs.length) {
        const next = docs.slice(start, end + 1);
        const len = (await this.tokenize(this.buildPrompt(query, next), signal)).length;
        if (len > this.blockBudget) break;
        end += 1;
      }
      const idx: number[] = [];
      for (let i = start; i < end; i++) idx.push(i);
      blocks.push(idx);
      start = end;
    }
    return blocks;
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    opts: { topK: number; signal: AbortSignal },
  ): Promise<RankedCandidate[]> {
    if (!this.ready || !this.server || !this.projector) throw new Error('rerank() called before init()');
    if (candidates.length === 0) return [];
    if (opts.signal.aborted) throw new Error('rerank aborted');

    const texts = candidates.map(c => c.text);
    const blocks = await this.planBlocks(query, texts, opts.signal);

    const embedded: Array<{ docs: Float32Array[]; query: Float32Array; indices: number[] }> = [];
    for (const indices of blocks) {
      if (opts.signal.aborted) throw new Error('rerank aborted');
      const out = await this.embedBlock(indices.map(i => texts[i]), query, opts.signal);
      embedded.push({ ...out, indices });
    }

    // Fuse the per-block query vectors, weighted by each block's best match,
    // then score every passage against the result — the reference's rerank()
    // tail. The (1+cos)/2 mapping matters: np.average rejects negative weights,
    // and a block of purely irrelevant passages would otherwise pull the fused
    // vector the wrong way.
    const weights = embedded.map(b => {
      const qn = norm(b.query);
      let best = -Infinity;
      for (const d of b.docs) best = Math.max(best, cosine(d, b.query, qn));
      return (1 + best) / 2;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const fused = new Float32Array(embedded[0].query.length);
    for (let i = 0; i < embedded.length; i++) {
      const w = total > 0 ? weights[i] / total : 1 / embedded.length;
      for (let k = 0; k < fused.length; k++) fused[k] += w * embedded[i].query[k];
    }
    const fusedNorm = norm(fused);

    const scored: Array<{ id: string; score: number }> = new Array(candidates.length);
    for (const b of embedded) {
      for (let i = 0; i < b.docs.length; i++) {
        const at = b.indices[i];
        scored[at] = { id: candidates[at].id, score: cosine(b.docs[i], fused, fusedNorm) };
      }
    }
    // Natively rejects an INCOMPLETE ranking wholesale, so a hole here would
    // sink that candidate below every candidate the reranker never saw.
    if (scored.some(e => !e || !Number.isFinite(e.score))) {
      throw new Error('some candidates were never scored — refusing a partial ranking');
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .map((e, i) => ({ id: e.id, score: e.score, rank: i + 1 }));
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.ready = false;
    if (!server) return;
    // Guard on pid: killing a ChildProcess whose spawn FAILED signals the
    // CURRENT PROCESS GROUP on macOS, which would take the host down with it.
    if (server.pid) { try { server.kill(); } catch { /* already gone */ } }
  }
}

export default JinaReranker;
