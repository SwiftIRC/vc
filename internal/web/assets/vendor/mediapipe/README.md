# Vendored MediaPipe (tasks-vision)

Powers the background blur / virtual background effects (`lib/segmenter.js`).

Vendored rather than fetched at runtime so the binary stays self-contained and no
user's browser is sent to a Google endpoint.

## Contents

Everything is stored **gzipped** and served by `internal/server/static.go` under
its real name with `Content-Encoding: gzip`. Raw, these total ~12 MB; gzipped,
~3.7 MB.

| File | Source |
|---|---|
| `vision_bundle.mjs.gz` | `npm pack @mediapipe/tasks-vision` → `package/vision_bundle.mjs` |
| `vision_wasm_internal.js.gz` | same → `package/wasm/vision_wasm_internal.js` |
| `vision_wasm_internal.wasm.gz` | same → `package/wasm/vision_wasm_internal.wasm` |
| `selfie_segmenter.tflite.gz` | `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite` |

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
alter output quality without failing a single test.
