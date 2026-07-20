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
  const hash = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  for (const pair of hash.split("&")) {
    const [k, v] = pair.split("=");
    if (k === "t" && v) return v;
  }
  return "";
}
