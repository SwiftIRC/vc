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
