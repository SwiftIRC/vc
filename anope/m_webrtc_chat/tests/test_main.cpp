#include "testing.h"
#include "test_base64url.h"
// Each later task adds: void test_<unit>(); called from main() below.
int main() {
  check(true, "harness runs");
  test_base64url();
  if (g_failures) { std::cerr << g_failures << " failure(s)\n"; return 1; }
  std::cout << "ok\n";
  return 0;
}
