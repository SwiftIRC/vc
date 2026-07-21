#pragma once
#include "testing.h"
#include "core/provision.h"
inline void test_provision() {
  check_eq(wvc::buildProvisionBody("#swift", "swift", true),
    "{\"channel\":\"#swift\",\"room\":\"swift\",\"settings\":{\"identifiedOnly\":true}}",
    "provision body identified");
  check_eq(wvc::buildProvisionBody("#help", "help", false),
    "{\"channel\":\"#help\",\"room\":\"help\",\"settings\":{\"identifiedOnly\":false}}",
    "provision body guests-ok");
}
