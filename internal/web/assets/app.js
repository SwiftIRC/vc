// Top-level routing, state, and the reliability contract for the browser client.
// app.js owns the singleton Media / Signaling / Peer instances and hands them to
// the UI modules (prejoin, grid, controls, chat); it never draws call chrome
// itself beyond the terminal "you were removed" card.
//
// Routes off the URL:
//   /            -> home: pick a room name, navigate to /<name>
//   /<slug>      -> pre-join lobby (ui/prejoin.js); #t=<token> supplies identity
// A successful join swaps the lobby for the in-call view: the tile grid
// (ui/grid.js), the control bar (ui/controls.js), and the chat panel (ui/chat.js),
// wired to the media plane (Peer) and the live socket (Signaling).
//
// Reliability contract (see onRemoved / onJoined / rejoinOnReopen):
//   - kicked / banned  -> stop() the socket (NO reconnect), tear the call down,
//     show why. The suppressed reconnect is exactly what Plan 2's ban enforcement
//     relies on: a removed client MUST NOT rejoin.
//   - normal drop / server-restarting -> Signaling reconnects with backoff and we
//     re-send the join frame on reopen, so the participant returns to the room.
//   - leave / tab close -> stop() the socket and release the camera/mic.
import { Signaling } from "./net/signaling.js";
import { Media } from "./net/media.js";
import { Peer } from "./net/peer.js";
import { parseToken, parseInvite } from "./lib/protocol.js";
import { playSound } from "./lib/sounds.js";
import { Prejoin } from "./ui/prejoin.js";
import { Grid } from "./ui/grid.js";
import { Controls } from "./ui/controls.js";
import { Chat } from "./ui/chat.js";

// Mirror of the server's room-slug rule (internal/server: slugRe). A path that
// doesn't match can never join, so we route it to home with a hint instead.
const SLUG_RE = /^[a-z0-9-]{1,32}$/;

const root = document.getElementById("app");

// Live top-level state. slug/token are fixed for the page load; the rest are
// (re)created as the user moves lobby -> call -> lobby.
let slug = "";
let token = ""; // long-link identity token (#t=); still accepted for old links
let invite = ""; // short invite id (#i=), resolved server-side — the current link form
let selfName = ""; // display name chosen in the lobby; labels the self tile
let pendingJoin = null; // {name, password, token, invite, session} re-sent on every socket (re)open
let media = null;
let signaling = null;
let peer = null;
let prejoin = null;
let grid = null;
let controls = null;
let chat = null;
let statusEl = null; // in-call "Reconnecting…" indicator (null when not in-call)
let mediaAlertEl = null; // in-call "media connection lost" prompt (null when not in-call)

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
  invite = parseInvite(location.hash);
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
  document.body.classList.remove("in-call");
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
      el("h1", { text: "SwiftIRC VC" }),
      el("p", { class: "lede", text: "Enter a room name to start or join a call." }),
      el("div", { class: "row" }, input, el("button", { class: "join", type: "button", onClick: go }, "Go")),
      error,
    ),
  );
  input.focus();
}

// --- pre-join ---

function renderPrejoin() {
  document.body.classList.remove("in-call");
  media = new Media();
  prejoin = new Prejoin({ root, slug, token, invite, media, onJoin });
  prejoin.mount().catch((err) => console.error("prejoin mount failed", err));
}

// Fired by the lobby's Join button. Opens a fresh socket and registers the whole
// inbound contract, then lets rejoinOnReopen send the join frame once the socket
// opens (and re-send it on every backoff reconnect). A prior socket (from a
// rejected attempt) is stopped first so its close can't trigger a reconnect.
function onJoin({ name, password }) {
  selfName = name || "";
  // token and invite are page-fixed; whichever is present is the identity. session
  // binds a #i= invite to this tab so it's single-use (see sessionNonce).
  pendingJoin = { name, password, token, invite, session: sessionNonce() };
  if (signaling) signaling.stop();
  signaling = new Signaling(`/ws/${slug}`);
  signaling.on("joined", onJoined);
  signaling.on("error", onServerError);
  // The removal contract: a kicked/banned client must close and never rejoin.
  signaling.on("kicked", (m) => onRemoved("kicked", m && m.by));
  signaling.on("banned", (m) => onRemoved("banned", m && m.by));
  // A planned restart: the socket is about to drop. Show a notice but do NOT
  // stop() — Signaling's backoff reconnect + rejoinOnReopen bring us back.
  signaling.on("server-restarting", () => showReconnecting(true));
  rejoinOnReopen(signaling);
  signaling.connect(); // rejoinOnReopen's open hook sends the first join
}

