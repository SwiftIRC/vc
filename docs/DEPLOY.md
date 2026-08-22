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
| `-log-level` | `WVC_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. An unparseable value refuses to start rather than falling back. |

### When to raise the log level

`debug` adds per-peer media-plane detail: joins and rejoins with their role and
session ref, and every ICE candidate the SFU declined. It is chatty on a busy room,
so raise it to chase something specific and put it back.

The case it exists for is **a participant nobody can see or hear while everything
else looks healthy**. Their own console shows the forwards announced and the tracks
live but no RTP arriving at all — `!! NO INBOUND RTP — label=yes media=yes
track=live` on every mic and camera. That is what an unbound sender looks like from
the receiving end: the SFU added and announced the forwards, but Pion binds a
forwarded track to a sender only once that peer's negotiation completes, so one
offer or answer that failed to apply silences every forward to them for the rest of
the call.

The lines that name it are already at `warn`, so they appear without raising
anything. Grep the server log for the affected peer id before turning the level up —
if one of these is present, it is the answer:

- `sfu peer media transport failed` — this peer's ICE/DTLS never established, or
  died. **This is a network fault, not a code one.** If it lands ~30s after that
  peer joined, their client could not reach the media UDP range at all: check that
  `-udp-min`–`-udp-max` is open to the box *and* that `-public-ip` is the address
  that peer actually reaches it on. On a cloud VM remember there are usually two
  firewalls — the provider's security list and the instance's own `iptables` — and
  the second one is the one people forget.
- `offer rejected` / `answer rejected` — the negotiation itself would not apply,
  carrying the room, the peer id and the underlying error.
- `media offer dropped (send overflow/closing)` — the peer never received the offer
  in the first place.

The matching **`sfu peer media transport closed`** is at `debug` on purpose: it is
reached on every ordinary teardown, including when the server closes the peer
connection itself, so it says nothing about health. Only `failed` is a fault.

A peer whose transport fails has its signaling socket closed too, so it reconnects
and rebuilds the call by itself within about a second. Before that it kept its place
in the roster with no media in either direction and no way back — present, and
neither seeing nor heard.

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
allocates ephemeral media ports across `WVC_UDP_MIN`–`WVC_UDP_MAX` with no UDP mux,
and nothing in Kubernetes routes an arbitrary UDP range to a pod on the cluster network.
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

### TLS: the cert resolver must exist first

`deploy/k8s/ingressroute.yaml` references `certResolver: letsencrypt`, but **k3s's
bundled Traefik ships with no ACME resolver configured out of the box.** Apply the
manifests without doing anything else first and Traefik falls back to its default
self-signed certificate — and because TLS is mandatory here (browsers only expose
`getUserMedia` on a secure context, same as above), that makes the app unusable, not
merely untrusted.

Give the bundled Traefik a resolver before applying `ingressroute.yaml`, via a
`HelmChartConfig` k3s picks up on start (or `helm upgrade` if you manage Traefik
yourself):

```yaml
# /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    certificatesResolvers:
      letsencrypt:
        acme:
          email: you@example.net
          storage: /data/acme.json
          httpChallenge:
            entryPoint: web
