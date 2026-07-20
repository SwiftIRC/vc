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