// A per-tab opaque nonce that binds a used #i= invite to THIS browser session, so the
// link is single-use for everyone else while our own reconnects keep working. Stored in
// sessionStorage: it survives a page refresh in this tab, but a different tab gets a
// different nonce and is correctly locked out of an already-used invite. Falls back to
// "" (no binding — the server then leaves the invite reusable) if storage/crypto is
// unavailable; WebRTC's secure-context requirement makes that vanishingly rare.
function sessionNonce() {
  try {
    let n = sessionStorage.getItem("vc-session");
    if (!n) {
      n = crypto.randomUUID();
      sessionStorage.setItem("vc-session", n);
    }
    return n;
  } catch {
    return "";
  }
}

// Re-send the join frame on every socket (re)open. signaling.js intentionally
// exposes no socket-lifecycle hook (and is outside this task's file set), so we
// compose one: wrap connect() so each time it (re)creates the socket — the
// initial connect AND every backoff reconnect — we attach an "open" listener
// that sends the current join frame. Without this a mid-call reconnect leaves the
// user connected but roomless (the Task-7 gap). Because kicked/banned/leave all
// stop() the socket, connect() is never called again after them and this never
// re-joins — the security-critical property.
function rejoinOnReopen(sig) {
  const connect = sig.connect.bind(sig);
  sig.connect = () => {
    connect(); // creates sig.ws (or no-ops once stopped)
    if (sig.ws) sig.ws.addEventListener("open", () => sig.send("join", { ...pendingJoin, ...joinMediaState() }));
  };
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

// The server accepted our join. First time: build the in-call view. On a reconnect
// re-join (we're already in-call) do NOT rebuild — Signaling has no off() so a
// fresh Peer/Chat would leak handlers on the shared socket — just clear the
// reconnecting notice, replace the replayed chat history, and reconcile the roster.
function onJoined(msg) {
  showReconnecting(false);
  if (grid) {
    if (chat) chat.clear(); // the server replays chat on re-join; clear so it doesn't double up
    for (const p of msg.peers || []) addRosterPeer(p);
    return;
  }
  if (prejoin) {
    prejoin.destroy();
    prejoin = null;
  }
  renderInCall(msg);
}

// Add/refresh a peer's tile from a roster entry (joined.peers[] or peer-joined) and
// seed its authoritative mic/camera indicators from the same entry, so a tile starts
// with the correct mute state. This is how a LATE joiner learns that an existing peer
// is already muted (the server carries each peer's stored state in the roster).
function addRosterPeer(p) {
  if (!grid || !p) return;
  grid.addPeer(p);
  grid.setPeerMedia(p.id, { mic: p.mic, camera: p.camera });
}

// This client's current mic/camera state, merged into every join frame so the room
// stores the real state BEFORE it builds the roster and broadcasts peer-joined — a
// pre-join (or reconnect-time) mute then reaches other peers with no "briefly
// un-muted" flash. Reads the shared media singleton directly rather than via controls,
// because the first join frame is sent (on socket open) before renderInCall creates
// controls; the convention matches controls.sendMediaState — an absent or disabled
// track counts as OFF.
function joinMediaState() {
  return {
    mic: !!(media && media.micTrack && media.micTrack.enabled),
    camera: !!(media && media.cameraTrack && media.cameraTrack.enabled),
  };
}

// --- in-call view: tile grid + control bar + chat ---

// Brings the media plane up on the live socket and renders the real in-call UI:
// the tile grid (self + remotes, screen-shares, active-speaker), the control bar
// (local mute/camera/screenshare/leave, plus op moderation), and the chat panel.
function renderInCall(msg) {
  // Media plane. Peer registers its own offer/answer/candidate/tracks handlers in
  // its constructor; that must happen before start() sends the first offer, and
  // synchronously here so it precedes any inbound SFU frame on this socket.
  peer = new Peer(signaling);

  // Controls first: the grid asks it for each remote tile's op-action group.
  controls = new Controls({ media, peer, signaling, role: msg.role, onLeave: leave });
  grid = new Grid({
    selfId: msg.selfId,
    selfName,
    selfRole: msg.role,
    media,
    opActionsFor: (p) => controls.opActionsFor(p),
    screenOpActionsFor: (p) => controls.screenOpActionsFor(p),
  });
  controls.attachGrid(grid); // toggles refresh the self tile's indicators
  chat = new Chat({ signaling });
  controls.attachChat(chat); // chat starts hidden; the control-bar toggle reveals it

  statusEl = el("span", { class: "call-status", role: "status", hidden: true });
  // A separate, persistent signal from the "Reconnecting…" one: the media transport
  // failed and could not self-heal, so the only fix is a reload. role="alert" so it
  // is announced; it is not cleared by a socket reconnect (that's a different path).
  mediaAlertEl = el("span", { class: "call-status", role: "alert", hidden: true });

  // Full-bleed layout for the call route (see body.in-call in style.css); cleared
  // by renderHome / renderPrejoin / renderRemoved when we leave the call.
  document.body.classList.add("in-call");

  // Stage holds the grid with the chat panel overlaid; the control bar floats over
  // the bottom of the whole in-call view (autohiding when idle).
  root.replaceChildren(
    el(
      "div",
      { class: "incall" },
      el("header", { class: "call-head" }, el("h1", { text: `#${slug}` }), statusEl, mediaAlertEl),
      el("div", { class: "stage" }, grid.el, chat.el),
      controls.el,
    ),
  );

  // Seed the roster the server already knew about at join time, including each
  // existing peer's stored mic/camera state (so an already-muted peer shows muted).
  for (const p of msg.peers || []) addRosterPeer(p);

  // Remote media -> tiles.
  peer.addEventListener("remote-track", (e) => grid.onRemoteTrack(e.detail));
  peer.addEventListener("peer-gone", (e) => grid.onPeerGone(e.detail));
  peer.addEventListener("error", (e) => console.error("peer error", e.detail.phase, e.detail.error));
  // The media plane failed and one ICE restart didn't recover it. Surface a visible,
  // non-blocking prompt; unlike kicked/banned we do NOT stop() the socket — the WS
  // may still be fine (chat/roster keep working), and a reload rebuilds the call.
  peer.addEventListener("media-failed", showMediaFailed);

  // Local mic track swapped (noise-suppression toggle): replace what we publish for
  // "mic" in place — replaceTrack needs no renegotiation for a same-kind track. The
  // `media` singleton is discarded on leave, so this listener dies with the call.
  media.addEventListener("mic-track", (e) => {
    const track = e && e.detail ? e.detail.track : null;
    if (peer && track) peer.replaceTrack("mic", track).catch((err) => console.error("mic replaceTrack failed", err));
  });

  // Local camera track released/re-acquired (camera off releases the device, on
  // re-acquires it). Mirror it onto what we publish for "camera": replaceTrack in
  // place when the sender already exists (no renegotiation), or publish it the first
  // time if it does not (e.g. joined camera-off, then turned it on). A null track
  // (camera off) replaceTrack(null)s the sender so we stop sending frames while the
  // device is free; the media-state broadcast tells remotes to show camera-off.
  media.addEventListener("camera-track", async (e) => {
    const track = e && e.detail ? e.detail.track : null;
    if (!peer) return;
    const replaced = await peer.replaceTrack("camera", track).catch((err) => {
      console.error("camera replaceTrack failed", err);
      return false;
    });
    if (!replaced && track) peer.publish(track, "camera").catch((err) => console.error("camera publish failed", err));
  });

  // Roster + moderation + chat from the signaling socket. The join/leave chimes live
  // on the peer-joined/left events (a peer arriving/leaving mid-call), NOT on
  // addRosterPeer — which also runs for each existing peer in the initial `joined`
  // roster, and we don't want a burst of chimes when WE join a populated room.
  signaling.on("peer-joined", (m) => {
    addRosterPeer(m);
    playSound("sing");
  });
  signaling.on("peer-left", (m) => {
    grid.removePeer(m.id);
    playSound("drop");
  });
  // Authoritative per-peer mic/camera state: drives the remote mute indicators.
  signaling.on("peer-media-state", (m) => grid.setPeerMedia(m.id, { mic: m.mic, camera: m.camera }));
  signaling.on("muted", (m) => controls.onMuted(m.kind));
  signaling.on("room-locked", () => controls.onLock(true));
  signaling.on("room-unlocked", () => controls.onLock(false));
  signaling.on("countdown", (m) => controls.onCountdown(m));
  signaling.on("chat", (m) => {
    chat.onChat(m);
    controls.notifyChatActivity(); // bumps the unread badge while chat is hidden
  });
  signaling.on("moderation", (m) => chat.onModeration(m));
  // A role change (op promotion): update the badge everywhere, and if it's US, gain
  // the op controls mid-call.
  signaling.on("role", (m) => {
    if (!m || !m.id) return;
    grid.setPeerRole(m.id, m.role);
    if (m.id === grid.selfId && m.role === "op") controls.becomeOp();
  });

  const localTracks = [];
  if (media && media.cameraTrack) localTracks.push({ track: media.cameraTrack, kind: "camera" });
  if (media && media.micTrack) localTracks.push({ track: media.micTrack, kind: "mic" });
  peer.start(localTracks).catch((err) => console.error("peer start failed", err));
  controls.enableDefaultNoiseSuppression(); // denoise on by default; opt out via the control
}

// Toggle the in-call "Reconnecting…" notice (server-restarting, or any reconnect
// in flight). Cleared when the re-join's `joined` lands.
function showReconnecting(on) {
  if (!statusEl) return;
  statusEl.hidden = !on;
  statusEl.textContent = on ? "Reconnecting…" : "";
}

// The media transport died and self-healing (one ICE restart) failed. Show a clear,
// non-blocking prompt telling the user the fix is a reload. This deliberately does
// NOT stop() the signaling (the socket may still be healthy) and does NOT tear the
// call down — it is a distinct, non-terminal signal from kicked/banned. Full media
// auto-recovery without a reload is a documented follow-up. textContent keeps the
// message inert (no markup), matching the rest of the app.
function showMediaFailed() {
  if (!mediaAlertEl) return;
  mediaAlertEl.textContent = "Media connection lost — reload to reconnect.";
  mediaAlertEl.hidden = false;
}

// Tear down the in-call UI + media plane, leaving Media and Signaling for the
// caller to handle (leave releases them; a reconnect keeps them). UI is torn down
// before any media.stop() so grid/controls Media listeners are already detached.
function teardownInCall() {
  if (controls) {
    controls.destroy();
    controls = null;
  }
  if (grid) {
    grid.destroy();
    grid = null;
  }
  if (chat) {
    chat.destroy();
    chat = null;
  }
  if (peer) {
    peer.close();
    peer = null;
  }
  statusEl = null;
  mediaAlertEl = null;
}

// The op kicked or banned this client. Stop the socket FIRST so the reconnect is
// suppressed before anything else can race it (this is what makes a ban stick),
// then tear the call down, release the camera/mic, and show a terminal card. The
// client stays on this page and never rejoins.
function onRemoved(kind, by) {
  if (signaling) {
    signaling.stop();
    signaling = null;
  }
  teardownInCall();
  if (prejoin) {
    prejoin.destroy();
    prejoin = null;
  }
  if (media) {
    media.stop();
    media = null;
  }
  renderRemoved(kind, by);
}

function renderRemoved(kind, by) {
  document.body.classList.remove("in-call");
  const verb = kind === "banned" ? "banned" : "kicked";
  root.replaceChildren(
    el(
      "div",
      { class: "home removed" },
      el("h1", { text: `You were ${verb}` }),
      // `by` is a remote-controlled display name: textContent (the "text" key)
      // keeps it inert, never markup.
      el("p", { class: "lede", text: `You were ${verb}${by ? ` by ${by}` : ""}.` }),
      el("p", { class: "lede muted", text: kind === "banned" ? "You can't rejoin this room." : "You've been removed from this call." }),
    ),
  );
}

// Full teardown back to the lobby. Tear down the UI + peer first (detaches Media
// listeners), stop the socket permanently, release the camera/mic, and re-render
// pre-join with a fresh Media.
function leave() {
  teardownInCall();
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

// Tab close / navigation away: release the socket and the camera/mic so no device
// stays lit and the server reaps us promptly. pagehide fires on desktop and mobile
// (including bfcache), unlike beforeunload.
window.addEventListener("pagehide", () => {
  if (signaling) signaling.stop();
  if (media) media.stop();
});

// --- outdated-page detection ---

// The asset version this page loaded with; if a later poll of /api/version returns a
// different one, the server has been redeployed and this page is stale.
let bootVersion = null;
let updateBannerShown = false;

async function fetchVersion() {
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    return (data && data.version) || null;
  } catch {
    return null;
  }
}

function showUpdateBanner() {
  if (updateBannerShown) return;
  updateBannerShown = true;
  document.body.append(
    el(
      "div",
      { class: "update-banner", role: "status" },
      el("span", { text: "A new version of SwiftIRC VC is available." }),
      el("button", { type: "button", class: "update-reload", onClick: () => location.reload() }, "Reload"),
    ),
  );
}

// Record the version at boot, then poll for changes (and re-check whenever the tab is
// refocused). A changed version means a redeploy — OFFER a reload rather than forcing
// one, so an in-call user is never interrupted mid-call.
async function watchVersion() {
  bootVersion = await fetchVersion();
  if (!bootVersion) return; // endpoint unavailable — skip silently
  const check = async () => {
    if (updateBannerShown) return;
    const v = await fetchVersion();
    if (v && v !== bootVersion) showUpdateBanner();
  };
  setInterval(check, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
}

console.log("SwiftIRC VC loaded");
boot();
watchVersion();
