import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import type { ExtensionContext, RankedCandidate, RerankCandidate, Reranker } from './types.js';

/**
 * llama.cpp-backed reranker.
 *
 * Spawns `llama-server` on a random loopback port. Needs `process.spawn` and
 * `network.localhost`; both are declared in extension.json and enforced by
 * Natively's broker, so reaching for anything undeclared is a loud error rather
 * than silent capability use.
 *
 * NOT `--reranking`, and this is the whole point of the file.
 *
 * Qwen3-Reranker has NO ranking head. `--reranking` makes llama.cpp force RANK
 * pooling onto it anyway — the server says so on startup:
 *
 *     model default pooling_type is [-1], but [4] was specified
 *
 * and then serves /v1/rerank happily. Every response is complete, finite and
 * well-formed, so nothing downstream can tell anything is wrong. The rankings
 * are simply meaningless. MEASURED over ten queries with known answers, against
 * a candidate pool an embedding model had already ordered: the correct passage
 * came first 2 times out of 10, mean rank 5.4, where doing NOTHING scored 0.3.
 * An enabled reranker that is worse than no reranker, reporting perfect health.
 *
 * The real protocol is the one on Qwen's model card: this is a causal LM asked
 * a yes/no question, and the score is how much probability sits on "yes" versus
 * "no" at the very next token. So the server runs as an ordinary completion
 * server and /completion is asked for one token with its top logprobs.
 *
 * v1 does NOT vendor or download llama.cpp. The binary is found on PATH or at a
 * configured path and the user is prompted if it is missing — shipping a
 * third-party native binary is a signing, notarisation and auto-update problem
 * an extension should not quietly take on.
 */
const READY_TIMEOUT_MS = 60_000;

/** Qwen's default retrieval instruction, from the model card. */
const DEFAULT_INSTRUCTION = 'Given a web search query, retrieve relevant passages that answer the query';

export class Qwen3Reranker implements Reranker {
  readonly id = 'qwen3-reranker';
  readonly name = 'Qwen3 Reranker 0.6B';

  private server: ChildProcess | null = null;
  private port = 0;
  private ready = false;
  private yesToken = -1;
  private noToken = -1;
  /** Overridable per install; the model card's default otherwise. */
  private instruction: string | undefined;

  async init(ctx: ExtensionContext): Promise<void> {
    const modelPath = join(ctx.modelDir, 'Qwen3-Reranker-0.6B.Q4_K_M.gguf');
    const binary = typeof ctx.config.llamaServerPath === 'string' && ctx.config.llamaServerPath
      ? ctx.config.llamaServerPath
      : 'llama-server';

    this.port = 20000 + Math.floor(Math.random() * 20000);
    this.instruction = typeof ctx.config.instruction === 'string' ? ctx.config.instruction : undefined;

    // Arguments go as an ARRAY and are never interpolated into a shell, so a
    // model directory containing spaces or unicode is handled by the OS rather
    // than by quoting rules that differ between macOS and Windows.
    //
    // No --reranking: see the class comment. A plain completion server is what
    // this model's actual protocol needs.
    const args = [
      '--model', modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--ctx-size', String(ctx.config.contextSize ?? 4096),
      '--threads', String(ctx.config.threads ?? 4),
      // Nothing here serves a browser, and the bundled UI is a needless surface
      // on a loopback port this extension opens.
      '--no-webui',
    ];

    ctx.logger.info(`starting ${binary} on 127.0.0.1:${this.port}`);
    this.server = spawn(binary, args, { stdio: 'ignore' });
    this.server.on('error', (e: Error) => ctx.logger.error(`could not start ${binary}: ${e.message}`));

    await this.waitForServer(ctx);
    // Resolve "yes"/"no" to token ids ONCE, through the server's own tokenizer.
    // Matching on the returned token STRING instead would be wrong in a
    // vocabulary where the piece carries a leading space or different case, and
    // it would fail silently as a 0.5 tie.
    this.yesToken = await this.singleToken(ctx, 'yes');
    this.noToken = await this.singleToken(ctx, 'no');
    this.ready = true;
  }

