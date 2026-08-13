# Third-party notices

The MIT licence in [LICENSE](LICENSE) covers **this project's own source** — the Go
under `cmd/` and `internal/` (excluding vendored asset directories), the browser
client under `internal/web/assets/` (excluding `assets/vendor/` and `assets/img/`),
the Anope module under `anope/`, and the docs.

It does **not** and cannot cover the third-party content committed alongside it or
pulled into a build. That content is listed here.

---

## Bundled in the repository, and therefore in every binary

`//go:embed all:assets` puts everything under `internal/web/assets/` inside the
compiled binary, so distributing a build distributes all of it.

### MediaPipe — `internal/web/assets/vendor/mediapipe/`

Google's `@mediapipe/tasks-vision` runtime plus the `selfie_segmenter` model, which
power the background blur and virtual backgrounds. **Apache-2.0.** Sources and
checksums are recorded in that directory's `README.md`.

### Noise-suppression worklet — `internal/web/assets/vendor/noise-suppressor-worklet.min.js`

A pre-minified bundle. It has no provenance README and no licence header, which is
a gap worth closing — the components below were identified from strings inside the
bundle rather than from a recorded vendoring step:

| Component | Upstream licence |
|---|---|
| `@jitsi/rnnoise-wasm` | Apache-2.0 (Jitsi) |
| RNNoise (wrapped by the above) | BSD-3-Clause (Xiph.Org / Jean-Marc Valin) |
| `core-js` | MIT (Denis Pushkarev) — the bundle embeds its own licence URL |

Re-vendoring this file from a recorded source, with checksums and the licence texts,
would put it on the same footing as the MediaPipe directory.

### SwiftIRC logo — `internal/web/assets/favicon.ico`

The browser-tab icon, derived from the SwiftIRC logo at
`https://swiftirc.net/images/avatar.png` and rebuilt as a 16/32/48 ICO.

It is SwiftIRC's own mark, used here by SwiftIRC's own application, so no permission
question arises for this project. It is called out anyway because **a trade mark is
not licensed by MIT** — the MIT grant covers the software, not the marks that
identify who publishes it. A fork should replace it with its own icon rather than
ship someone else's logo under a licence that never covered it.

### Background scenes — `internal/web/assets/img/bg/`

See [`internal/web/assets/img/bg/README.md`](internal/web/assets/img/bg/README.md)
for per-file sources and checksums.

`carina.webp` ("Cosmic Cliffs") and `pillars.webp` ("Pillars of Creation") are JWST
images from the ESA/Webb archive. Credit **NASA/ESA/CSA/STScI**. They are the only
scenes tracked in this repository.

**Four further scenes — `office-space.webp`, `space-ghost.webp`, `star-trek.webp`
and `idiocracy.webp` — are frames from copyrighted film and television** (Office
Space, 20th Century Fox; Space Ghost Coast to Coast, Cartoon Network / Williams
Street; Star Trek: The Next Generation, Paramount; Idiocracy, 20th Century Fox).
They are **not licensed**, **not covered by this project's MIT licence**, and
**not offered for reuse or redistribution** — the MIT grant to "use, copy, modify,
merge, publish, distribute, sublicense, and/or sell" does not extend to them and
cannot be granted by this project.

**They are therefore not in this repository.** They are git-ignored, so they exist
only in a working copy that put them there deliberately. A clone contains the two
JWST images and nothing else, and a binary built from a clone embeds only those.
The ignore rule denies every `.webp` and re-admits the licensed ones by name, so an
unlicensed image cannot be committed by forgetting to update a list.

Nothing needs deleting before redistributing a build, because the client no longer
hard-codes a scene list. `internal/server/scenes.go` discovers whichever images
were embedded and injects that list into the app shell, so the picker offers
exactly what the build actually contains. If your working copy has the four files,
your build has them and must not be redistributed; a build from a clean clone can
be.

The same mechanism is how you add your own: drop a `.webp` into
`internal/web/assets/img/bg/` and rebuild. The filename becomes the chip label, and
there is nothing else to update.

---

## Not bundled in the repository, but linked into a build

Go dependencies are resolved from `go.mod` rather than vendored, so they are absent
from this source tree but present in a compiled binary. The significant ones:

| Module | Licence |
|---|---|
| `github.com/pion/*` (webrtc/v4, rtcp, rtp, interceptor, srtp, ice, …) | MIT |
| `github.com/coder/websocket` | ISC |

Run `go list -m all` for the full set, and `go-licenses` or equivalent if a complete
audit is needed for a distribution.

---

## The Anope module

`anope/m_webrtc_chat/` is this project's own code and is MIT-licensed with the rest.
Building it for deployment links against Anope 2.1 (GPL-2.0) and libcurl
(curl licence, MIT-like). Those are build/runtime dependencies of the host services
package, not code redistributed here, but a binary Anope module built against Anope
is subject to Anope's own licensing terms — check them before distributing one.
