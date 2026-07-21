// Top-level routing and state for the browser client. app.js owns the singleton
// Media / Signaling / Peer instances and hands them to the UI modules; it never
// draws call chrome itself beyond a deliberate placeholder.
//
// Routes off the URL:
//   /            -> home: pick a room name, navigate to /<name>
//   /<slug>      -> pre-join lobby (ui/prejoin.js); #t=<token> supplies identity
// A successful join swaps the lobby for an in-call placeholder that wires up the
// media plane (Peer) so the transition is real; Tasks 8-9 replace that placeholder
// with the real grid / controls / chat.
import { Signaling } from "./net/signaling.js";
import { Media } from "./net/media.js";
import { Peer } from "./net/peer.js";
import { parseToken } from "./lib/protocol.js";
import { Prejoin } from "./ui/prejoin.js";

// Mirror of the server's room-slug rule (internal/server: slugRe). A path that
// doesn't match can never join, so we route it to home with a hint instead.
const SLUG_RE = /^[a-z0-9-]{1,32}$/;

const root = document.getElementById("app");

// Live top-level state. slug/token are fixed for the page load; the rest are
// (re)created as the user moves lobby -> call -> lobby.
let slug = "";
let token = "";
let media = null;
let signaling = null;
let peer = null;
let prejoin = null;

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

// Turn free-typed room text into a valid slug (lowercase, [a-z0-9-], <=32).
function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function boot() {
  slug = location.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  token = parseToken(location.hash);
  if (!slug) {
    renderHome();
    return;
  }
  if (!SLUG_RE.test(slug)) {
    renderHome(`"${slug}" isn't a valid room name.`);
    return;
  }
  renderPrejoin();
}

// --- home ---

function renderHome(message) {
  const input = el("input", { class: "name", type: "text", placeholder: "room name", autocomplete: "off", maxlength: "32" });
  const error = el("p", { class: "error", role: "alert", text: message || "" });
  const go = () => {
    const s = slugify(input.value);
    if (!s) {
      error.textContent = "Enter a room name (letters, numbers, hyphens).";
      input.focus();
      return;
    }
    location.assign(`/${s}`); // reloads; boot() then renders the lobby
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  root.replaceChildren(
    el(
      "div",
      { class: "home" },
      el("h1", { text: "webrtc-chat" }),
      el("p", { class: "lede", text: "Enter a room name to start or join a call." }),
      el("div", { class: "row" }, input, el("button", { class: "join", type: "button", onClick: go }, "Go")),
      error,
    ),
  );
  input.focus();
}

// --- pre-join ---

function renderPrejoin() {
  media = new Media();
  prejoin = new Prejoin({ root, slug, token, media, onJoin });
  prejoin.mount().catch((err) => console.error("prejoin mount failed", err));
}

// Fired by the lobby's Join button. Opens a fresh socket, sends the join frame,
// and routes the server's reply. A prior socket (from a rejected attempt) is
// stopped first so its close can't trigger a reconnect.
function onJoin({ name, password }) {
  if (signaling) signaling.stop();
  signaling = new Signaling(`/ws/${slug}`);
  signaling.on("joined", onJoined);
  signaling.on("error", onServerError);
  signaling.connect();
  signaling.send("join", { name, password, token }); // queued until the socket opens
}

// Server refused the join (bad-password, banned, identified-only, ...). Stop the
// socket so it does not reconnect into an empty (join-less) handshake, and hand
// the code back to the still-mounted lobby.
function onServerError(msg) {
  if (signaling) {
    signaling.stop();
    signaling = null;
  }
  if (prejoin) prejoin.showError(msg.code, msg.message);
}

function onJoined(msg) {
  if (prejoin) {
    prejoin.destroy();
    prejoin = null;
  }
  renderInCall(msg);
}

// --- in-call placeholder (Tasks 8-9 replace this) ---

// Brings the media plane up on the live socket and shows a minimal call view:
// the local preview, who's here, and any forwarded remote streams. No grid,
// controls, or chat yet — just enough that the join is provably real.
function renderInCall(msg) {
  const localVideo = el("video", { class: "preview", autoplay: true, muted: true, playsinline: true });
  localVideo.muted = true;
  if (media && media.stream) localVideo.srcObject = media.stream;

  const remotes = el("div", { class: "remotes" });
  const remoteEls = new Map(); // participantId:kind -> <video>

  const peerList = el("ul", { class: "peers" });
  const renderPeers = (peers) => {
    peerList.replaceChildren(
      ...(peers || []).map((p) => el("li", {}, `${p.name || "guest"} — ${p.role}`)),
    );
    if (!peers || peers.length === 0) peerList.append(el("li", { class: "muted", text: "no one else yet" }));
  };
  renderPeers(msg.peers);

  const leaveBtn = el("button", { class: "leave", type: "button", onClick: leave }, "Leave");

  root.replaceChildren(
    el(
      "div",
      { class: "incall" },
      el("h1", { text: `In #${slug}` }),
      el("p", { class: "self", text: `You are ${msg.selfId} (${msg.role})` }),
      localVideo,
      el("h2", { text: "In call" }),
      peerList,
      remotes,
      leaveBtn,
    ),
  );

  // Media plane. Peer registers its own offer/answer/candidate/tracks handlers in
  // its constructor; that must happen before start() sends the first offer, and
  // synchronously here so it precedes any inbound SFU frame on this socket.
  peer = new Peer(signaling);

  peer.addEventListener("remote-track", (e) => {
    const { participantId, kind, stream } = e.detail;
    const key = `${participantId}:${kind}`;
    let v = remoteEls.get(key);
    if (!v) {
      v = el("video", { class: "remote", autoplay: true, playsinline: true });
      remoteEls.set(key, v);
      remotes.append(v);
    }
    v.srcObject = stream;
  });
  peer.addEventListener("peer-gone", (e) => {
    const key = `${e.detail.participantId}:${e.detail.kind}`;
    const v = remoteEls.get(key);
    if (v) {
      v.srcObject = null;
      v.remove();
      remoteEls.delete(key);
    }
  });
  peer.addEventListener("error", (e) => console.error("peer error", e.detail.phase, e.detail.error));

  // Live roster upkeep for the placeholder list (best-effort; Task 8 owns the grid).
  signaling.on("peer-joined", (m) => {
    peerList.querySelector(".muted")?.remove();
    peerList.append(el("li", {}, `${m.name || "guest"} — ${m.role}`));
  });

  const localTracks = [];
  if (media && media.cameraTrack) localTracks.push({ track: media.cameraTrack, kind: "camera" });
  if (media && media.micTrack) localTracks.push({ track: media.micTrack, kind: "mic" });
  peer.start(localTracks).catch((err) => console.error("peer start failed", err));
}

// Full teardown back to the lobby: close the peer, stop the socket permanently,
// release the camera/mic, then re-render pre-join with a fresh Media.
function leave() {
  if (peer) {
    peer.close();
    peer = null;
  }
  if (signaling) {
    signaling.stop();
    signaling = null;
  }
  if (media) {
    media.stop();
    media = null;
  }
  renderPrejoin();
}

console.log("webrtc-chat loaded");
boot();
