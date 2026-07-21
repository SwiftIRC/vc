# Plan 4 — m_webrtc_chat (Anope 2.1 services module) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SwiftIRC Anope 2.1 services module that binds IRC channels to webrtc-chat rooms — `!vc`/`!chat` hand out room links, `VC SET` stores per-channel settings, identified users get an HMAC token, and every `!vc` provisions the room over HTTP.

**Architecture:** Two layers. (1) A **pure, host-testable core** (no Anope headers): HMAC-SHA256 token minting that byte-for-byte reproduces the Go side's tokens, and the provision-request builder. Built and unit-tested on this machine with g++ + OpenSSL against the shared vectors. (2) **Anope 2.1 glue** (`m_webrtc_chat.cpp`): fantasy commands, the `VC` command, channel-settings persistence, and the libcurl provision POST — written to the documented Anope 2.1 API and compiled in the SwiftIRC deployment tree (no Anope SDK is available on the build host, so the glue is verified by review + a deployment build, not local CI).

**Tech Stack:** C++17, OpenSSL 3 (`libcrypto`, HMAC-SHA256 + base64), libcurl (provision POST), Anope 2.1 module API, a hand-written `make`/`g++` test harness (no framework).

## Global Constraints

- **Token format is fixed by the Go side and MUST interoperate byte-for-byte.** `token = base64url_raw(payload_json) + "." + base64url_raw(HMAC_SHA256(secret, payload_b64_ascii))`. The HMAC is computed over the **base64 payload string's bytes**, never over the raw JSON. Base64 is **RawURL** (alphabet `A–Za–z0–9-_`, **no `=` padding**).
- **Payload JSON is compact, keys in this exact order:** `{"c":<channel>,"r":<room>,"a":<account>,"n":<nick>,"o":<role>,"f":<flags>,"i":<issuedAt>,"e":<expiresAt>}` — no spaces. String values are JSON-escaped to match Go's `encoding/json`: escape `"`→`\"`, `\`→`\\`, `<`→`<`, `>`→`>`, `&`→`&`, and any byte `< 0x20` (`\n \r \t \b \f`, else `\u00XX`). `#` is NOT escaped.
- **Claims fields:** `c` channel (with leading `#`), `r` room slug, `a` NickServ account (`""` for none), `n` display nick, `o` role ∈ `{"op","voice","user"}`, `f` flags int (`FlagIdentifiedOnly = 1`), `i` issued-at unix seconds, `e` expires-at unix seconds.
- **Token lifetime:** ~10 minutes (`e = i + 600`). Verified worst-case token length **must stay ≤ 320 chars** (Go test's ceiling; the true budget is a single IRC NOTICE line, ~440 usable chars).
- **Shared vectors:** `internal/token/testdata/vectors.json` is the source of truth. The two `want:"ok"` vectors (`valid-op`, `valid-user`) MUST be reproduced exactly by the C++ `Sign`. Secret for both: `test-secret-0123456789abcdef`.
- **Provision endpoint:** `POST {base}/api/provision`, header `Authorization: Bearer <shared-secret>`, `Content-Type: application/json`, body `{"channel":"#chan","room":"slug","settings":{"identifiedOnly":<bool>}}`, expected response `204 No Content`. Room slug is lowercased and must match `^[a-z0-9][a-z0-9-]*$` (the server's `slugRe`).
- **Anope authority:** channel→(room slug + settings) lives in Anope's data store and is authoritative; webrtc-chat is provisioned from it and never calls back into Anope.
- **Slug uniqueness:** no channel may claim another channel's room slug; the module enforces this at `VC SET ROOM` time.
- **Secret provenance:** the shared secret is read from the module's config block in `anope.conf` and is the SAME value passed to webrtc-chat's `-secret`. Never logged.
- **No Anope headers in the pure core.** `token/` and `provision/` compile with g++ + OpenSSL/libcurl ONLY, so they are unit-tested on the build host. Anope is included only by `m_webrtc_chat.cpp`.

---

## File Structure

All new files under `anope/m_webrtc_chat/` in the webrtc-chat repo (developed and unit-tested here; the `.cpp`/`.h` are copied into the Anope `modules/third/` tree at deploy time).

- `anope/m_webrtc_chat/core/base64url.h` — RawURL base64 encode (header-only, inline). **Pure.**
- `anope/m_webrtc_chat/core/json_escape.h` — Go-compatible JSON string escaper. **Pure.**
- `anope/m_webrtc_chat/core/claims.h` — `Claims` struct + `claimsToJSON`. **Pure.**
- `anope/m_webrtc_chat/core/token.h` — `sign(claims, secret)` (HMAC + assemble). **Pure.**
- `anope/m_webrtc_chat/core/build.h` — `makeClaims(...)` from IRC context + role/flag mapping + expiry. **Pure.**
- `anope/m_webrtc_chat/core/provision.h` — `buildProvisionBody(...)` (pure) + `postProvision(...)` (libcurl).
- `anope/m_webrtc_chat/tests/` — standalone test harness: `test_main.cpp`, per-unit test files, `Makefile`. **Host-tested.**
- `anope/m_webrtc_chat/m_webrtc_chat.cpp` — Anope 2.1 glue (config, settings, `VC` command, fantasy, wiring). **Deployment-built.**
- `anope/m_webrtc_chat/anope.conf.example` — module config block.
- `anope/m_webrtc_chat/README.md` — build/install/config + cross-impl test notes.

The core is header-only so the same translation units compile into both the host test binary AND `m_webrtc_chat.cpp` (which `#include`s them) without a multi-`.cpp` Anope build.

---

### Task 1: Module skeleton + standalone test harness

**Files:**
- Create: `anope/m_webrtc_chat/tests/Makefile`
- Create: `anope/m_webrtc_chat/tests/test_main.cpp`
- Create: `anope/m_webrtc_chat/tests/testing.h`
- Create: `anope/m_webrtc_chat/README.md`

**Interfaces:**
- Produces: a `make` target that compiles the test binary with `g++ -std=c++17 -lcrypto` and runs it; a minimal assertion harness `CHECK(cond, msg)` / `CHECK_EQ(got, want, msg)` returning a nonzero process exit on failure. Later tasks add `#include` of their test file into `test_main.cpp`.

- [ ] **Step 1: Write the assertion harness**

`anope/m_webrtc_chat/tests/testing.h`:
```cpp
#pragma once
#include <string>
#include <iostream>
inline int g_failures = 0;
inline void check(bool ok, const std::string& msg) {
  if (!ok) { std::cerr << "FAIL: " << msg << "\n"; ++g_failures; }
}
inline void check_eq(const std::string& got, const std::string& want, const std::string& msg) {
  if (got != want) {
    std::cerr << "FAIL: " << msg << "\n  got:  " << got << "\n  want: " << want << "\n";
    ++g_failures;
  }
}
```

- [ ] **Step 2: Write the test entrypoint (trivial passing test)**

`anope/m_webrtc_chat/tests/test_main.cpp`:
```cpp
#include "testing.h"
// Each later task adds: void test_<unit>(); called from main() below.
int main() {
  check(true, "harness runs");
  if (g_failures) { std::cerr << g_failures << " failure(s)\n"; return 1; }
  std::cout << "ok\n";
  return 0;
}
```

- [ ] **Step 3: Write the Makefile**

`anope/m_webrtc_chat/tests/Makefile`:
```make
CXX ?= g++
CXXFLAGS = -std=c++17 -Wall -Wextra -O2 -I..
LDLIBS = -lcrypto
test: test_main.cpp
	$(CXX) $(CXXFLAGS) test_main.cpp -o test_bin $(LDLIBS)
	./test_bin
clean:
	rm -f test_bin
.PHONY: test clean
```

- [ ] **Step 4: Run it**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: compiles, prints `ok`, exit 0.

- [ ] **Step 5: Write the README skeleton**

`anope/m_webrtc_chat/README.md` — sections: Overview, "Core (host-tested)" with `make -C tests test`, "Anope module (deployment build)" placeholder, "Config" placeholder. (Filled in Task 10.)

- [ ] **Step 6: Commit**
```bash
git add anope/m_webrtc_chat/tests anope/m_webrtc_chat/README.md
git commit -m "feat(anope): m_webrtc_chat test harness + skeleton"
```

---

### Task 2: RawURL base64 encoder

**Files:**
- Create: `anope/m_webrtc_chat/core/base64url.h`
- Create: `anope/m_webrtc_chat/tests/test_base64url.h`
- Modify: `anope/m_webrtc_chat/tests/test_main.cpp` (call `test_base64url()`)

**Interfaces:**
- Produces: `std::string wvc::b64url(const unsigned char* data, size_t len)` and `std::string wvc::b64url(const std::string&)` — RawURL base64 (no padding, `-`/`_`), matching Go `base64.RawURLEncoding`.

- [ ] **Step 1: Write the failing test**

`anope/m_webrtc_chat/tests/test_base64url.h`:
```cpp
#pragma once
#include "testing.h"
#include "core/base64url.h"
inline void test_base64url() {
  // Known-answer vs Go base64.RawURLEncoding.
  check_eq(wvc::b64url("hello"), "aGVsbG8", "b64url hello");        // 'hello' -> aGVsbG8 (no pad)
  check_eq(wvc::b64url(""), "", "b64url empty");
  check_eq(wvc::b64url("f"), "Zg", "b64url f");
  check_eq(wvc::b64url("fo"), "Zm8", "b64url fo");
  // URL-safe alphabet: bytes {0xff,0xff,0xff} -> "____" in standard is "////"; RawURL -> "____".
  unsigned char b[3] = {0xff, 0xff, 0xff};
  check_eq(wvc::b64url(b, 3), "____", "b64url url-safe alphabet");
  // The valid-op payload JSON base64 must equal the vector's p64 prefix.
  check_eq(
    wvc::b64url("{\"c\":\"#swift\",\"r\":\"swift\",\"a\":\"Ryan\",\"n\":\"Ryan\",\"o\":\"op\",\"f\":1,\"i\":1753000000,\"e\":1753000600}"),
    "eyJjIjoiI3N3aWZ0IiwiciI6InN3aWZ0IiwiYSI6IlJ5YW4iLCJuIjoiUnlhbiIsIm8iOiJvcCIsImYiOjEsImkiOjE3NTMwMDAwMDAsImUiOjE3NTMwMDA2MDB9",
    "b64url of valid-op payload matches vector p64");
}
```
Add `void test_base64url();`-style include and call in `test_main.cpp`: `#include "test_base64url.h"` and `test_base64url();` before the failure check.

- [ ] **Step 2: Run to verify it fails**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: FAIL (no `core/base64url.h`).

- [ ] **Step 3: Implement**

`anope/m_webrtc_chat/core/base64url.h`:
```cpp
#pragma once
#include <string>
#include <cstddef>
namespace wvc {
inline std::string b64url(const unsigned char* data, size_t len) {
  static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  out.reserve((len + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 3 <= len; i += 3) {
    unsigned n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out += T[(n >> 18) & 63]; out += T[(n >> 12) & 63];
    out += T[(n >> 6) & 63];  out += T[n & 63];
  }
  size_t rem = len - i;
  if (rem == 1) {
    unsigned n = data[i] << 16;
    out += T[(n >> 18) & 63]; out += T[(n >> 12) & 63];
  } else if (rem == 2) {
    unsigned n = (data[i] << 16) | (data[i + 1] << 8);
    out += T[(n >> 18) & 63]; out += T[(n >> 12) & 63]; out += T[(n >> 6) & 63];
  }
  return out; // RawURL: no '=' padding
}
inline std::string b64url(const std::string& s) {
  return b64url(reinterpret_cast<const unsigned char*>(s.data()), s.size());
}
} // namespace wvc
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: PASS (`ok`).

- [ ] **Step 5: Commit**
```bash
git add anope/m_webrtc_chat/core/base64url.h anope/m_webrtc_chat/tests/
git commit -m "feat(anope): RawURL base64 encoder matching Go"
```

---

### Task 3: Go-compatible JSON escaping + Claims serializer

**Files:**
- Create: `anope/m_webrtc_chat/core/json_escape.h`
- Create: `anope/m_webrtc_chat/core/claims.h`
- Create: `anope/m_webrtc_chat/tests/test_claims.h`
- Modify: `anope/m_webrtc_chat/tests/test_main.cpp`

**Interfaces:**
- Consumes: nothing.
- Produces: `std::string wvc::jsonEscape(const std::string&)`; `struct wvc::Claims { std::string c, r, a, n, o; int f; long long i, e; }`; `std::string wvc::claimsToJSON(const Claims&)`.

- [ ] **Step 1: Write the failing test**

`anope/m_webrtc_chat/tests/test_claims.h`:
```cpp
#pragma once
#include "testing.h"
#include "core/claims.h"
inline void test_claims() {
  // Escaping parity with Go encoding/json (HTML-safe).
  check_eq(wvc::jsonEscape("a\"b\\c"), "a\\\"b\\\\c", "escape quote+backslash");
  check_eq(wvc::jsonEscape("<&>"), "\\u003c\\u0026\\u003e", "escape html chars");
  check_eq(wvc::jsonEscape("tab\tnl\n"), "tab\\tnl\\n", "escape control");
  check_eq(wvc::jsonEscape("#swift|away"), "#swift|away", "no over-escaping of #, |");
  // Exact payload for the valid-op vector.
  wvc::Claims op{"#swift", "swift", "Ryan", "Ryan", "op", 1, 1753000000, 1753000600};
  check_eq(wvc::claimsToJSON(op),
    "{\"c\":\"#swift\",\"r\":\"swift\",\"a\":\"Ryan\",\"n\":\"Ryan\",\"o\":\"op\",\"f\":1,\"i\":1753000000,\"e\":1753000600}",
    "valid-op payload JSON");
  // valid-user: note the '|' in the nick and f:0.
  wvc::Claims usr{"#help", "help", "alice", "alice|away", "user", 0, 1753000000, 1753000600};
  check_eq(wvc::claimsToJSON(usr),
    "{\"c\":\"#help\",\"r\":\"help\",\"a\":\"alice\",\"n\":\"alice|away\",\"o\":\"user\",\"f\":0,\"i\":1753000000,\"e\":1753000600}",
    "valid-user payload JSON");
}
```
Wire into `test_main.cpp`.

- [ ] **Step 2: Run to verify it fails**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: FAIL (missing headers).

- [ ] **Step 3: Implement the escaper**

`anope/m_webrtc_chat/core/json_escape.h`:
```cpp
#pragma once
#include <string>
#include <cstdio>
namespace wvc {
inline std::string jsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 2);
  for (unsigned char ch : s) {
    switch (ch) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      case '\b': out += "\\b";  break;
      case '\f': out += "\\f";  break;
      case '<':  out += "\\u003c"; break; // Go encoding/json HTML-safe defaults
      case '>':  out += "\\u003e"; break;
      case '&':  out += "\\u0026"; break;
      default:
        if (ch < 0x20) { char buf[8]; std::snprintf(buf, sizeof buf, "\\u%04x", ch); out += buf; }
        else out += static_cast<char>(ch);
    }
  }
  return out;
}
} // namespace wvc
```

- [ ] **Step 4: Implement Claims + serializer**

`anope/m_webrtc_chat/core/claims.h`:
```cpp
#pragma once
#include <string>
#include "json_escape.h"
namespace wvc {
struct Claims {
  std::string c, r, a, n, o; // channel, room, account, nick, role
  int f = 0;                 // flags (bit 0 = identified-only)
  long long i = 0, e = 0;    // issued-at, expires-at (unix seconds)
};
inline std::string claimsToJSON(const Claims& x) {
  return "{\"c\":\"" + jsonEscape(x.c) +
         "\",\"r\":\"" + jsonEscape(x.r) +
         "\",\"a\":\"" + jsonEscape(x.a) +
         "\",\"n\":\"" + jsonEscape(x.n) +
         "\",\"o\":\"" + jsonEscape(x.o) +
         "\",\"f\":" + std::to_string(x.f) +
         ",\"i\":" + std::to_string(x.i) +
         ",\"e\":" + std::to_string(x.e) + "}";
}
} // namespace wvc
```

- [ ] **Step 5: Run to verify it passes**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add anope/m_webrtc_chat/core/json_escape.h anope/m_webrtc_chat/core/claims.h anope/m_webrtc_chat/tests/
git commit -m "feat(anope): Go-compatible JSON escaping + claims serializer"
```

