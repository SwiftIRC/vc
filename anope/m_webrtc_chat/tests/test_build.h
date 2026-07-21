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
