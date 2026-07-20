import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode, parseToken } from "../assets/lib/protocol.js";

test("encode injects type", () => {
  assert.equal(encode("join", { name: "alice" }), JSON.stringify({ type: "join", name: "alice" }));
  assert.equal(encode("leave"), JSON.stringify({ type: "leave" }));
});

test("decode round-trips and requires a type", () => {
  assert.deepEqual(decode('{"type":"chat","from":"a","text":"hi","ts":1}'), { type: "chat", from: "a", text: "hi", ts: 1 });
  assert.throws(() => decode("not json"));
  assert.throws(() => decode('{"no":"type"}'));
});

test("parseToken reads the URL fragment", () => {
  assert.equal(parseToken("#t=abc.def"), "abc.def");
  assert.equal(parseToken("#foo=1&t=xy.z"), "xy.z");
  assert.equal(parseToken(""), "");
  assert.equal(parseToken("#nothing"), "");
});