---

### Task 4: HMAC-SHA256 signing (`sign`) — reproduce the shared vectors

**Files:**
- Create: `anope/m_webrtc_chat/core/token.h`
- Create: `anope/m_webrtc_chat/tests/test_token.h`
- Modify: `anope/m_webrtc_chat/tests/test_main.cpp`

**Interfaces:**
- Consumes: `wvc::Claims`, `wvc::claimsToJSON`, `wvc::b64url`.
- Produces: `std::string wvc::sign(const Claims&, const std::string& secret)` → `p64 + "." + b64url(HMAC_SHA256(secret, p64))`.

- [ ] **Step 1: Write the failing test (vector reproduction + length budget)**

`anope/m_webrtc_chat/tests/test_token.h` — assert the two `want:"ok"` tokens from `internal/token/testdata/vectors.json` reproduce exactly, and the worst-case length stays ≤ 320:
```cpp
#pragma once
#include "testing.h"
#include "core/token.h"
inline void test_token() {
  const std::string secret = "test-secret-0123456789abcdef"; // vectors.json secret
  wvc::Claims op{"#swift", "swift", "Ryan", "Ryan", "op", 1, 1753000000, 1753000600};
  check_eq(wvc::sign(op, secret),
    "eyJjIjoiI3N3aWZ0IiwiciI6InN3aWZ0IiwiYSI6IlJ5YW4iLCJuIjoiUnlhbiIsIm8iOiJvcCIsImYiOjEsImkiOjE3NTMwMDAwMDAsImUiOjE3NTMwMDA2MDB9.qPFYFM4RU3-42gHb1S58k1NDwZxbrs8XhSeBZcWV7xU",
    "valid-op token reproduces vector");
  wvc::Claims usr{"#help", "help", "alice", "alice|away", "user", 0, 1753000000, 1753000600};
  check_eq(wvc::sign(usr, secret),
    "eyJjIjoiI2hlbHAiLCJyIjoiaGVscCIsImEiOiJhbGljZSIsIm4iOiJhbGljZXxhd2F5IiwibyI6InVzZXIiLCJmIjowLCJpIjoxNzUzMDAwMDAwLCJlIjoxNzUzMDAwNjAwfQ.m1KQ-FVTN6tVKRXjrLFWzas6dRMEZKF6CUBoPVruE1s",
    "valid-user token reproduces vector");
  // Worst-case length budget (Go test ceiling = 320).
  wvc::Claims big{"#" + std::string(30, 'c'), std::string(30, 'r'),
                  std::string(30, 'a'), std::string(30, 'n'), "voice", 1, 1753000000, 1753000600};
  check(wvc::sign(big, secret).size() <= 320, "worst-case token within 320-char budget");
}
```
Wire into `test_main.cpp`.

