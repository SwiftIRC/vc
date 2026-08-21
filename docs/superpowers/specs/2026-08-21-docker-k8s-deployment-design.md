# Container image and Kubernetes deployment

## Problem

coyote ships as a static binary installed on a host and run under systemd, fronted
by Caddy or nginx (`docs/DEPLOY.md`). The target deployment is now a k3s cluster
with Traefik as the ingress controller, so the project needs a container image and
the Kubernetes objects to run it.

The complication is that coyote has **two independent network planes** and only one
of them can go through an ingress:

| Plane | Transport | Path |
| --- | --- | --- |
| App shell + signaling | HTTPS / WSS on 443 | Traefik → Service → pod `:8080` |
| Media (RTP) | UDP 50000–50199 | client → **node**, bypassing Traefik entirely |

`internal/sfu/engine.go:46` calls `SetEphemeralUDPPortRange(cfg.UDPPortMin,
cfg.UDPPortMax)` with **no UDP mux**, so every PeerConnection takes ephemeral ports
from that 200-port range. Nothing in Kubernetes routes an arbitrary UDP range to a
pod on the cluster network, and Traefik's UDP entrypoints are one-router-per-port
and would rewrite source addresses in a way ICE cannot survive. The pod therefore
runs on the host's network namespace.

## Decisions

- **`hostNetwork: true` on the pod**, rather than a single-port UDP mux. A mux would
  be the cleaner Kubernetes citizen but is a change to `internal/sfu/engine.go` —
  out of scope here, and noted at the end.
- **Distroless runtime, static binary.** The code has no cgo, makes no outbound HTTP
  request, and reads no file at runtime, so nothing is needed in the image but the
  binary. `assetsVersion` is computed from the embedded assets at init
  (`internal/server/static.go:64`), so there is no build-time version to stamp via
  `-ldflags`.
- **The image carries all six background scenes.** Four are untracked frames from
  copyrighted film and television. This matches how the production host is built
  today and is safe while the image is only ever `ctr images import`ed onto your own
  node. It stops being safe the day it goes to a public registry — recorded in
  `DEPLOY.md`, not enforced in the build.
- **No registry.** The flow is `docker save … | k3s ctr images import -`, so the
  manifests use `imagePullPolicy: IfNotPresent` and a non-`latest` tag.
- **Config by environment, not flags.** `WVC_*` env vars already exist and beat
  defaults (`internal/config/config.go:25`); env is what Kubernetes is good at, and
  it keeps `WVC_SECRET` out of `argv`, which is world-readable.

## Change — `Dockerfile`

Multi-stage. Builder `golang:1.26-alpine` (matching `go 1.26.1` in `go.mod`),
runtime `gcr.io/distroless/static-debian12:nonroot`.

```dockerfile
# syntax=docker/dockerfile:1

FROM golang:1.26-alpine AS build
WORKDIR /src

# Dependencies first, as their own layer: it survives every source-only edit.
COPY go.mod go.sum ./
RUN go mod download

# Then the whole tree. This is not laziness — //go:embed all:assets
# (internal/web/web.go:9) resolves at COMPILE time, so every web asset, including
# the background .webp scenes, must be present for `go build`, not merely present at
# runtime. .dockerignore is what keeps this COPY from dragging in the repo's stale
# 22MB binaries and .git.
COPY . .

# CGO off: nothing in the tree uses it, and the result must run on a distroless
# image with no libc. -trimpath keeps build paths out of the binary; -s -w drop the
# symbol and DWARF tables.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/coyote ./cmd/coyote

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/coyote /usr/local/bin/coyote

# Numeric, not a name: Kubernetes' runAsNonRoot check reads the numeric UID, and a
# named user it cannot resolve fails the pod. 65532 is distroless's "nonroot".
USER 65532:65532

# Documentation only, and inert under hostNetwork — but it states the contract.
EXPOSE 8080/tcp
EXPOSE 50000-50199/udp

ENTRYPOINT ["/usr/local/bin/coyote"]
```

No `HEALTHCHECK`: distroless has no shell or curl to run one, and the Kubernetes
probes below cover it.

## Change — `.dockerignore`

`.dockerignore` patterns are **not** `.gitignore` patterns — they are matched with
Go's `filepath.Match`, where `*` does not cross `/`. Anything meant to match at any
depth needs an explicit `**/` prefix.

```
# Git and tooling scratch
.git
.gitignore
.worktrees/
.superpowers/

# Stale build artifacts sitting in the repo root. The pre-rename binary alone is
# 22MB of build context that would be uploaded on every build.
/coyote
/webrtc-chat
**/*.test
**/*.out

# Not part of the server image. The Anope module is a separate C++ artifact; the
# JS tests are not embedded (//go:embed covers internal/web/assets only).
anope/
docs/
deploy/
internal/web/test/
MANUAL-TEST.md
README.md
THIRD-PARTY-NOTICES.md
LICENSE
.nvmrc

# Docker's own inputs
Dockerfile
.dockerignore
```

