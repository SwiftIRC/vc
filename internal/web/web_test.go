package web

import (
	"io/fs"
	"testing"
)

func TestAssetsEmbedded(t *testing.T) {
	for _, name := range []string{"index.html", "app.js"} {
		if _, err := fs.Stat(Assets, name); err != nil {
			t.Errorf("asset %q not embedded: %v", name, err)
		}
	}
}

// The background-effects runtime is embedded gzipped. A missing file here is a
// feature that is dead on arrival at runtime and that no JS test would notice,
// so assert each one explicitly rather than trusting the vendoring step.
func TestMediaPipeAssetsEmbedded(t *testing.T) {
	for _, name := range []string{
		"vendor/mediapipe/vision_bundle.mjs.gz",
		"vendor/mediapipe/vision_wasm_internal.js.gz",
		"vendor/mediapipe/vision_wasm_internal.wasm.gz",
		"vendor/mediapipe/selfie_segmenter.tflite.gz",
	} {
		info, err := fs.Stat(Assets, name)
		if err != nil {
			t.Errorf("asset %q not embedded: %v", name, err)
			continue
		}
		// Guards against a truncated or placeholder file being committed.
		if info.Size() < 1024 {
			t.Errorf("asset %q is only %d bytes — looks truncated", name, info.Size())
		}
	}
	// The no-SIMD fallback is deliberately not vendored; it would add ~11MB raw
	// for browsers this app does not otherwise support.
	if _, err := fs.Stat(Assets, "vendor/mediapipe/vision_wasm_nosimd_internal.wasm.gz"); err == nil {
		t.Error("no-SIMD build should not be vendored")
	}
}