- [ ] **Step 2: Run to verify it fails**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: FAIL (no `core/token.h`).

- [ ] **Step 3: Implement**

`anope/m_webrtc_chat/core/token.h`:
```cpp
#pragma once
#include <string>
#include <openssl/hmac.h>
#include <openssl/evp.h>
#include "claims.h"
#include "base64url.h"
namespace wvc {
// HMAC is computed over the base64 payload STRING's bytes (matches the Go verifier,
// which re-signs the received p64 rather than re-marshaling the JSON).
inline std::string sign(const Claims& claims, const std::string& secret) {
  std::string p64 = b64url(claimsToJSON(claims));
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int maclen = 0;
  HMAC(EVP_sha256(),
       secret.data(), static_cast<int>(secret.size()),
       reinterpret_cast<const unsigned char*>(p64.data()), p64.size(),
       mac, &maclen);
  return p64 + "." + b64url(mac, maclen);
}
} // namespace wvc
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: PASS — both vector tokens reproduce, length within budget.

- [ ] **Step 5: Commit**
```bash
git add anope/m_webrtc_chat/core/token.h anope/m_webrtc_chat/tests/
git commit -m "feat(anope): HMAC-SHA256 token signing; reproduces shared vectors"
```

---

### Task 5: Claims construction from IRC context (roles, flags, expiry)

**Files:**
- Create: `anope/m_webrtc_chat/core/build.h`
- Create: `anope/m_webrtc_chat/tests/test_build.h`
- Modify: `anope/m_webrtc_chat/tests/test_main.cpp`

**Interfaces:**
- Consumes: `wvc::Claims`.
- Produces: `enum class wvc::Role { Op, Voice, User }`; `std::string wvc::roleString(Role)`; `wvc::Claims wvc::makeClaims(channel, room, account, nick, Role, bool identifiedOnly, long long issuedAt, long long ttlSeconds)`.

- [ ] **Step 1: Write the failing test**

`anope/m_webrtc_chat/tests/test_build.h`:
```cpp
#pragma once
#include "testing.h"
#include "core/build.h"
#include "core/token.h"
inline void test_build() {
  check_eq(wvc::roleString(wvc::Role::Op), "op", "role op");
  check_eq(wvc::roleString(wvc::Role::Voice), "voice", "role voice");
  check_eq(wvc::roleString(wvc::Role::User), "user", "role user");
  // makeClaims wires fields, sets f from identifiedOnly, and e = i + ttl.
  auto c = wvc::makeClaims("#swift", "swift", "Ryan", "Ryan", wvc::Role::Op,
                           /*identifiedOnly=*/true, /*issuedAt=*/1753000000, /*ttl=*/600);
  check(c.f == 1 && c.e == 1753000600 && c.i == 1753000000, "flags + expiry");
  // Reproduces the valid-op token, proving makeClaims feeds sign() correctly.
  check_eq(wvc::sign(c, "test-secret-0123456789abcdef"),
    "eyJjIjoiI3N3aWZ0IiwiciI6InN3aWZ0IiwiYSI6IlJ5YW4iLCJuIjoiUnlhbiIsIm8iOiJvcCIsImYiOjEsImkiOjE3NTMwMDAwMDAsImUiOjE3NTMwMDA2MDB9.qPFYFM4RU3-42gHb1S58k1NDwZxbrs8XhSeBZcWV7xU",
    "makeClaims->sign reproduces valid-op");
  // identifiedOnly=false -> f:0.
  auto c0 = wvc::makeClaims("#help", "help", "alice", "alice|away", wvc::Role::User, false, 1753000000, 600);
  check(c0.f == 0, "identifiedOnly false -> f 0");
}
```
Wire into `test_main.cpp`.

- [ ] **Step 2: Run to verify it fails**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: FAIL (no `core/build.h`).

- [ ] **Step 3: Implement**

`anope/m_webrtc_chat/core/build.h`:
```cpp
#pragma once
#include <string>
#include "claims.h"
namespace wvc {
enum class Role { Op, Voice, User };
inline std::string roleString(Role r) {
  switch (r) { case Role::Op: return "op"; case Role::Voice: return "voice"; default: return "user"; }
}
constexpr int FlagIdentifiedOnly = 1; // mirrors token.FlagIdentifiedOnly
inline Claims makeClaims(const std::string& channel, const std::string& room,
                         const std::string& account, const std::string& nick,
                         Role role, bool identifiedOnly,
                         long long issuedAt, long long ttlSeconds) {
  Claims c;
  c.c = channel; c.r = room; c.a = account; c.n = nick; c.o = roleString(role);
  c.f = identifiedOnly ? FlagIdentifiedOnly : 0;
  c.i = issuedAt; c.e = issuedAt + ttlSeconds;
  return c;
}
} // namespace wvc
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add anope/m_webrtc_chat/core/build.h anope/m_webrtc_chat/tests/
git commit -m "feat(anope): claims construction (roles, flags, expiry)"
```

---

### Task 6: Provision request body builder + libcurl POST

**Files:**
- Create: `anope/m_webrtc_chat/core/provision.h`
- Create: `anope/m_webrtc_chat/tests/test_provision.h`
- Modify: `anope/m_webrtc_chat/tests/test_main.cpp`
- Modify: `anope/m_webrtc_chat/tests/Makefile` (add `-lcurl` and a compile guard)

**Interfaces:**
- Consumes: `wvc::jsonEscape`.
- Produces: `std::string wvc::buildProvisionBody(channel, room, bool identifiedOnly)` (**pure, tested**); `bool wvc::postProvision(const std::string& baseUrl, const std::string& secret, const std::string& body, long timeoutMs, std::string& errOut)` (libcurl; **compile-checked only** — no live server here).

**Note:** `buildProvisionBody` matches the Go handler's decoder exactly: `{"channel":"#chan","room":"slug","settings":{"identifiedOnly":<bool>}}`. `postProvision` is guarded behind `#ifdef WVC_HAVE_CURL` so the host test compiles the pure builder even where `curl/curl.h` is absent; the deployment build always defines it.

