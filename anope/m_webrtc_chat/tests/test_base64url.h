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