**`internal/web/assets/` is deliberately absent from this list**, including
`img/bg/*.webp`. Excluding any of it would compile an image whose embedded asset set
is wrong, and the failure would surface as missing chips or 404s at runtime rather
than as a build error.

## Change — `deploy/k8s/deployment.yaml`

The three fields below are requirements, not defaults, and each has a reason.

**`replicas: 1` with `strategy: { type: Recreate }`.** Room state is in memory with
no database (`internal/room`), so a second replica would silently split rooms — two
users on the same URL landing in different calls. Under `hostNetwork` a second pod
on the node also collides on `:8080` and the UDP range. `RollingUpdate` would try to
start the replacement before the old pod exits and deadlock on those ports, so
`Recreate` is required. The resulting restart gap is already handled: the server
broadcasts `server-restarting` on shutdown and clients re-join automatically.

**`WVC_PUBLIC_IP` from `status.hostIP`, with an explicit override commented beside
it.** `status.hostIP` is the node's *internal* address. On a NAT'd cloud node that
is not what clients reach, and `SetNAT1To1IPs` (`internal/sfu/engine.go:50`) would
advertise an unreachable ICE candidate — the lobby preview works and remote video
stays black, which is the single hardest failure in this app to diagnose.

**`hostNetwork: true` requires `dnsPolicy: ClusterFirstWithHostNet`.** Without it the
pod inherits the node's resolver and loses cluster DNS.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coyote
  labels: { app: coyote }
spec:
  replicas: 1              # see the spec: in-memory room state + hostNetwork ports
  strategy:
    type: Recreate         # RollingUpdate would deadlock on the host ports
  selector:
    matchLabels: { app: coyote }
  template:
    metadata:
      labels: { app: coyote }
    spec:
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet   # mandatory alongside hostNetwork
      terminationGracePeriodSeconds: 30    # the server drains in <=5s (cmd/coyote/main.go)
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: coyote
          image: coyote:0.1.0        # a real tag: :latest defaults an OMITTED pull policy to Always
          imagePullPolicy: IfNotPresent   # the image is ctr-imported, not pullable
          env:
            - name: WVC_ADDR
              value: ":8080"
            # The node's INTERNAL IP. If clients reach this node on a different
            # address (cloud NAT, floating IP), delete this fieldRef and hardcode
            # the reachable one, or media will be black.
            - name: WVC_PUBLIC_IP
              valueFrom:
                fieldRef: { fieldPath: status.hostIP }
            - name: WVC_UDP_MIN
              value: "50000"
            - name: WVC_UDP_MAX
              value: "50199"
            - name: WVC_ADHOC
              value: "false"
            - name: WVC_TRUST_PROXY
              value: "true"        # safe ONLY with the :8080 firewall rule below
            - name: WVC_SECRET
              valueFrom:
                secretKeyRef: { name: coyote, key: secret }
          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
          livenessProbe:
            httpGet: { path: /healthz, port: 8080 }
            initialDelaySeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true    # the process writes nothing to disk
            capabilities: { drop: ["ALL"] }
          resources:
            requests: { cpu: "200m", memory: "128Mi" }
            limits: { memory: "1Gi" }
            # No CPU limit deliberately: CFS throttling on an SFU shows up as
            # audio/video jitter, and the pod is alone on its node's ports anyway.