- [ ] **Step 1: Write the failing test (pure builder only)**

`anope/m_webrtc_chat/tests/test_provision.h`:
```cpp
#pragma once
#include "testing.h"
#include "core/provision.h"
inline void test_provision() {
  check_eq(wvc::buildProvisionBody("#swift", "swift", true),
    "{\"channel\":\"#swift\",\"room\":\"swift\",\"settings\":{\"identifiedOnly\":true}}",
    "provision body identified");
  check_eq(wvc::buildProvisionBody("#help", "help", false),
    "{\"channel\":\"#help\",\"room\":\"help\",\"settings\":{\"identifiedOnly\":false}}",
    "provision body guests-ok");
}
```
Wire into `test_main.cpp`.

- [ ] **Step 2: Run to verify it fails**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: FAIL (no `core/provision.h`).

- [ ] **Step 3: Implement the pure builder + guarded libcurl POST**

`anope/m_webrtc_chat/core/provision.h`:
```cpp
#pragma once
#include <string>
#include "json_escape.h"
namespace wvc {
inline std::string buildProvisionBody(const std::string& channel, const std::string& room,
                                      bool identifiedOnly) {
  return "{\"channel\":\"" + jsonEscape(channel) +
         "\",\"room\":\"" + jsonEscape(room) +
         "\",\"settings\":{\"identifiedOnly\":" + (identifiedOnly ? "true" : "false") + "}}";
}
#ifdef WVC_HAVE_CURL
#include <curl/curl.h>
// POST body to {baseUrl}/api/provision with Bearer auth. Best-effort: returns false
// (and sets errOut) on transport error or non-2xx; the caller still hands out the URL.
// timeoutMs bounds the whole request so services never block on a down webrtc-chat.
inline bool postProvision(const std::string& baseUrl, const std::string& secret,
                          const std::string& body, long timeoutMs, std::string& errOut) {
  CURL* h = curl_easy_init();
  if (!h) { errOut = "curl init"; return false; }
  std::string url = baseUrl + "/api/provision";
  struct curl_slist* hdrs = nullptr;
  hdrs = curl_slist_append(hdrs, "Content-Type: application/json");
  std::string auth = "Authorization: Bearer " + secret;
  hdrs = curl_slist_append(hdrs, auth.c_str());
  curl_easy_setopt(h, CURLOPT_URL, url.c_str());
  curl_easy_setopt(h, CURLOPT_POST, 1L);
  curl_easy_setopt(h, CURLOPT_POSTFIELDS, body.c_str());
  curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
  curl_easy_setopt(h, CURLOPT_HTTPHEADER, hdrs);
  curl_easy_setopt(h, CURLOPT_TIMEOUT_MS, timeoutMs);
  curl_easy_setopt(h, CURLOPT_NOSIGNAL, 1L);
  CURLcode rc = curl_easy_perform(h);
  long code = 0;
  curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);
  curl_slist_free_all(hdrs);
  curl_easy_cleanup(h);
  if (rc != CURLE_OK) { errOut = curl_easy_strerror(rc); return false; }
  if (code < 200 || code >= 300) { errOut = "http " + std::to_string(code); return false; }
  return true;
}
#endif // WVC_HAVE_CURL
} // namespace wvc
```

