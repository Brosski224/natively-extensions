import { readFileSync } from 'fs';
import { join } from 'path';
import type { ExtensionContext, RankedCandidate, RerankCandidate, Reranker } from './types.js';

/**
 * Ettin cross-encoder reranker (ONNX).
 *
 * The three sizes (32M / 68M / 150M) are ONE extension selected by the
 * `modelSize` config value, not three extensions — they differ only in which
 * weight file is loaded. Needs only `filesystem.models`: no network, no
 * subprocess.
 *
 * QUANTISATION: upstream also publishes architecture-specific INT8 exports
 * (model_qint8_arm64 / model_qint8_avx512). Those cannot be a single manifest
 * entry across macOS-arm64 and Windows-x64, so this adapter uses the portable
 * fp32 `onnx/model.onnx`. Per-architecture selection is a later change.
 */
const VALID_SIZES = ['32m', '68m', '150m'] as const;
type ModelSize = (typeof VALID_SIZES)[number];

export class EttinReranker implements Reranker {
  readonly id = 'ettin-reranker';
  readonly name = 'Ettin Reranker';

  private session: unknown = null;
  private tokenizer: unknown = null;
  private batchSize = 16;

  async init(ctx: ExtensionContext): Promise<void> {
    const size = String(ctx.config.modelSize ?? '150m') as ModelSize;
    if (!VALID_SIZES.includes(size)) {
      throw new Error(`unknown modelSize "${size}"; expected one of ${VALID_SIZES.join(', ')}`);
    }
    this.batchSize = Number(ctx.config.batchSize ?? 16);

    // Paths come from ctx.modelDir, never from inside this repository — that is
    // how weights stay out of version control.
    const modelPath = join(ctx.modelDir, `ettin-${size}-model.onnx`);
    const tokenizerPath = join(ctx.modelDir, `ettin-${size}-tokenizer.json`);

    // REFUSE HERE, not per-call.
    //
    // scoreBatch() is a scaffold that throws (see it for why it was not faked).
    // Loading anyway meant this extension downloaded up to 597 MB, held an ONNX
    // session open, reported itself installed, enabled and healthy — and then
    // threw on every single rerank. The host does fall back to its built-in, so
    // nothing breaks, but the user paid for a model that can never score and
    // gets no explanation of why their chosen reranker never runs.
    //
    // Natively runs all three Ettin sizes itself, correctly: its ONNX graph
    // emits last_hidden_state rather than logits, and Core applies the
    // Sentence-Transformers head (CLS -> Dense+GELU -> LayerNorm -> Dense) that
    // this extension would also have to reimplement, along with the BPE
    // tokeniser. Until that is done here, the built-in is strictly better and
    // saying so is more useful than a session that cannot be used.
    void modelPath; void tokenizerPath;
    throw new Error(
      'The Ettin reranker extension is not finished: its ONNX tokenisation and scoring '
      + 'head are unimplemented, so it cannot rank anything. Natively runs Ettin 32m, 68m '
      + 'and 150m built in — choose one under Settings > Reranker instead. '
      + 'See https://github.com/evinjohnn/natively-ettin-reranker for the remaining work.');
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    opts: { topK: number; signal: AbortSignal },
  ): Promise<RankedCandidate[]> {
    if (!this.session) throw new Error('rerank() called before init()');
    if (candidates.length === 0) return [];

    const scores: number[] = [];
    for (let i = 0; i < candidates.length; i += this.batchSize) {
      if (opts.signal.aborted) throw new Error('rerank aborted');
      scores.push(...await this.scoreBatch(query, candidates.slice(i, i + this.batchSize)));
    }

    // Every candidate is scored, so the host never sees a partial ranking.
    return candidates
      .map((c, i) => ({ id: c.id, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .map((e, i) => ({ ...e, rank: i + 1 }));
  }

  private async scoreBatch(query: string, batch: RerankCandidate[]): Promise<number[]> {
    void query; void batch; void this.tokenizer;
    // NOT IMPLEMENTED, and deliberately not faked.
    //
    // Cross-encoder scoring needs the exact WordPiece/BPE tokenisation the
    // model was exported against, fed to onnxruntime as input_ids/attention_mask
    // tensors. Writing that without the 128-597 MB weights to test against
    // would produce something that returns plausible numbers while ranking
    // arbitrarily — indistinguishable from a working reranker in every test
    // that does not download weights, which is exactly the failure mode a
    // conformance suite cannot catch.
    // Unreachable while init() refuses, and kept so the remaining work is
    // still documented at the place it has to happen.
    throw new Error(
      'EttinReranker: ONNX tokenisation/inference is not implemented yet. ' +
      'This adapter is a scaffold; implement scoreBatch() against real weights ' +
      'before enabling this extension.');
  }

  async dispose(): Promise<void> {
    const session = this.session as { release?: () => Promise<void> } | null;
    this.session = null;
    this.tokenizer = null;
    if (session?.release) { try { await session.release(); } catch { /* best effort */ } }
  }
}

export default EttinReranker;
