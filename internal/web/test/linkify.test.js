import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSegments } from "../assets/lib/linkify.js";

// Convenience views over the segment list.
const plain = (s) => linkSegments(s).map((seg) => seg.text).join("");
const links = (s) => linkSegments(s).filter((seg) => seg.href);

test("text with no URL is one plain segment", () => {
  assert.deepEqual(linkSegments("hello there"), [{ text: "hello there" }]);
});

test("an http(s) URL becomes a link", () => {
  assert.deepEqual(links("see https://example.com/a?b=1#c"), [
    { text: "https://example.com/a?b=1#c", href: "https://example.com/a?b=1#c" },
  ]);
  assert.deepEqual(links("http://example.com"), [{ text: "http://example.com", href: "http://example.com" }]);
});

test("a bare www. link navigates over https but displays as typed", () => {
  assert.deepEqual(links("www.example.com/x"), [
    { text: "www.example.com/x", href: "https://www.example.com/x" },
  ]);
});

// The security property: the allowlist is the matcher, so a dangerous scheme is never
// matched and no href can ever carry one.
test("dangerous schemes are never linkified", () => {
  for (const hostile of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ]) {
    assert.deepEqual(links(hostile), [], `linkified ${hostile}`);
    assert.equal(plain(hostile), hostile, "text must survive verbatim");
  }
});

test("a scheme with no host is not a link", () => {
  assert.deepEqual(links("https:// is a prefix"), []);
  assert.deepEqual(links("www. is a prefix"), []);
});

test("bare domains are not linkified — a dev chat is full of filenames", () => {
  for (const s of ["app.js", "see grid.js line 4", "node.js", "README.md"]) {
    assert.deepEqual(links(s), [], `linkified ${s}`);
  }
});

test("sentence punctuation is not swallowed into the URL", () => {
  assert.deepEqual(links("go to https://example.com."), [
    { text: "https://example.com", href: "https://example.com" },
  ]);
  assert.deepEqual(links("https://example.com, then home"), [
    { text: "https://example.com", href: "https://example.com" },
  ]);
  assert.deepEqual(links('"https://example.com"'), [
    { text: "https://example.com", href: "https://example.com" },
  ]);
});

test("a closing paren belongs to the URL only when the URL opened it", () => {
  assert.deepEqual(links("(see https://example.com/a)"), [
    { text: "https://example.com/a", href: "https://example.com/a" },
  ]);
  assert.deepEqual(links("https://en.wikipedia.org/wiki/Kick_(disambiguation)"), [
    {
      text: "https://en.wikipedia.org/wiki/Kick_(disambiguation)",
      href: "https://en.wikipedia.org/wiki/Kick_(disambiguation)",
    },
  ]);
});

test("several URLs in one message all become links, in order", () => {
  const segs = linkSegments("a https://one.example b https://two.example c");
  assert.deepEqual(
    segs.map((s) => (s.href ? `L:${s.text}` : s.text)),
    ["a ", "L:https://one.example", " b ", "L:https://two.example", " c"],
  );
});

// Nothing is dropped or rewritten: the reader sees exactly what the sender typed.
test("segments always reconstruct the original text", () => {
  for (const s of [
    "",
    "plain",
    "https://example.com",
    "  https://example.com  ",
    "(https://example.com).",
    "a https://one.example b www.two.example c",
    "<img src=x onerror=alert(1)>",
    "https://example.com/<script>",
  ]) {
    assert.equal(plain(s), s, `round-trip failed for ${JSON.stringify(s)}`);
  }
});

test("non-string input is handled without throwing", () => {
  assert.deepEqual(linkSegments(null), []);
  assert.deepEqual(linkSegments(undefined), []);
  assert.deepEqual(linkSegments(42), [{ text: "42" }]);
});