- [ ] **Step 4: Run to verify it passes**

Run: `make -C anope/m_webrtc_chat/tests test`
Expected: PASS (pure builder; libcurl path excluded — `WVC_HAVE_CURL` undefined in the test build).

- [ ] **Step 5 (optional, if `curl/curl.h` present): compile-check the libcurl path**

Run: `g++ -std=c++17 -DWVC_HAVE_CURL -I anope/m_webrtc_chat -fsyntax-only anope/m_webrtc_chat/core/provision.h` (only if `pkg-config --exists libcurl`).
Expected: compiles clean. If `curl/curl.h` is absent on the build host, SKIP and note it — the deployment build provides it.

- [ ] **Step 6: Commit**
```bash
git add anope/m_webrtc_chat/core/provision.h anope/m_webrtc_chat/tests/
git commit -m "feat(anope): provision body builder + libcurl POST (guarded)"
```

---

> **Tasks 7–9 are the Anope 2.1 glue.** No Anope SDK exists on the build host, so these are **written to the documented Anope 2.1 API, reviewed for API correctness, and compiled in the SwiftIRC Anope tree** — not host-CI'd. Each task's "test" step is: (a) the pure-core tests still pass, and (b) a review-gate against the real `anope/include/*.h` in the deployment tree. Every glue task MUST mark, with an inline `// VERIFY(anope-2.1):` comment, each API call whose exact signature the implementer confirmed against the deployment headers (fantasy hook, `Extensible`, config block, `Command` registration, message sending). The reviewer checks those against `include/modules.h`, `include/channels.h`, `include/commands.h`, `include/config.h`, and an existing 2.1 module (e.g. `modules/chanserv/cs_set.cpp`) in the SwiftIRC tree.

