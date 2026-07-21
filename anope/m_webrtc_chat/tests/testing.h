#pragma once
#include <string>
#include <iostream>
inline int g_failures = 0;
inline void check(bool ok, const std::string& msg) {
  if (!ok) { std::cerr << "FAIL: " << msg << "\n"; ++g_failures; }
}
inline void check_eq(const std::string& got, const std::string& want, const std::string& msg) {
  if (got != want) {
    std::cerr << "FAIL: " << msg << "\n  got:  " << got << "\n  want: " << want << "\n";
    ++g_failures;
  }
}