```

The resolver's name (`letsencrypt` above) must match `certResolver` in
`ingressroute.yaml`, and the HTTP-01 challenge needs port 80 reachable from the
internet. If you'd rather not commit to this exact recipe, see k3s's own Traefik
customisation docs — but do not skip this step and assume the default works; it does
not, and the failure looks like a working deploy with a browser TLS warning until you
notice `getUserMedia` never fires.

### Deploy

```
kubectl create secret generic coyote --from-literal=secret='<shared HMAC secret>'
kubectl apply -f deploy/k8s/
```

Edit the host and `certResolver` in `deploy/k8s/ingressroute.yaml` to match your
Traefik setup first. `deploy/secret.example.yaml` is a template showing the Secret's
shape; it lives outside `deploy/k8s/` so a re-apply cannot overwrite your real
secret with its placeholder.

None of the three manifests sets a `namespace`, and the `kubectl create secret`
command above doesn't either — both commands rely on your active namespace being the
same one. If you pass `-n` to one, pass the same `-n` to the other, or the pod ends
up in one namespace looking for a Secret that only exists in another and sits stuck
at `ContainerCreating`/`CreateContainerConfigError`.

### Updating

Because the tag is pinned to `coyote:0.1.0` with `imagePullPolicy: IfNotPresent`,
re-running `docker save … | k3s ctr images import -` under the **same tag** and then
`kubectl apply -f deploy/k8s/` changes nothing: the Deployment spec `kubectl` compares
against is byte-identical, so there is no new ReplicaSet and no new pod. `kubectl`
prints `unchanged`, and it is easy to conclude — wrongly — that the fix shipped.

**Preferred: bump the tag.** Change the tag everywhere it appears — the `docker
build`/`docker save` commands above *and* `image: coyote:0.1.0` in
`deploy/k8s/deployment.yaml` — e.g. to `coyote:0.1.1`, then re-import and
`kubectl apply -f deploy/k8s/` again. This keeps `IfNotPresent` honest: the tag
genuinely identifies which bits are running, and `kubectl describe pod` shows it.

**Quick: force a restart under the same tag.** Re-import under the unchanged tag,
then:

```
kubectl rollout restart deployment/coyote
```

This works because `IfNotPresent` still finds the freshly-imported image locally, but
it has two costs: with `strategy: Recreate` the room briefly goes down during the
swap, and because the tag never changed, `kubectl describe pod` gives no evidence of
which build is actually running — you're trusting that the re-import happened.
Prefer the tag bump whenever you can.

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

**`WVC_ADDR` binds `:8080` to the node's own IP (`$(WVC_PUBLIC_IP)`), not every
interface.** The systemd deployment binds `-addr 127.0.0.1:8080` so the plain HTTP
port is unreachable from outside; that specific trick is impossible here, because
Traefik dials the pod at the node IP, not loopback. Binding `WVC_ADDR` to the node IP
instead of a bare `:8080` is the closest equivalent Kubernetes allows: on a
**multi-homed node** — a private `status.hostIP` behind a separate public NIC, the
common case on a cloud VM — this removes the exposure outright, because nothing
outside the private network can reach that address at all. On a **single-homed
public node**, where `status.hostIP` *is* the public address, the bind changes
nothing: the address is reachable either way, and the node firewall is the only
control.

This is not only about exposure. The manifest sets `WVC_TRUST_PROXY=true`, so the
server believes `X-Forwarded-For`. Anyone who can reach `:8080` directly can
therefore forge their source address past per-room IP bans. Loopback binding is what
made trusting that header safe under systemd; on a single-homed node here, the
firewall rule is what makes it safe, and it is worth verifying rather than assuming.

**Do not firewall this by "Traefik's CIDR."** Traefik has no CIDR of its own — it
shares the cluster pod CIDR (`10.42.0.0/16` on a default k3s) with every other pod —
and under `hostNetwork` it dials the *node's* IP, which sits outside both the pod and
service CIDRs. k3s's flannel masquerades that traffic, so it will very likely arrive
already SNATted to some other node-local address, not the pod CIDR. A rule that
allows "the pod CIDR" therefore blocks Traefik itself, and the symptom is a 502 with
no obvious cause. There is no source address you can name in advance here; test it
empirically instead (see the firewall check in the smoke check below).

### Firewall

- **443/tcp** to the node, for Traefik.
- **8080/tcp**: on a multi-homed node whose `status.hostIP` is private, 2a already
  keeps this off any public interface and no rule is needed. On a single-homed public
  node, this port is reachable to the world unless you block it — do **not** try to
  scope a rule to "Traefik's address"; there isn't a stable one to name (see above).
  Block external access to `:8080` at the node firewall and confirm with the `curl`
  step in the smoke check below, which must fail from outside.
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

### Post-deploy smoke check (Kubernetes)

1. `kubectl get pod -l app=coyote` → `1/1 Running`, no restarts.
2. `kubectl logs -l app=coyote` → one `listening` line and **no** `no -public-ip set`
   warning. Check that its `publicIP` value is the address clients actually reach —
   the fastest way to catch the `status.hostIP` trap above.
3. `curl -fsS https://<host>/healthz` → `ok`, proving Traefik and TLS.
4. **From another host** (not the node itself): `curl --max-time 5
   http://<node-ip>:8080/healthz` **must fail** (connection refused/timeout). If it
   returns `ok`, `:8080` is reachable from outside and, with `WVC_TRUST_PROXY=true`,
   anyone can forge `X-Forwarded-For` past per-room IP bans — go fix the firewall (or,
   on a multi-homed node, check `status.hostIP` really is the private address you
   expect) before going further.
5. Join from two browsers on different networks and confirm two-way video. This is
   the only real proof the UDP range and `WVC_PUBLIC_IP` are right — the first four
   checks all pass without it.
6. **Verify banning actually scopes per-client, not per-cluster-edge.** k3s's default
   ServiceLB (klipper-lb) is known to masquerade inbound connections, which can make
   Traefik see every client as the same peer address; if that happens, the rightmost
   `X-Forwarded-For` entry is identical for everyone, and the per-room banned-IP set
   cannot tell participants apart — banning one guest bans the whole room, silently.
   Join from two genuinely different external networks, ban one participant, and
   confirm the other is unaffected. This depends on your k3s version and on whether
   the `traefik` Service has `externalTrafficPolicy: Local` (which is what preserves
   real source addresses through ServiceLB) — it's a "verify for your cluster" step,
   not a guaranteed break, but nothing else in the manifests, docs, or the checks
   above would surface it if it does happen.

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
