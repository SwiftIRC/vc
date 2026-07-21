#pragma once
#include <string>
#include <openssl/rand.h>
#include "base64url.h"
#include "json_escape.h"
#ifdef WVC_HAVE_CURL
#include <curl/curl.h> // at global scope: a system header must never be pulled into namespace wvc
#endif
namespace wvc {

// randomId returns a 128-bit, URL-safe opaque id (base64url of 16 random bytes = 22
// chars). It is the #i= invite id: unguessable, so holding it is holding the invite.
// Returns "" if the RNG fails (the caller then falls back to the long token link).
inline std::string randomId() {
  unsigned char buf[16];
  if (RAND_bytes(buf, sizeof buf) != 1) {
    return std::string();
  }
  return b64url(buf, sizeof buf);
}

// buildInviteBody is the /api/invite request body: {"id":..,"token":..}. Pure, so it
// is host-tested; id/token are base64url so nothing needs escaping, but jsonEscape is
// applied for safety (mirrors buildProvisionBody).
inline std::string buildInviteBody(const std::string& id, const std::string& token) {
  return "{\"id\":\"" + jsonEscape(id) + "\",\"token\":\"" + jsonEscape(token) + "\"}";
}

#ifdef WVC_HAVE_CURL
// POST {id, token} to {baseUrl}/api/invite with Bearer auth, registering the invite so
// the link can be origin/slug#i=<id>. Same best-effort contract as postProvision:
// returns false (and sets errOut) on transport error or non-2xx; timeoutMs bounds the
// whole request so services never block on a down webrtc-chat.
inline bool postInvite(const std::string& baseUrl, const std::string& secret,
                       const std::string& id, const std::string& token, long timeoutMs,
                       std::string& errOut) {
  CURL* h = curl_easy_init();
  if (!h) { errOut = "curl init"; return false; }
  std::string url = baseUrl + "/api/invite";
  std::string body = buildInviteBody(id, token);
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