---

### Task 7: Anope glue — config load + per-channel settings + slug registry

**Files:**
- Create: `anope/m_webrtc_chat/m_webrtc_chat.cpp` (settings + config portion; commands added in Tasks 8–9)

**Interfaces:**
- Consumes: core headers (`build.h`, `token.h`, `provision.h`).
- Produces (in-module): a `Settings` extension on `ChannelInfo` carrying `{ bool enabled; bool identifiedOnly; Anope::string room; }`; a module-owned `std::map<Anope::string /*slug*/, Anope::string /*channel*/>` slug registry rebuilt on load and kept in sync; config accessors `secret()`, `baseUrl()` (provision target, e.g. `http://127.0.0.1:8080`), `urlOrigin()` (public link origin, e.g. `https://vc.swiftirc.net`), `defaultSlug(channel)`.

- [ ] **Step 1: Module skeleton + config**

Write the module class deriving from `Module`, with `MODULE_INIT(WebRTCChat)`. In the constructor set `Author`, `Version`, `SetType(THIRD)`. Implement `void OnReload(Configuration::Conf* conf) override` reading `conf->GetModule(this)` for `secret`, `apiurl` (provision base), `linkorigin`, and `ttl` (default 600). Store in members. `// VERIFY(anope-2.1): Configuration::Block::Get<Anope::string> API + OnReload signature.`

