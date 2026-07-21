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

_(Filled in Task 10.)_

## Config

_(Filled in Task 10.)_
