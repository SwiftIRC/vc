# Background images

Virtual-background assets for the picker's "Scenes" row, embedded into the binary
by `//go:embed all:assets` in `internal/web/web.go`.

All five are 1280x720 WebP. Each was centre-cropped to exactly 16:9 before being
resized, so none is distorted. `-quality` is NOT used: the ImageMagick WebP
delegate here (libwebp 1.3.2) ignores it — q30 and q95 produce byte-identical
output — so `-define webp:method=6` sets the effort and, for `carina.webp`,
`-define webp:target-size` caps the size.

| file | subject | source native | crop | bytes | fallback | SHA-256 |
|---|---|---|---|---|---|---|
| `office-space.webp` | Office Space (1999), cubicle farm | 1920x1040 | 1849x1040 | 61768 | `#585454` | `85bf0ee3b2cb647402db9ee31246a0b5e91070245b019622292831fc4cbdc0cf` |
| `space-ghost.webp` | Space Ghost Coast to Coast, set | 1024x735 | 1024x576 | 49538 | `#675364` | `681dfc3d5fd8f238edf367dc71d79d2aa9d76f4ff4973559e3571ea5cb023be1` |
| `star-trek.webp` | Star Trek: TNG, Enterprise-D bridge | 1600x1051 | 1600x900 | 61038 | `#7D705E` | `92768843151b4ac3d6088757d3133b6a2c8e5b0adb7a0022e7d11c753e7ae41d` |
| `idiocracy.webp` | Idiocracy (2006), Frito's apartment | 1200x674 | 1198x674 | 47706 | `#3E3524` | `88c88f407dd6f6d95dc88475175e19ada582d9b8006b48d265b95921d63f08c8` |
| `carina.webp` | Carina Nebula, "Cosmic Cliffs" | 1280x741 | 1280x720 | 127254 | `#614E54` | `4a4f1b8557a89b576d75d33ecdeec14bea939c226dc63daaec7b58587e285732` |

`fallback` is each image's own average colour: what the compositor and picker
draw until the bitmap decodes, and what they keep drawing if it never does.

`space-ghost.webp` is a 1.25x upscale — 1024x735 is the largest its source offers.

## Sources and licensing

| file | source URL |
|---|---|
| `office-space.webp` | `https://cinematicfreeze.com/wp-content/uploads/gallery/office-space-1999/Office-Space-Stills-011.jpg` |
| `space-ghost.webp` | artwork page `https://www.deviantart.com/jsparrow4/art/Space-Ghost-Coast-to-Coast-Set-1004749507` — the direct image URL carries an expiring token and is not durable; re-copy a fresh one from this page to re-fetch |
| `star-trek.webp` | `https://cdn.wallpapersafari.com/92/28/tCxr1v.jpg` |
| `idiocracy.webp` | `https://i.pinimg.com/originals/99/aa/f3/99aaf3df8a8533d0ed73350d59624a9e.jpg` |
| `carina.webp` | `https://esawebb.org/media/archives/images/screen/weic2205a.jpg` |

`carina.webp` is from the ESA/Webb archive copy of the JWST "Cosmic Cliffs"
release, credit **NASA/ESA/CSA/STScI**. The NASA-hosted copy is public domain but
only offered at 1041x603, which would have needed an upscale; the ESA copy is
1280x741 and needs none. A 14575x8441 master exists at
`.../images/large/weic2205a.jpg` if a higher-resolution version is ever wanted.

The other four are frames from copyrighted film and television — Office Space
(20th Century Fox), Space Ghost Coast to Coast (Cartoon Network / Williams
Street), Star Trek: The Next Generation (Paramount), and Idiocracy (20th Century
Fox) — used here as personal virtual backgrounds, the same way one would set a
Zoom background. They are not licensed assets and are not offered for reuse.

Those four are therefore **not in the repository**: they are git-ignored (see the
root `.gitignore`), because they are not covered by the project's MIT licence and
`//go:embed all:assets` would otherwise put them in every distributed binary. Only
`carina.webp` is tracked. See
[THIRD-PARTY-NOTICES.md](../../../../THIRD-PARTY-NOTICES.md).

## How scenes are wired up

Nothing hard-codes the list. `internal/server/scenes.go` globs `img/*.webp` from the
embedded FS at startup and injects what it finds into the app shell, which
`lib/backgrounds.js` reads synchronously — so the picker always offers exactly what
the build contains, and the Scenes row disappears entirely if it contains nothing.

To add your own: drop a `.webp` in this directory and rebuild. 1280x720 is the
target (16:9; anything else is centre-cropped at runtime). Add a row to
`scenes.json` to give it a proper label and an average colour for the pre-decode
placeholder; without one it gets a label derived from the filename and a neutral
grey. `scenes.json` may list files that are not present — an entry with no file is
skipped, which is exactly how the four untracked ones behave in a clone.

## Regenerating

See the `convert` commands in
`docs/superpowers/plans/2026-07-30-image-backgrounds.md` (Task 1, step 4). Source
URLs are in the table above; the Space Ghost DeviantArt URL carries an expiring
token and will need re-copying from the artwork page.
