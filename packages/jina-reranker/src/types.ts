/** Natively extension API v1 — the contract Core defines. Kept local so this
 *  repository has no dependency on Natively's internals. */
export interface RerankCandidate { id: string; text: string; score?: number; metadata?: Record<string, unknown>; }
export interface RankedCandidate { id: string; score: number; rank: number; }
export interface ExtensionLogger {
  debug(m: string, ...a: unknown[]): void; info(m: string, ...a: unknown[]): void;
  warn(m: string, ...a: unknown[]): void; error(m: string, ...a: unknown[]): void;
}
export interface ExtensionContext {
  readonly extensionId: string;
  readonly modelDir: string;
  readonly logger: ExtensionLogger;
  readonly config: Readonly<Record<string, unknown>>;
}
export interface Reranker {
  readonly id: string;
  readonly name: string;
  init(ctx: ExtensionContext): Promise<void>;
  rerank(query: string, candidates: RerankCandidate[],
         opts: { topK: number; signal: AbortSignal }): Promise<RankedCandidate[]>;
  dispose(): Promise<void>;
}
