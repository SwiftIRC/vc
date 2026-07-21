#pragma once
#include "testing.h"
#include "core/token.h"
inline void test_token() {
  const std::string secret = "test-secret-0123456789abcdef"; // vectors.json secret
  wvc::Claims op{"#swift", "swift", "Ryan", "Ryan", "op", 1, 1753000000, 1753000600};
  check_eq(wvc::sign(op, secret),
    "eyJjIjoiI3N3aWZ0IiwiciI6InN3aWZ0IiwiYSI6IlJ5YW4iLCJuIjoiUnlhbiIsIm8iOiJvcCIsImYiOjEsImkiOjE3NTMwMDAwMDAsImUiOjE3NTMwMDA2MDB9.qPFYFM4RU3-42gHb1S58k1NDwZxbrs8XhSeBZcWV7xU",
    "valid-op token reproduces vector");
  wvc::Claims usr{"#help", "help", "alice", "alice|away", "user", 0, 1753000000, 1753000600};
  check_eq(wvc::sign(usr, secret),
    "eyJjIjoiI2hlbHAiLCJyIjoiaGVscCIsImEiOiJhbGljZSIsIm4iOiJhbGljZXxhd2F5IiwibyI6InVzZXIiLCJmIjowLCJpIjoxNzUzMDAwMDAwLCJlIjoxNzUzMDAwNjAwfQ.m1KQ-FVTN6tVKRXjrLFWzas6dRMEZKF6CUBoPVruE1s",
    "valid-user token reproduces vector");
  // Worst-case length budget (Go test ceiling = 320).
  wvc::Claims big{"#" + std::string(30, 'c'), std::string(30, 'r'),
                  std::string(30, 'a'), std::string(30, 'n'), "voice", 1, 1753000000, 1753000600};
  check(wvc::sign(big, secret).size() <= 320, "worst-case token within 320-char budget");
}
