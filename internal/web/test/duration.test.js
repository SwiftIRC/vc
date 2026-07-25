import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../assets/lib/duration.js";

test("formatDuration under an hour is M:SS with padded seconds", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(5), "0:05");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(600), "10:00");
  assert.equal(formatDuration(3599), "59:59");
});

test("formatDuration at/after an hour rolls over to H:MM:SS", () => {
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatDuration(36000), "10:00:00");
});

test("formatDuration clamps negatives and floors fractions", () => {
  assert.equal(formatDuration(-5), "0:00");
  assert.equal(formatDuration(65.9), "1:05");
});
