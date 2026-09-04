# Qwen3 Reranker

A llama.cpp-backed Qwen3 Reranker 0.6B for Natively.

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
`packages/qwen3-reranker` inside the directory you just cloned.

Repository: https://github.com/evinjohnn/natively-extensions

<!-- END GENERATED -->

## The model

`QuantFactory/Qwen3-Reranker-0.6B-GGUF`, Apache-2.0.

| Quantisation | File | Download |
|---|---|---|
| Q4_K_M (default) | `Qwen3-Reranker-0.6B.Q4_K_M.gguf` | 484 MB |

Scoring uses the yes/no protocol the model was trained for, reading the relative
likelihood of the affirmative token — not llama.cpp's generic ranking endpoint.

Downloading starts after a plain confirmation; Apache-2.0 needs no
acknowledgement gate.

**No model weights are in this repository.** The adapter code is MIT licensed;
the model is not, and its licence is stated in `extension.json`.

### llama.cpp is not bundled

This extension does not vendor or download llama.cpp. It locates `llama-server`
on your `PATH` or at a configured path and prompts you if it is missing.

## Development

From the repository root:

```bash
npm install
npm run build
npm test
```
