import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay } from "../assets/lib/backoff.js";

test("backoff grows geometrically and caps", () => {
  assert.equal(backoffDelay(0), 500);
  assert.equal(backoffDelay(1), 1000);
  assert.equal(backoffDelay(2), 2000);
  assert.equal(backoffDelay(10), 10000); // capped at max
});
