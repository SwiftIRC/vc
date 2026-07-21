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
