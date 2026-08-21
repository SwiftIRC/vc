# Deploying coyote

coyote is a single static Go binary. It serves the web client, the signaling
WebSocket, and the SFU media plane from one process. There is **no database and no
TURN server** — the SFU has a public IP, so peers reach it directly over UDP.

Two independent network planes, which matters for every step below:

| Plane | Transport | Who terminates it |
| --- | --- | --- |
| App shell + signaling | HTTPS / WSS on 443 | your reverse proxy (Caddy/nginx) |
| Media (RTP) | UDP on a fixed port range, directly to the box | the binary itself — **not** proxied |

## Why TLS is mandatory

Browsers only expose `getUserMedia` / `getDisplayMedia` on a **secure context**
(`https://` or `localhost`). Without HTTPS the camera/mic never turn on and the
lobby preview stays black. In production you terminate TLS at a reverse proxy
(recommended) or with the binary's own cert flags. `http://localhost:8080` works
for local dev only.

## Configuration

Flags take precedence over `WVC_*` environment variables, which take precedence
over defaults.

| Flag | Env | Default | Purpose |
| --- | --- | --- | --- |
| `-addr` | `WVC_ADDR` | `:8080` | HTTP listen address (put the proxy in front). |
| `-public-ip` | `WVC_PUBLIC_IP` | _(empty)_ | **Public IP advertised in ICE candidates.** Set to the server's reachable IP or clients can't send media. |
| `-udp-min` | `WVC_UDP_MIN` | `50000` | First UDP port for media. |
| `-udp-max` | `WVC_UDP_MAX` | `50199` | Last UDP port for media. Open this whole range in the firewall. |
| `-secret` | `WVC_SECRET` | _(empty)_ | Shared HMAC secret for join tokens **and** `/api/provision`. Must match the Anope module's secret. Empty disables all channel-room / token features. |
| `-adhoc` | `WVC_ADHOC` | `true` | Allow ad-hoc rooms (anyone visiting `/<name>` and joining creates one). Set `false` for a channel-rooms-only SwiftIRC deployment. |
| `-trust-proxy` | `WVC_TRUST_PROXY` | `false` | Trust `X-Forwarded-For`. **Enable only behind a trusted proxy** (it reads the last XFF entry). Off = the direct socket IP is used. |
| `-tls-cert` / `-tls-key` | `WVC_TLS_CERT` / `WVC_TLS_KEY` | _(empty)_ | Optional built-in TLS instead of a proxy. Set both or neither. |

Routes served: `GET /` (app shell + assets), `GET /ws/{room}` (signaling),
`GET /api/rooms/{room}` (occupancy JSON), `POST /api/provision` (Anope), and
`GET /healthz`.

### Firewall

- **443/tcp** (or 80→443) to the box, proxied to `-addr`.
- **`-udp-min`–`-udp-max`/udp** open directly to the box (default 50000–50199).
  These carry media and must **not** go through the reverse proxy.
- `-public-ip` must equal the address clients reach over that UDP range.

## Build & run

```
go build -o coyote ./cmd/coyote

# Channel-rooms-only SwiftIRC deployment behind a proxy:
./coyote \
  -addr 127.0.0.1:8080 \
  -public-ip 203.0.113.10 \
  -udp-min 50000 -udp-max 50199 \
  -secret "$WVC_SECRET" \
  -adhoc=false \
  -trust-proxy
```

Bind `-addr` to loopback (`127.0.0.1:8080`) when a proxy fronts it, so the plain
HTTP port isn't exposed. The UDP media range still binds on all interfaces and is
reached via `-public-ip`.

## Reverse proxy

### Caddy (recommended — automatic HTTPS)

`reverse_proxy` upgrades WebSockets and sets `X-Forwarded-For` on its own, so
`-trust-proxy` is safe with this config.

```caddyfile
# /etc/caddy/Caddyfile
vc.swiftirc.net {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

Caddy provisions and renews a Let's Encrypt certificate automatically. Nothing
else is required for TLS.

### nginx

nginx needs the upgrade headers spelled out for the WebSocket, and
`proxy_add_x_forwarded_for` to append the real client IP (which `-trust-proxy`
then reads).

```nginx
server {
    listen 443 ssl;
    server_name vc.swiftirc.net;

    ssl_certificate     /etc/letsencrypt/live/vc.swiftirc.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vc.swiftirc.net/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;          # WebSocket upgrade
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;                        # keep idle calls alive
    }
}
```

Media UDP does not pass through nginx — clients reach `-public-ip` on the UDP
range directly.

### Built-in TLS (no proxy)

For a simple single-host setup you can skip the proxy:

```
./coyote -public-ip 203.0.113.10 -addr :443 \
  -tls-cert /etc/coyote/fullchain.pem \
  -tls-key  /etc/coyote/privkey.pem
