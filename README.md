# Natively Extensions

Community reranker extensions for [Natively](https://natively.software).
<!-- Linked to the product site, not a GitHub account: this repository is
     published from a separate account, and a link to the maintainer's
     personal namespace would tie the two together. -->

**No model weights are in this repository, and none are downloaded without an
explicit action by you.** The adapter code here is MIT licensed; the models are
not, and each one's licence is stated in its `extension.json` and shown to you
before anything is fetched.

## What an extension is

Natively reranks retrieved chunks before they become an answer's evidence. It
ships several rerankers of its own. An *extension* lets someone add another one
without touching Natively itself — which is the point: a model's licence stays
with the adapter that loads it, and never attaches to the application.

Each extension is an ordinary npm package exporting one class:

```ts
export interface Reranker {
  readonly id: string;
  readonly name: string;
  init(ctx: ExtensionContext): Promise<void>;
  rerank(query: string, candidates: RerankCandidate[],
         opts: { topK: number; signal: AbortSignal }): Promise<RankedCandidate[]>;
  dispose(): Promise<void>;
}
```

`ExtensionContext` carries four things — the extension's id, its private model
directory, a logger, and its config. There is no `fs`, no `net`, no `process`,
and nothing that reaches them.

## What's here

| Package | Model | Runtime | Licence | Download |
|---|---|---|---|---|
| [`packages/ettin-reranker`](packages/ettin-reranker) | Ettin cross-encoder, 32M / 68M / 150M | ONNX, in-process | Apache-2.0 | 1008 MB total |
| [`packages/qwen3-reranker`](packages/qwen3-reranker) | Qwen3 Reranker 0.6B | GGUF via `llama-server` | Apache-2.0 | 484 MB |
| [`packages/jina-reranker`](packages/jina-reranker) | Jina Reranker v3.5 | GGUF via `llama-server` | **CC-BY-NC-4.0** | 398 MB |

`registry.json` at the root is the metadata index — id, version, category and
model licences for each package. It contains no code and no weights.

## Install

<!-- BEGIN GENERATED: do not edit by hand, run `npm run generate` -->

```bash
git clone https://github.com/Brosski224/natively-extensions.git
cd natively-extensions
npm install
npm run build
```

<!-- END GENERATED -->

Then in Natively: **Settings → Reranker → Install from folder**, and choose the
`packages/<name>` directory you want.

`dist/` is not committed, and Natively's installer refuses an extension whose
entrypoint has not been built — so `npm run build` is required, not advisory.
There is no `natively` CLI; installing from a folder is the supported path.

## Releases — how Natively installs these without a clone

`dist/` is never committed, and Natively refuses an extension whose entrypoint
is not built. A clone or a source tarball is therefore **not** installable — only
a release is.

Cutting one builds each dependency-free package into a single self-contained ESM
file and publishes three kinds of asset:

| Asset | What it is |
|---|---|
| `<id>-<version>.js` | the whole adapter, bundled, no imports to resolve |
| `<id>-<version>.json` | its `extension.json`, entrypoint rewritten to `dist/index.js` |
| `registry.json` | every entry, with `https` download URLs, `sha256` and byte counts |

Natively fetches that `registry.json`, verifies each download against its
`sha256` before writing anything, and then runs its ordinary installer and trust
prompt. Two plain files rather than an archive, deliberately: there is no
archive-extraction path, so none to get path traversal wrong.

```bash
git tag v1.0.0 && git push origin v1.0.0    # or run the Release workflow by hand
```

The workflow re-runs every check `main` must pass before it publishes anything.

**A sha256 published beside the artefact proves integrity, not authenticity.**
It catches a truncated or corrupted download. It does not tell you the
repository was not compromised — the install prompt, which lists every
permission, is what stands between you and code you did not write.

**Not every package is published.** A package with runtime dependencies is
excluded automatically, from its own `package.json` rather than a hardcoded
list. `ettin-reranker` depends on `onnxruntime-node`, a native addon: a bundle
built on one CI runner would carry one platform's `.node` binary and break the
other. Natively ships Ettin itself, so nothing is lost.

## Two things worth knowing before you install

**`llama-server` is not bundled.** Qwen3 and Jina both spawn it, and neither
vendors nor downloads llama.cpp — they locate `llama-server` on your `PATH` or
at a configured path and tell you if it is missing. Shipping a third-party
native binary is a signing, notarisation and auto-update problem an extension
should not quietly take on. Ettin is the exception: ONNX, in-process, no
subprocess at all.

**Jina Reranker v3.5 is CC-BY-NC-4.0 — non-commercial.** Natively does not
distribute those weights. Before anything downloads you must read the licence
and tick a box; the acknowledgement is recorded with the model key, licence id
and a timestamp, and the model will not load without it. If the licence changes
upstream you are asked again. You are responsible for obtaining whatever rights
your use requires.

## Permissions

Every extension declares what it needs, Natively shows that list before you
install, and anything undeclared is denied and logged.

| Permission | Grants | Used by |
|---|---|---|
| `filesystem.models` | read/write inside its own model directory | all three |
| `network.localhost` | loopback only | Qwen3, Jina |
| `process.spawn` | only binaries named in the manifest | Qwen3, Jina |
| `filesystem.workspace` | read-only, per session, user-granted | none |
| `network.remote` | only hosts named in the manifest | none |

### What the sandbox is, and is not

Each extension runs in its own process, with `fetch` proxied through Natively,
raw socket modules removed, and `child_process` reduced to a `spawn` that only
accepts pre-authorised binaries.

That is defence in depth against a **sloppy** extension. It is **not** a
boundary against a hostile one, and this repository will not pretend otherwise:
a native addon does its I/O from C++ and never passes a JavaScript hook, an
extension granted `process.spawn` runs a real binary that inherits none of
these limits, and the module loader is patched rather than frozen. That is
exactly why installing requires a trust prompt listing every permission, and
why nothing ships enabled.

## Only one reranker runs at a time

Natively resolves a single reranker: an enabled extension *replaces* the
built-in rather than running beside it. If two reranker extensions are enabled
it refuses to choose and keeps the built-in, because picking one arbitrarily
would silently reorder your evidence. Enable exactly one.

## No weights, enforced

`.gitignore` excludes `*.gguf`, `*.onnx`, `*.safetensors`, `*.bin`, `*.pt`,
`*.pth` and `models/`. A guard fails the build if any of those, or any file
over 10 MB, is ever tracked — and it runs both in CI and as a pre-commit hook,
so this holds by construction rather than by everyone remembering.

```bash
npm run guard
```

## Ownership and transfers

The GitHub owner lives in exactly one file: `extensions.config.json`. Every
manifest `homepage`, every install command and every registry entry is
generated from it.

```bash
npm run set-owner -- <github-account>
```

CI fails if the owner is hardcoded anywhere else, or if a generated file is
stale. GitHub keeps a redirect after a transfer so existing clone URLs continue
to resolve, but the canonical name should still be updated here.

## Development

```bash
npm install
npm run set-owner -- <github-account>   # required once; generation refuses a placeholder
npm run typecheck
npm run build
npm test                 # conformance suites. Downloads nothing.
npm run guard            # no weights, no oversized files
npm run verify:owner     # owner appears in one place only
npm run validate:registry
```

`npm install` points git at `.githooks`, so the weight guard also runs
pre-commit.

## Licence

MIT for the adapter code in this repository — see [LICENSE](LICENSE). The
models are separately licensed and are not distributed here.
