// Package web embeds the browser client assets.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:assets
var embedded embed.FS

// Assets is the assets/ subtree (so paths are relative to the web root).
var Assets fs.FS = mustSub()

func mustSub() fs.FS {
	sub, err := fs.Sub(embedded, "assets")
	if err != nil {
		panic(err)
	}
	return sub
}
