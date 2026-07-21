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
