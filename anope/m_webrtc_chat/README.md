# m_webrtc_chat (Anope 2.1 services module)

Binds IRC channels to webrtc-chat rooms — `!vc`/`!chat` hand out room links,
`VC SET` stores per-channel settings, identified users get an HMAC token, and
every `!vc` provisions the room over HTTP.

## Overview

Two layers:

1. A pure, host-testable core (no Anope headers) under `core/`: HMAC-SHA256
   token minting that byte-for-byte reproduces the Go side's tokens, and the
   provision-request builder.
2. Anope 2.1 glue (`m_webrtc_chat.cpp`): fantasy commands, the `VC` command,
   channel-settings persistence, and the libcurl provision POST.

## Core (host-tested)

Build and run the standalone unit tests (no Anope SDK required):

```
make -C tests test
```

## Anope module (deployment build)

`m_webrtc_chat.cpp` is the Anope 2.1 glue: the `VC` command, `!vc`/`!chat`
fantasy handling, per-channel settings persistence, and the libcurl provision
POST. It `#include`s the header-only `core/` (defining `WVC_HAVE_CURL` so the
libcurl `postProvision` is compiled in).

There is **no Anope SDK on the development host**, so the glue is not compiled by
the local CI — it is written to the documented Anope 2.1 API and built in the
SwiftIRC Anope tree. Every Anope API call the author confirmed against the 2.1
headers carries an inline `// VERIFY(anope-2.1):` marker naming the header /
example module to re-check during review.

### Build & install against Anope 2.1

1. Copy the module **and its core** into the Anope source tree:

   ```
   cp m_webrtc_chat.cpp   <anope-src>/modules/third/
   cp -r core             <anope-src>/modules/third/
   ```

   (`m_webrtc_chat.cpp` includes `core/…`, so the `core/` directory must sit next
   to it under `modules/third/`.)

2. Ensure the OpenSSL and libcurl development packages are installed
   (`libssl-dev`, `libcurl4-openssl-dev` on Debian/Ubuntu). The module links them
   automatically via the inline-CMake block at the top of `m_webrtc_chat.cpp`
   (`find_package(OpenSSL)`, `find_package(CURL)`, `target_link_libraries(...
   OpenSSL::Crypto CURL::libcurl)`); no manual link flags are needed.

3. Build and install:

   ```
   cd <anope-src>
   ./Config && make && make install
   ```

4. Add the config from `anope.conf.example` (see below) and restart / rehash
   services.

## Config

Copy the blocks from [`anope.conf.example`](anope.conf.example) into your services
configuration:

- a `module { name = "m_webrtc_chat"; … }` block with `secret`, `apiurl`,
  `linkorigin`, and `ttl`. **`apiurl` carries `secret` (which is also the
  token-signing key) in a Bearer header, so keep it loopback with plain http, or use
  `https://` if webrtc-chat runs on another host — never a remote `http://`, or the
  secret leaks and op tokens can be forged;**
- a `command { service = "ChanServ"; name = "VC"; command = "chanserv/vc"; }`
  block (exposes `/msg ChanServ VC`);
- two `fantasy { … command = "chanserv/vc"; prepend_channel = yes; }` blocks for
  the `!vc` and `!chat` in-channel triggers.

**`secret` MUST equal webrtc-chat's `-secret` (`WVC_SECRET`)** — it is the shared
HMAC key. It is never handed to users and never logged.

Usage once configured:

- `!vc` / `!chat` in a channel (or `/msg ChanServ VC #channel`) — posts the public
  room link, and sends identified users a personal invite link that joins with their
  channel role. The link is a short `#i=<id>`: the module registers the token
  server-side (`POST /api/invite`, which also provisions the room) and hands out the
  compact id, so the link never wraps/truncates in an IRC NOTICE. If webrtc-chat is
  unreachable it falls back to a self-contained long `#t=<token>` link.
- `/msg ChanServ VC #channel SET ENABLED {ON|OFF}` — turn video chat on/off.
- `/msg ChanServ VC #channel SET IDENTIFIED {ON|OFF}` — restrict joining to
  NickServ-identified users.
- `/msg ChanServ VC #channel SET ROOM <slug>` — set the room slug (lowercase,
  `a-z 0-9 -`, must be unique across channels).

`SET` requires the channel `SET` privilege (op/founder) or a services oper.

**Default room slugs are made unique automatically.** A channel with no explicit
`SET ROOM` gets a slug derived from its name, and different channel names can
normalize to the same slug (for example `#c`, `#c++` and `#c#` all reduce to `c`).
When that happens the earliest-registered channel keeps the clean slug and every
later colliding channel gets a deterministic per-name suffix (e.g. `c-1a2b3c4d`).
That resolved slug is **stable** — it never changes as other channels come and go,
so the link `!vc` posts today still works next month. Channels with
normalization-colliding names (like `#c` / `#c++`) should run
`VC #chan SET ROOM <name>` to choose a clean, memorable slug of their own.

## Cross-implementation token interop

The token format is fixed by the Go side and must interoperate byte-for-byte. The
C++ `wvc::sign` in `core/token.h` reproduces the two `want:"ok"` vectors in
`internal/token/testdata/vectors.json` exactly (see `tests/test_token.h`), so any
token this module mints validates in Go's `token.Verify`.

Re-verify after any change to the core or the claims shape:

```
make -C tests test
```

If the Go `Claims` shape or JSON key order ever changes, update `core/claims.h`
**and** the shared vectors together, then re-run the test above.

## Deployment smoke test

After deploying, verify end-to-end:

1. Run webrtc-chat with `-secret <s>`; set the same `secret = "<s>"` in the module
   config block.
2. `/msg ChanServ VC #chan SET ENABLED ON`.
3. Run `!vc` in `#chan` and confirm:
   - the public room link appears in the channel;
   - a NickServ-identified user receives a private short `#i=<id>` link by NOTICE;
   - webrtc-chat logs an `invite registered` line (which also provisions the room);
   - opening the invite link joins the room with the caller's role/badge.