  /**
   * The single token id for a word, via /tokenize.
   *
   * Refuses a multi-token result rather than taking the first piece: if "yes"
   * is not one token in this vocabulary then the whole protocol is wrong for
   * this model, and a plausible number would be worse than an error.
   */
  private async singleToken(ctx: ExtensionContext, word: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${this.port}/tokenize`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: word }),
    });
    if (!res.ok) throw new Error(`/tokenize failed: ${res.status}`);
    const { tokens } = await res.json() as { tokens?: number[] };
    if (!Array.isArray(tokens) || tokens.length !== 1) {
      throw new Error(`"${word}" is not a single token in this model's vocabulary (got ${tokens?.length})`);
    }
    ctx.logger.debug(`"${word}" -> token ${tokens[0]}`);
    return tokens[0];
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
   * Qwen's own prompt template, from the model card.
   *
   * The empty `<think>` block is load-bearing: Qwen3 emits a reasoning block
   * unless one is already closed for it, and without this the very next token
   * is not the yes/no answer at all. Nothing is generated here beyond that one
   * token — only its probability is read.
   */
  private buildPrompt(query: string, document: string, instruction: string): string {
    return '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query '
      + 'and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n'
      + '<|im_start|>user\n'
      + `<Instruct>: ${instruction}\n<Query>: ${query}\n<Document>: ${document}`
      + '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n';
  }

  /**
   * P(yes) against P(no) at the next token.
   *
   * Equivalent to the reference's `softmax([logit_no, logit_yes])[1]`: the
   * full-vocabulary normaliser Z divides both terms and cancels in the ratio,
   * which is what lets this run against an API that exposes probabilities
   * rather than raw logits.
   *
   * Returns null when NEITHER token carries mass — the prompt did not reach the
   * model in the shape it expects, and a fabricated 0.5 would be
   * indistinguishable from a genuine tie.
   */
  private async score(query: string, document: string, instruction: string, signal: AbortSignal): Promise<number | null> {
    const res = await fetch(`http://127.0.0.1:${this.port}/completion`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({
        prompt: this.buildPrompt(query, document, instruction),
        n_predict: 1,
        // Wide enough that both answers appear even when the model is confident
        // and the runner-up sits well down the list.
        n_probs: 40,
        temperature: 0,
        // Each document is scored independently; a cached prefix from the
        // previous document would answer the previous question.
        cache_prompt: false,
      }),
    });
    if (!res.ok) throw new Error(`llama-server completion failed: ${res.status}`);

    const payload = await res.json() as {
      completion_probabilities?: Array<{ top_logprobs?: Array<{ id: number; logprob: number }> }>;
    };
    const top = payload.completion_probabilities?.[0]?.top_logprobs;
    if (!Array.isArray(top)) return null;

    let pYes = 0, pNo = 0;
    for (const t of top) {
      if (t.id === this.yesToken) pYes = Math.exp(t.logprob);
      else if (t.id === this.noToken) pNo = Math.exp(t.logprob);
    }
    const total = pYes + pNo;
    return total > 0 ? pYes / total : null;
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    opts: { topK: number; signal: AbortSignal },
  ): Promise<RankedCandidate[]> {
    if (!this.ready || !this.server) throw new Error('rerank() called before init()');
    if (candidates.length === 0) return [];
    if (opts.signal.aborted) throw new Error('rerank aborted');

    const instruction = typeof this.instruction === 'string' && this.instruction
      ? this.instruction
      : DEFAULT_INSTRUCTION;

    // One full forward pass per candidate, sequentially. That is what this
    // protocol costs — there is no batch form of "what is the next token" —
    // and issuing them concurrently against one server slot only queues them.
    const scored: Array<{ id: string; score: number }> = [];
    for (const c of candidates) {
      if (opts.signal.aborted) throw new Error('rerank aborted');
      const score = await this.score(query, c.text, instruction, opts.signal);
      // Natively rejects an INCOMPLETE ranking wholesale, because an unscored
      // candidate sinks to -Infinity in the host's ordering. One unscorable
      // document therefore invalidates the whole call, and saying so is better
      // than returning a ranking with a hole in it.
      if (score === null) {
        throw new Error('the model put no probability on either "yes" or "no" — '
          + 'the prompt did not reach it in the expected shape');
      }
      scored.push({ id: c.id, score });
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

export default Qwen3Reranker;
