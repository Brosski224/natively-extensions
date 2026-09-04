/**
 * jina-reranker-v3.5's scoring head, which is not in the GGUF.
 *
 * Jina ship it separately as `projector.safetensors` and say so in their
 * README: two BF16 matrices, `Linear(1024,512) -> ReLU -> Linear(512,512)`, no
 * biases. The relevance of a passage is the cosine between its projected hidden
 * state and the query's:
 *
 *     score_i = cos( P(h[embed_i]), P(h[rerank]) )
 *
 * So the .gguf alone can never score anything with this model, whatever
 * endpoint it is served through — which is why the manifest declares both files.
 */
import { readFileSync } from 'fs';
import { basename } from 'path';

export const HIDDEN_SIZE = 1024;
export const PROJECTOR_DIM = 512;

export interface Projector { w1: Float32Array; w2: Float32Array; }

interface Entry { dtype: string; shape: number[]; data_offsets: [number, number]; }

/**
 * BF16 -> F32.
 *
 * bfloat16 IS the top 16 bits of an IEEE-754 float32 — same exponent, mantissa
 * truncated — so widening is a shift and is exact. That is why this is not the
 * same problem as F16, which needs a real decode.
 */
function bf16(bytes: Uint8Array, count: number): Float32Array {
  const out = new Float32Array(count);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    // safetensors is little-endian by specification.
    view.setUint32(i * 4, ((bytes[i * 2] | (bytes[i * 2 + 1] << 8)) << 16) >>> 0, true);
  }
  return out;
}

export function loadProjector(filePath: string): Projector {
  const buf = readFileSync(filePath);
  const name = basename(filePath);
  if (buf.length < 8) throw new Error(`${name} is too short to be safetensors`);

  const headerLength = Number(buf.readBigUInt64LE(0));
  if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || 8 + headerLength > buf.length) {
    throw new Error(`${name} has an implausible safetensors header length`);
  }
  const header = JSON.parse(buf.subarray(8, 8 + headerLength).toString('utf8')) as Record<string, Entry>;
  const dataStart = 8 + headerLength;

  // Both key conventions Jina ship: `projector.N.weight` from a torch
  // Sequential, and bare `N.weight` when the Sequential was saved alone.
  const prefix = ('projector.0.weight' in header) ? 'projector.' : '';

  const read = (key: string, rows: number, cols: number): Float32Array => {
    const e = header[`${prefix}${key}`];
    if (!e) throw new Error(`${name}: missing tensor "${prefix}${key}"`);
    if (e.shape.length !== 2 || e.shape[0] !== rows || e.shape[1] !== cols) {
      throw new Error(`${name}: "${key}" is [${e.shape}], expected [${rows}, ${cols}]`);
    }
    const count = rows * cols;
    const [s, epos] = e.data_offsets;
    if (e.dtype === 'BF16') {
      if (epos - s !== count * 2) throw new Error(`${name}: "${key}" is ${epos - s} bytes, expected ${count * 2}`);
      return bf16(buf.subarray(dataStart + s, dataStart + epos), count);
    }
    if (e.dtype === 'F32') {
      if (epos - s !== count * 4) throw new Error(`${name}: "${key}" is ${epos - s} bytes, expected ${count * 4}`);
      const aligned = Uint8Array.prototype.slice.call(buf.subarray(dataStart + s, dataStart + epos));
      return new Float32Array(aligned.buffer, aligned.byteOffset, count);
    }
    // Refuse rather than guess: a wrongly decoded projector still returns
    // perfectly plausible cosines.
    throw new Error(`${name}: "${key}" is ${e.dtype}, only BF16 and F32 are supported`);
  };

  return {
    w1: read('0.weight', PROJECTOR_DIM, HIDDEN_SIZE),
    w2: read('2.weight', PROJECTOR_DIM, PROJECTOR_DIM),
  };
}

/** `W2 @ relu(W1 @ x)`, no biases — the reference Sequential has none. */
export function project(p: Projector, hidden: ArrayLike<number>): Float32Array {
  if (hidden.length !== HIDDEN_SIZE) {
    throw new Error(`expected a ${HIDDEN_SIZE}-wide hidden state, got ${hidden.length}`);
  }
  const mid = new Float32Array(PROJECTOR_DIM);
  for (let o = 0; o < PROJECTOR_DIM; o++) {
    let sum = 0;
    const row = o * HIDDEN_SIZE;
    for (let i = 0; i < HIDDEN_SIZE; i++) sum += p.w1[row + i] * hidden[i];
    mid[o] = sum > 0 ? sum : 0;
  }
  const out = new Float32Array(PROJECTOR_DIM);
  for (let o = 0; o < PROJECTOR_DIM; o++) {
    let sum = 0;
    const row = o * PROJECTOR_DIM;
    for (let i = 0; i < PROJECTOR_DIM; i++) sum += p.w2[row + i] * mid[i];
    out[o] = sum;
  }
  return out;
}

export function norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

export function cosine(a: Float32Array, b: Float32Array, bNorm = norm(b)): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const d = norm(a) * bNorm;
  return d === 0 ? 0 : dot / d;
}
