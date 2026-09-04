# Ettin Reranker

An ONNX cross-encoder reranker for Natively, in three sizes.

> **Community extension.** Not part of Natively Core. By installing it you take
> responsibility for obtaining any rights your use of the model requires.

## Install

<!-- BEGIN GENERATED: do not edit by hand, run `npm run generate` -->

```bash
git clone https://github.com/evinjohnn/natively-extensions.git
cd natively-extensions
npm install && npm run build
```

Then in Natively: **Settings → Reranker → Install from folder**, and choose
`packages/ettin-reranker` inside the directory you just cloned.

Repository: https://github.com/evinjohnn/natively-extensions

<!-- END GENERATED -->

## The model

Ettin cross-encoders, Apache-2.0. All three sizes are one extension, selected by
the `modelSize` config value:

| Size | Hugging Face repo | File | Download |
|---|---|---|---|
| `32m` | `cross-encoder/ettin-reranker-32m-v1` | `onnx/model.onnx` | 128 MB |
| `68m` | `cross-encoder/ettin-reranker-68m-v1` | `onnx/model.onnx` | 273 MB |
| `150m` (default) | `cross-encoder/ettin-reranker-150m-v1` | `onnx/model.onnx` | 597 MB |

The tokenizer and config download alongside the weights — an ONNX cross-encoder
is useless without the exact tokenizer it was exported against.

Upstream also publishes architecture-specific INT8 exports
(`model_qint8_arm64`, `model_qint8_avx512`). Those cannot be one manifest entry
across macOS-arm64 and Windows-x64, so this extension uses the portable fp32
export.

Needs only `filesystem.models`: no network, no subprocess. It is the only one of
the three that genuinely delivers download-then-use.

**No model weights are in this repository.** The adapter code is MIT licensed;
the model is not, and its licence is stated in `extension.json`.

> **Note.** Natively now ships all three Ettin sizes itself. This package
> remains as a worked reference for the extension API — a model adapter that
> runs entirely in-process with a single permission.

## Development

From the repository root:

```bash
npm install
npm run build
npm test
```
