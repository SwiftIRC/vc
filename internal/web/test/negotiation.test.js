import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRemoteOffer } from "../assets/lib/negotiation.js";

test("no collision → answer", () => {
  assert.deepEqual(handleRemoteOffer({ makingOffer: false, signalingState: "stable" }), { action: "answer" });
});

test("collision while making an offer → polite rolls back then answers", () => {
  assert.deepEqual(handleRemoteOffer({ makingOffer: true, signalingState: "stable" }), { action: "rollback-then-answer" });
});

test("collision because not stable → rollback then answer", () => {
  assert.deepEqual(handleRemoteOffer({ makingOffer: false, signalingState: "have-local-offer" }), { action: "rollback-then-answer" });
});
