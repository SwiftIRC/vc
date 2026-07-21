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