```

You are then responsible for certificate renewal yourself.

## Renaming an existing deployment

The project was called `webrtc-chat` until it became `coyote`. Nothing in the
protocol or on-disk state changed, so an existing host needs only its names
brought across:

```
systemctl stop webrtc-chat
mv /etc/webrtc-chat /etc/coyote
mv /usr/local/bin/webrtc-chat /usr/local/bin/coyote
mv /etc/systemd/system/webrtc-chat.service /etc/systemd/system/coyote.service
# edit the unit: EnvironmentFile and ExecStart both still say webrtc-chat
systemctl daemon-reload && systemctl enable --now coyote
```

`WVC_SECRET` and every other env var keep their names — the `WVC_` prefix is
unchanged — so the Anope module needs no edit and rooms keep working. The Anope
module itself is still `m_webrtc_chat` and is deliberately untouched.

## systemd unit

```ini
# /etc/systemd/system/coyote.service
[Unit]
Description=coyote SFU
After=network-online.target
Wants=network-online.target

[Service]
User=webrtc
Group=webrtc
# Secret lives in a root-only env file, not on the command line (argv is world-readable).
EnvironmentFile=/etc/coyote/env
ExecStart=/usr/local/bin/coyote \
  -addr 127.0.0.1:8080 \
  -public-ip 203.0.113.10 \
  -udp-min 50000 -udp-max 50199 \
  -adhoc=false \
  -trust-proxy
Restart=on-failure
RestartSec=2s

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```
# /etc/coyote/env   (chmod 600, root-owned)
WVC_SECRET=the-shared-hmac-secret-also-in-anope.conf
```

```
systemctl daemon-reload
systemctl enable --now coyote
journalctl -u coyote -f
```

On restart the process broadcasts `server-restarting` and closes connections;
clients show "Reconnecting…" and re-join automatically once it's back up, so a
short `RestartSec` keeps interruptions brief.

## Kubernetes (k3s + Traefik)

This path and the systemd one differ in one structural way: under Kubernetes the pod
runs on the **host's** network namespace. That is not a preference. The SFU
allocates ephemeral media ports across `-udp-min`–`-udp-max` with no UDP mux, and
nothing in Kubernetes routes an arbitrary UDP range to a pod on the cluster network.
Traefik carries the app shell and signaling; media bypasses it and reaches the node
directly, exactly as it bypasses nginx above.

### Build and load the image

There is no registry in this flow — the image goes straight into k3s's containerd:

```
docker build -t coyote:0.1.0 .
docker save coyote:0.1.0 | sudo k3s ctr images import -
```

Two manifest details are what make that work:

- `imagePullPolicy: IfNotPresent` — the default sends k3s looking for a registry
  that does not exist.
- a real tag rather than `:latest`. The explicit policy above is what does the work;
  the tag is belt and braces, because an *omitted* pull policy defaults to `Always`
  on a `:latest` or untagged image.

**The image embeds whatever background scenes are in the build context.** Four of the
six are frames from copyrighted film and television (see `THIRD-PARTY-NOTICES.md`).
They are untracked, so a clone builds without them and a local checkout builds with
them. That is fine while the image only ever moves from your machine to your own
node. Pushing it to a public registry would distribute them — rebuild from a clean
clone first.

### Deploy

```
kubectl create secret generic coyote --from-literal=secret='<shared HMAC secret>'
kubectl apply -f deploy/k8s/
```

Edit the host and `certResolver` in `deploy/k8s/ingressroute.yaml` to match your
Traefik setup first. `deploy/secret.example.yaml` is a template showing the Secret's
shape; it lives outside `deploy/k8s/` so a re-apply cannot overwrite your real
secret with its placeholder.

### Three constraints, and why

**`replicas: 1`, `strategy: Recreate`.** Room state is in memory and there is no
database, so a second replica silently splits rooms — two people opening the same URL
land in different calls. Under `hostNetwork` a second pod also collides on `:8080`
and the UDP range, and `RollingUpdate` would deadlock trying to start the replacement
before the old pod releases them. The restart gap is already handled: the server
broadcasts `server-restarting` and clients re-join by themselves.

**`WVC_PUBLIC_IP` comes from `status.hostIP`, the node's _internal_ address.** That
is correct only when clients reach the node on that address. On a NAT'd node — a
cloud VM with a separate public IP — it is wrong, and the failure is the nastiest
this app has: the lobby preview works, everything looks healthy, and remote video is
simply black. Replace the `fieldRef` with the reachable address if that is your
situation.

