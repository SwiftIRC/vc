// Split chat text into plain runs and link runs, so the renderer can build real
// <a> nodes without ever going near innerHTML. Pure string work: no DOM here.
//
// SECURITY: the allowlist IS the matcher. Only `http://`, `https://` and a bare
// `www.` are recognised as links, so no input can ever produce a `javascript:`,
// `data:` or `vbscript:` href — there is no filtering step to get wrong, because a
// dangerous scheme is never matched in the first place.
//
// Deliberately NOT matched: bare domains like "example.com". In a developer's chat
// that would turn "app.js", "node.js" and "grid.js" into links to Jersey.

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

// Punctuation that regularly ends a sentence rather than a URL.
const TRAILING = ".,;:!?'\"";

// Closers that only belong to the URL when the URL opened them — "(see https://x/a)"
// ends the link at the paren, but a Wikipedia "…/Foo_(bar)" keeps it.
const PAIRS = { ")": "(", "]": "[", "}": "{" };

function count(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// Give back the trailing characters that punctuate the sentence, not the URL.
function trimTrailingPunctuation(url) {
  for (;;) {
    const last = url[url.length - 1];
    if (!last) return url;
    if (TRAILING.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = PAIRS[last];
    if (opener && count(url, opener) < count(url, last)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

// Segments of `text` in order, each either { text } (plain) or { text, href } (link).
// Concatenating every segment's text always reproduces the input exactly — nothing is
// dropped or rewritten, so the reader sees what the sender typed.
export function linkSegments(text) {
  const src = String(text ?? "");
  const out = [];
  let at = 0;
  for (const m of src.matchAll(URL_RE)) {
    const raw = trimTrailingPunctuation(m[0]);
    if (!raw || raw === "www." || /^https?:\/\/$/i.test(raw)) continue; // a scheme with no host
    const start = m.index;
    if (start > at) out.push({ text: src.slice(at, start) });
    // A bare www. link has no scheme to navigate with; https is the safe assumption
    // (a site that only does http will redirect). The DISPLAYED text stays as typed.
    out.push({ text: raw, href: /^www\./i.test(raw) ? `https://${raw}` : raw });
    at = start + raw.length;
  }
  if (at < src.length) out.push({ text: src.slice(at) });
  return out;
}
