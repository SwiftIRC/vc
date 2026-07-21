#pragma once
#include <string>
#include <cstdio>
namespace wvc {
inline std::string jsonEscape(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 2);
  for (unsigned char ch : s) {
    switch (ch) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      case '\b': out += "\\b";  break;
      case '\f': out += "\\f";  break;
      case '<':  out += "\\u003c"; break; // Go encoding/json HTML-safe defaults
      case '>':  out += "\\u003e"; break;
      case '&':  out += "\\u0026"; break;
      default:
        if (ch < 0x20) { char buf[8]; std::snprintf(buf, sizeof buf, "\\u%04x", ch); out += buf; }
        else out += static_cast<char>(ch);
    }
  }
  return out;
}
} // namespace wvc
