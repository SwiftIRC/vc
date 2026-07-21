// Pure wire protocol: JSON frames of {type, ...fields}. No browser globals.
export function encode(type, fields = {}) {
  return JSON.stringify({ type, ...fields });
}

export function decode(text) {
  const msg = JSON.parse(text);
  if (!msg || typeof msg.type !== "string") throw new Error("frame missing type");
  return msg;
}

// parseToken extracts the "t" value from a URL fragment like "#t=abc.def".
export function parseToken(fragment) {
  return parseFragmentParam(fragment, "t");
}

// parseInvite reads the short invite id from a fragment like "#i=abc123". This is the
// compact link form (`!vc` registers the token server-side under this id), replacing
// the long "#t=<token>" link that wrapped and truncated in IRC.
export function parseInvite(fragment) {
  return parseFragmentParam(fragment, "i");
}

function parseFragmentParam(fragment, key) {
  const hash = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  for (const pair of hash.split("&")) {
    const [k, v] = pair.split("=");
    if (k === key && v) return v;
  }
  return "";
}