```

## Change — `deploy/k8s/service.yaml`

A plain ClusterIP on 8080. With a `hostNetwork` pod the endpoint address is the node
IP, which is exactly what Traefik should dial. The Service exists only for the HTTP
plane; nothing about media passes through it.

## Change — `deploy/k8s/ingressroute.yaml`

A Traefik `IngressRoute` on the `websecure` entrypoint matching the deployment's
host, routing to the Service on 8080.

Two notes that save a debugging session:

- **No timeout tuning is required**, unlike the nginx config in `DEPLOY.md` which
  needs `proxy_read_timeout 3600s`. `internal/server/ws.go:32` pings every 20s, well
  inside Traefik's 180s default `idleTimeout`, so a quiet call's signaling socket is
  never idle from Traefik's point of view.
- **WebSocket upgrade needs no configuration.** Traefik forwards `Upgrade` natively;
  the explicit `proxy_set_header Upgrade` dance is an nginx requirement only.

The CRD group is `traefik.io/v1alpha1` (Traefik v3, which current k3s ships). A
cluster still on Traefik v2 needs `traefik.containo.us/v1alpha1`.

## Change — `deploy/k8s/secret.example.yaml`

A template only, with a placeholder value and a comment pointing at
`kubectl create secret generic coyote --from-literal=secret=…`. No real secret is
committed. `WVC_SECRET` must match the Anope module's, per `DEPLOY.md`.

## Change — `docs/DEPLOY.md`

A **Kubernetes (k3s + Traefik)** section beside the existing systemd one, covering:

- `docker build` then `docker save coyote:0.1.0 | sudo k3s ctr images import -`, and
  why `imagePullPolicy: IfNotPresent` plus a non-`latest` tag are what make that work.
- The three constraints above, stated as constraints.
- **Firewall changes, which differ from the systemd setup.** The host deployment
  binds `-addr 127.0.0.1:8080` so the plain HTTP port is unreachable. That is
  impossible here: Traefik dials the pod from the cluster network, so `:8080` binds
  on every node interface. It must be firewalled to the Traefik pod CIDR.
  **This is load-bearing for more than exposure:** `WVC_TRUST_PROXY=true` makes the
  server believe `X-Forwarded-For`, so anyone who can reach `:8080` directly can
  forge their source IP past every ban and rate limit. Loopback binding is what made
  that safe on the host; the firewall rule is what makes it safe here.
- UDP 50000–50199 open to the node, unchanged from the host deployment.
- The licensing note: the image embeds four unlicensed scenes and must not be pushed
  to a public registry as built.
- A smoke check mirroring the existing one, plus `kubectl logs` showing the
  `listening` line with the `publicIP` the pod actually resolved — the fastest way
  to catch the `status.hostIP` trap.

## Edge cases

- **Node reboot / pod reschedule onto another node** → `status.hostIP` changes and
  `WVC_PUBLIC_IP` follows it automatically. A hardcoded override does not, which is
  the trade for correctness on a NAT'd node. Single-node k3s makes this moot.
- **`WVC_SECRET` absent** → the Secret reference fails and the pod will not start.
  That is better than starting with token features silently disabled (`403` on every
  `/api/provision`), so the `secretKeyRef` is deliberately not `optional: true`.
- **Two pods during a botched manual rollout** → prevented by `Recreate`, but if it
  happens the second pod crash-loops on `bind: address already in use` rather than
  corrupting anything.
- **`readOnlyRootFilesystem: true` with built-in TLS** → the `WVC_TLS_CERT` path
  would need a mounted volume. Not used here (Traefik terminates TLS), and noted in
  `DEPLOY.md` rather than pre-solved.
- **Image built on a clone without the untracked scenes** → four fewer chips, no
  errors. This is the existing build-time discovery behaviour
  (`internal/server/scenes.go`), not something the container changes.

## Testing

No Go or JS code changes, so the existing suites are unaffected and must stay green.
Verification is the build and the deploy:

- `docker build -t coyote:0.1.0 .` succeeds.
- `docker run --rm coyote:0.1.0 -help` exits cleanly — proves the binary runs on
  distroless (a cgo-linked build would fail here with a missing loader, not a flag
  error).
- `docker inspect -f '{{.Config.User}}' coyote:0.1.0` → `65532:65532`, so the
  Kubernetes `runAsNonRoot` check has a numeric UID to match.
- The embedded scene set survived the build: run the container with
  `-p 8080:8080 -e WVC_ADDR=:8080`, then `curl -s localhost:8080/ | grep -o
  '/v/[^"]*\.webp' | sort -u` lists six paths. This is the one thing `.dockerignore`
  can silently get wrong, and it fails at runtime rather than at build time.
- `docker save … | k3s ctr images import -`, `kubectl apply -f deploy/k8s/`, then:
  - `kubectl get pod` → Running, 1/1, no restarts.
  - `kubectl logs` → the `listening` line, and **no** `no -public-ip set` warning.
  - `curl -fsS https://<host>/healthz` → `ok` through Traefik.
  - Two browsers on different networks join and see each other — the only real proof
    the UDP range and `WVC_PUBLIC_IP` are right.
- `MANUAL-TEST.md` is not extended: nothing about the client behaviour changes.

## Out of scope

- **A single-port UDP mux** (`ICEUDPMux` in `internal/sfu/engine.go`), which would
  let the pod drop `hostNetwork` and take a normal `LoadBalancer` UDP port. It is
  the better long-term answer for Kubernetes and a real Go change with its own
  testing; it deserves its own spec.
- **A CI workflow** building and pushing the image. The repo has no
  `.github/workflows` at all, and adding the first one is a separate decision —
  particularly since publishing the image as built has the licensing problem above.
- **Horizontal scaling**, which needs shared room state, not a manifest change.
- **A TURN server.** Unchanged from `DEPLOY.md`: peers reach the SFU directly.
- **Helm / Kustomize overlays.** Plain manifests, applied directly.
