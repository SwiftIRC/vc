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