- [ ] **Step 2: Settings extension + persistence**

Define `struct Settings final : Serialize::Object { bool enabled=false, identifiedOnly=false; Anope::string room; }` OR an `ExtensibleItem<Settings>` on `ChannelInfo`, whichever the 2.1 tree uses for persisted per-channel data (check `cs_set.cpp`). Implement `Settings* settingsFor(ChannelInfo* ci, bool create)`. Persist via the channel's serialization so settings survive restarts. `// VERIFY(anope-2.1): Extensible/Serialize API for persisted per-channel state.`

- [ ] **Step 3: Slug registry + default slug**

`Anope::string defaultSlug(const Anope::string& channel)`: strip a leading `#`, lowercase, replace any char outside `[a-z0-9-]` with `-`, collapse repeats, trim leading/trailing `-`; if empty, fall back to a channel-hash suffix. Build `slugOwners` (`slug -> channel`) by iterating registered channels' settings on load. Provide `bool slugTaken(slug, exceptChannel)`.

- [ ] **Step 4: Manual verification note (no host compile)**

Because there is no host Anope build: confirm the pure-core tests still pass (`make -C anope/m_webrtc_chat/tests test`), and record in the task report the exact `// VERIFY(anope-2.1):` sites for the reviewer. Deployment build check: `cd <anope-src> && ./Config && make` after copying the module — documented in Task 10, run at deploy time.

- [ ] **Step 5: Commit**
```bash
git add anope/m_webrtc_chat/m_webrtc_chat.cpp
git commit -m "feat(anope): config, channel settings persistence, slug registry"
```

---

### Task 8: Anope glue — `VC` command (`SET ENABLED|IDENTIFIED|ROOM`)

**Files:**
- Modify: `anope/m_webrtc_chat/m_webrtc_chat.cpp`

**Interfaces:**
- Consumes: Task 7's `Settings`, `slugTaken`, `defaultSlug`.
- Produces: a `Command` `chanserv/vc` handling `VC #chan SET <ENABLED|IDENTIFIED|ROOM> <value>` plus `VC #chan` (show current). Op/founder-gated.

- [ ] **Step 1: Command class + registration**

Subclass `Command` (`chanserv/vc`), `SetDesc`, `SetSyntax("\002SET\002 \037#channel\037 ...")`. Register as a service reference to ChanServ. `// VERIFY(anope-2.1): Command base + service registration + OnPreCommand/permission helpers.`

- [ ] **Step 2: Permission gate**

Resolve `ChannelInfo* ci` from the channel arg; require `source.AccessFor(ci).HasPriv("SET")` or founder. On failure, `source.Reply(ACCESS_DENIED)` and return. `// VERIFY(anope-2.1): AccessFor / HasPriv("SET") privilege name.`

- [ ] **Step 3: SET ENABLED / IDENTIFIED**

Parse `ON|OFF` (case-insensitive). `ENABLED` toggles `Settings::enabled`; `IDENTIFIED` toggles `identifiedOnly`. Persist. Reply with the new state. Reject unknown values with the syntax hint.

- [ ] **Step 4: SET ROOM <slug>**

Normalize the requested slug (lowercase; must match `^[a-z0-9][a-z0-9-]*$`). Reject invalid slugs. If `slugTaken(slug, thisChannel)`, reply "that room name is taken by another channel." Otherwise set `Settings::room`, update the registry, persist, reply confirming the new public link `urlOrigin()/slug`.

- [ ] **Step 5: `VC #chan` (no SET) — show settings**

Reply with enabled/identified/room + the public URL. Anyone in the channel may view.

- [ ] **Step 6: Verify + commit**

Pure-core tests still green; record `// VERIFY` sites.
```bash
git add anope/m_webrtc_chat/m_webrtc_chat.cpp
git commit -m "feat(anope): VC SET command (ENABLED/IDENTIFIED/ROOM, op-gated)"
```

---

### Task 9: Anope glue — `!vc`/`!chat` fantasy + `/msg ChanServ VC` + token + provision

**Files:**
- Modify: `anope/m_webrtc_chat/m_webrtc_chat.cpp`

**Interfaces:**
- Consumes: Tasks 5–8 (`makeClaims`, `sign`, `buildProvisionBody`, `postProvision`, `Settings`).
- Produces: fantasy handling for `!vc` and `!chat`; the same logic reachable via `/msg ChanServ VC #chan`; token minting for identified users; provision POST.

- [ ] **Step 1: Fantasy hook**

