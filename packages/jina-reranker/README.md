# Jina Reranker v3.5

A llama.cpp-backed Jina Reranker v3.5 for Natively.

> **Community extension.** Not part of Natively Core. By installing it you take
> responsibility for obtaining any rights your use of the model requires.

## Install

<!-- BEGIN GENERATED: do not edit by hand, run `npm run generate` -->

```bash
git clone https://github.com/Brosski224/natively-extensions.git
cd natively-extensions
npm install && npm run build
```

Then in Natively: **Settings → Reranker → Install from folder**, and choose
`packages/jina-reranker` inside the directory you just cloned.

Repository: https://github.com/Brosski224/natively-extensions

<!-- END GENERATED -->

## The model

`jinaai/jina-reranker-v3.5-GGUF`.

| Quantisation | File | Download |
|---|---|---|
| Q4_K_M (default) | `jina-reranker-v3.5-Q4_K_M.gguf` | 397 MB |

Scoring is listwise: the passages are scored together in a single pass, reading
hidden states at the positions the model marks, rather than through llama.cpp's
generic ranking endpoint.

### Licence: CC-BY-NC-4.0 — non-commercial

**This model may not be used commercially.**

Natively does not distribute these weights. Before anything downloads you must
read the licence and tick a box; the acknowledgement is recorded with the model
key, licence id and a timestamp, and the model will not load without it. If the
licence changes upstream you are asked again.

You are responsible for obtaining whatever rights your use requires.

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
