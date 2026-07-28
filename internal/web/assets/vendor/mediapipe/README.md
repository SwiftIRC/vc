# Vendored MediaPipe (tasks-vision)

Powers the background blur / virtual background effects (`lib/segmenter.js`).

Vendored rather than fetched at runtime so the binary stays self-contained and no
user's browser is sent to a Google endpoint.

## Contents

Everything is stored **gzipped** and served by `internal/server/static.go` under
its real name with `Content-Encoding: gzip`. Raw, these total ~12 MB; gzipped,
~3.7 MB.

| File | Source | SHA-256 (of the `.gz`) |
|---|---|---|
| `vision_bundle.mjs.gz` | `npm pack @mediapipe/tasks-vision` → `package/vision_bundle.mjs` | `190ee0ed7416a32dd24ec927a4a0a97f9140361b17232cf6f4e2b3aa432774c2` |
| `vision_wasm_internal.js.gz` | same → `package/wasm/vision_wasm_internal.js` | `7efbaf6db0cc8ddbf11ab49623182fa11ae5df7d8599e537b748d0425a843bde` |
| `vision_wasm_internal.wasm.gz` | same → `package/wasm/vision_wasm_internal.wasm` | `4c1bb43967b7fd0a1910b6a2b35450255f52f013722d22a9eea9bd6f502e829f` |
| `selfie_segmenter.tflite.gz` | `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite` | `810482139fecdd085d03a55fafcf45f115fa4e3ce6ce0f0d18363ddfb171b213` |

Computed with `sha256sum *.gz` from this directory. Re-running the vendoring
commands and re-hashing the result should reproduce these exactly — a mismatch
means either the upstream source changed or something went wrong locally.

The model is **not** in the npm package and must be fetched separately. The URL
above (the `float16/1/` version) returned HTTP 200 and was used as-is; no
fallback version was needed.

`@mediapipe/tasks-vision` was pinned at `1.0.0` when these were vendored.

## Deliberate omission

`vision_wasm_nosimd_internal.*` is not vendored. It is another ~11 MB raw, and
WASM SIMD is available in Chrome 91+, Firefox 89+, and Safari 16.4+ — every
browser this app otherwise supports. `web_test.go` asserts it stays absent.

## Updating

Re-run the commands above, confirm `go test ./internal/web/` passes, and re-check
the manual segmentation-quality steps in `MANUAL-TEST.md` — a model change can
alter output quality without failing a single test. If the intent is a byte-for-
byte re-vendor rather than a genuine upgrade, `sha256sum *.gz` the result and
compare against the table above; a deliberate version bump should update the
table itself.