Implement the 2.1 fantasy event (`OnBotFantasy(source, command, ci, params)` or the module's fantasy `Command` variant) matching `vc` and `chat`. `// VERIFY(anope-2.1): fantasy hook name/signature (BotFantasy) in include/modules.h.`

- [ ] **Step 2: Resolve room + enabled gate**

From `ci`'s `Settings`: if missing or `!enabled`, reply in-channel "video chat isn't enabled here — an op can run \002VC #chan SET ENABLED ON\002." Otherwise compute `slug = Settings::room` (or `defaultSlug` if unset).

- [ ] **Step 3: Public URL (in-channel)**

Reply in the channel with `urlOrigin()/slug` (the public link, no token). Everyone sees it.

- [ ] **Step 4: Tokened personal link (NOTICE)**

If the invoker is identified with NickServ (`source.GetAccount()` non-null): determine the invoker's role from channel access — founder/op-priv → `Role::Op`, voice → `Role::Voice`, else `Role::User`. `makeClaims(ci->name, slug, account, nick, role, Settings::identifiedOnly, Anope::CurTime, ttl())` → `sign(claims, secret())` → build `urlOrigin()/slug#t=<token>`. Assert length fits one NOTICE line; NOTICE it privately. If NOT identified, NOTICE "identify to NickServ for a personal (op) link; the public link above works for guests" (unless `identifiedOnly`, in which case say guests can't join). `// VERIFY(anope-2.1): account/access lookups + SendMessage/notice.`

- [ ] **Step 5: Provision POST (best-effort)**

Build `buildProvisionBody(ci->name, slug, Settings::identifiedOnly)` and `postProvision(baseUrl(), secret(), body, /*timeoutMs=*/2000, err)`. On failure, log at debug and NOTICE the invoker "room link posted, but the video server is unreachable right now." Never block the command on the POST beyond the timeout. `// VERIFY(anope-2.1): logging + CurTime.`

- [ ] **Step 6: `/msg ChanServ VC #chan` parity**

Ensure the plain `VC #chan` command (Task 8, no SET args) ALSO performs Steps 2–5 (link + token + provision), so botless channels work. Factor Steps 2–5 into a shared helper called by both the fantasy hook and the command.

- [ ] **Step 7: Verify + commit**

Pure-core tests green; record `// VERIFY` sites.
```bash
git add anope/m_webrtc_chat/m_webrtc_chat.cpp
git commit -m "feat(anope): !vc/!chat fantasy + token mint + provision POST"
```

---

### Task 10: Config example, install/build docs, cross-impl test notes

**Files:**
- Create: `anope/m_webrtc_chat/anope.conf.example`
- Modify: `anope/m_webrtc_chat/README.md`

- [ ] **Step 1: anope.conf example**

`anope/m_webrtc_chat/anope.conf.example`:
```
module {
    name = "m_webrtc_chat"
    /* Shared HMAC secret — MUST equal webrtc-chat's -secret / WVC_SECRET. */
    secret = "change-me-to-a-long-random-value"
    /* Where the module POSTs provision snapshots (server-local, plaintext ok). */
    apiurl = "http://127.0.0.1:8080"
    /* Public origin used to build room links handed to users. */
    linkorigin = "https://vc.swiftirc.net"
    /* Token lifetime in seconds (time to click the link). */
    ttl = 600
}
```

- [ ] **Step 2: README — build/install against Anope 2.1**

Document: copy `m_webrtc_chat.cpp` + `core/` into `<anope-src>/modules/third/`, add libcurl+OpenSSL to the module's link flags (a `// REQUIRE:` / `conf/modules.conf` note, or the 2.1 per-module build pragma — `// VERIFY(anope-2.1): third-module build flag mechanism`), then `./Config && make && make install`. Enable the module + paste the config block. Restart services.

- [ ] **Step 3: README — cross-impl test notes**

Document the interop guarantee: the C++ `sign` reproduces `internal/token/testdata/vectors.json` byte-for-byte (host test), so any token the module mints validates in Go `token.Verify`. To re-verify after a change: `make -C anope/m_webrtc_chat/tests test`. If the Go `Claims` shape or key order ever changes, update `claims.h` + the vectors together.

- [ ] **Step 4: README — deployment smoke test**

Document a manual end-to-end check: run webrtc-chat with `-secret <s>`, set the same secret in `anope.conf`, `VC #chan SET ENABLED ON`, run `!vc` in-channel, confirm (a) the public link appears, (b) identified users get a `#t=` NOTICE, (c) `/api/provision` logged "provisioned", (d) clicking the tokened link joins with the right role/badge.

- [ ] **Step 5: Commit**
```bash
git add anope/m_webrtc_chat/anope.conf.example anope/m_webrtc_chat/README.md
git commit -m "docs(anope): config example, install + cross-impl test notes"
```

---

## Notes for the executing agent

- **Tasks 1–6 are fully host-testable** — every one ends green under `make -C anope/m_webrtc_chat/tests test` on this machine. Treat any failure to reproduce a vector as a real bug in the core, not a vector problem.
- **Tasks 7–9 cannot be compiled here** (no Anope SDK). Do NOT fake a passing build. Each glue task's deliverable is reviewed source plus a report listing its `// VERIFY(anope-2.1):` sites; the reviewer checks those against the deployment headers. If a signature can't be confirmed from the spec/plan, leave the `// VERIFY` marker and flag it in the report rather than guessing silently.
- **Secret handling:** never `log`/`Reply` the shared secret or a full token except in the private NOTICE to its own recipient.
- **DRY:** Steps 2–5 of Task 9 and the `VC #chan` command (Task 8 Step 5) share one helper — write it once.
