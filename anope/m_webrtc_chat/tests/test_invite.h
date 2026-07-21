#pragma once
#include "testing.h"
#include "core/invite.h"
inline void test_invite() {
  // Body shape matches webrtc-chat's /api/invite decoder: {"id":..,"token":..}.
  check_eq(wvc::buildInviteBody("abc123", "eyJ.sig"),
    "{\"id\":\"abc123\",\"token\":\"eyJ.sig\"}",
    "invite body");
  // randomId: 16 bytes -> 22 base64url chars, URL-safe alphabet, and distinct per call.
  const std::string a = wvc::randomId();
  const std::string b = wvc::randomId();
  check(a.size() == 22, "randomId length 22");
  check(a != b, "randomId is not constant");
  for (char c : a) {
    const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
    check(ok, "randomId is URL-safe base64url");
  }
}
