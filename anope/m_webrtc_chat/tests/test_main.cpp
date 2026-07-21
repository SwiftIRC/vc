#include "testing.h"
#include "test_base64url.h"
#include "test_claims.h"
#include "test_token.h"
#include "test_build.h"
#include "test_provision.h"
#include "test_invite.h"
// Each later task adds: void test_<unit>(); called from main() below.
int main() {
  check(true, "harness runs");
  test_base64url();
  test_claims();
  test_token();
  test_build();
  test_provision();
  test_invite();
  if (g_failures) { std::cerr << g_failures << " failure(s)\n"; return 1; }
  std::cout << "ok\n";
  return 0;
}