**`:8080` is now exposed on every node interface, and must be firewalled.** The
systemd deployment binds `-addr 127.0.0.1:8080` so the plain HTTP port is
unreachable from outside. That is impossible here, because Traefik dials the pod from
the cluster network. Restrict `:8080` to the Traefik pod CIDR at the node firewall.

This is not only about exposure. The manifest sets `WVC_TRUST_PROXY=true`, so the
server believes `X-Forwarded-For`. Anyone who can reach `:8080` directly can
therefore forge their source address past every ban and rate limit. Loopback binding
is what made trusting that header safe under systemd; the firewall rule is what makes
it safe here.

### Firewall

- **443/tcp** to the node, for Traefik.
- **8080/tcp** from the Traefik pod CIDR only — see above.
- **50000–50199/udp** open to the node. Unchanged from the systemd deployment: this
  carries media and does not pass through Traefik.

### Traefik notes

Traefik forwards WebSocket upgrades natively — the explicit `Upgrade` headers the
nginx config above needs have no Traefik equivalent. Nor does `proxy_read_timeout
3600s`: the server pings every 20s, comfortably inside Traefik's 180s default
`idleTimeout`, so an idle call's signaling socket is never dropped.

The manifests use the `traefik.io/v1alpha1` CRD group (Traefik v3, which current k3s
ships). On Traefik v2 the group is `traefik.containo.us/v1alpha1`.

### TLS inside the pod

`readOnlyRootFilesystem: true`, plus TLS terminating at Traefik, means the built-in
`-tls-cert` / `-tls-key` path is unused here. Using it would need the certificate
mounted as a volume.

### Post-deploy smoke check

1. `kubectl get pod -l app=coyote` → `1/1 Running`, no restarts.
2. `kubectl logs -l app=coyote` → one `listening` line and **no** `no -public-ip set`
   warning. Check that its `publicIP` value is the address clients actually reach —
   the fastest way to catch the `status.hostIP` trap above.
3. `curl -fsS https://<host>/healthz` → `ok`, proving Traefik and TLS.
4. Join from two browsers on different networks and confirm two-way video. This is
   the only real proof the UDP range and `WVC_PUBLIC_IP` are right — the first three
   checks all pass without it.

## SwiftIRC / Anope integration: `!vc` → token link → join

The Anope module (Plan 4) and this server share one `-secret`. The flow:

1. **`!vc` in a channel.** The Anope module POSTs the channel's current settings
   snapshot to `POST /api/provision`, authenticated with the shared secret:

   ```
   POST /api/provision
   Authorization: Bearer <WVC_SECRET>
   Content-Type: application/json

   {"channel":"#swiftirc","room":"swiftirc","settings":{"identifiedOnly":true}}
   ```

   `204` = provisioned; `403` = server has no `-secret` (feature disabled);
   `401` = wrong secret. This binds `#channel → room slug` and its settings so an
   `identifiedOnly` room refuses guests, and a channel-rooms-only server
   (`-adhoc=false`) will accept joins to that slug.

2. **The link.** The bot replies in-channel with the public URL
   (`https://vc.swiftirc.net/<slug>`) and NOTICEs an identified user a personal
   **tokenized** link:

   ```
   https://vc.swiftirc.net/<slug>#t=<base64url(payload)>.<base64url(HMAC)>
   ```

   The token carries the room, nick, NickServ account, role (`op`/`voice`/`user`),
   a settings snapshot, and a ~10-minute expiry. It rides in the URL **fragment**
   (`#t=…`), which the browser never sends to the server or proxy — so it stays out
   of access logs. The client JS reads the fragment and puts the token inside the
   WebSocket `join` frame.

3. **Join.** The server verifies the token's HMAC and claims with `-secret`,
   grants the token's role, and (via the snapshot) re-provisions the room if it was
   lost to a restart. The read-only display name in the lobby is the token's nick;
   a locked room additionally prompts for its password.

Keep `WVC_SECRET` identical in `/etc/coyote/env` and the Anope module config,
and rotate both together — a mismatch rejects every token and every provision.

## Post-deploy smoke check

1. `curl -fsS https://vc.swiftirc.net/healthz` → `ok`.
2. Open `https://vc.swiftirc.net/testroom` in a browser; the lobby preview shows
   your camera (proves TLS + getUserMedia).
3. Join from two browsers on different networks; confirm two-way video (proves the
   UDP range and `-public-ip` are reachable). If the preview works but remote video
   never arrives, the media UDP ports or `-public-ip` are wrong.
