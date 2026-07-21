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
