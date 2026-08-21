# Container Image and k3s Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package coyote as a container image and add the Kubernetes objects to run it on k3s behind a Traefik ingress.

**Architecture:** A multi-stage Dockerfile producing a static binary on a distroless base. The pod runs with `hostNetwork: true` because `internal/sfu/engine.go:46` allocates ephemeral media ports across a 200-port UDP range with no mux, and nothing in Kubernetes routes an arbitrary UDP range to a pod on the cluster network. Traefik carries the HTTP/WebSocket plane only; media reaches the node directly. No registry — the image is `docker save`d and imported into k3s's containerd.

**Tech Stack:** Docker multi-stage build (`golang:1.26-alpine` → `gcr.io/distroless/static-debian12:nonroot`); plain Kubernetes manifests plus a Traefik `IngressRoute` CRD; no Go or JS code changes.

**Spec:** `docs/superpowers/specs/2026-08-21-docker-k8s-deployment-design.md`

## Global Constraints

- **No Go or JS code changes.** This plan adds deployment artifacts only. `go test ./...` and `node --test internal/web/test/*.test.js` must stay green, untouched.
- **`internal/web/assets/` must never be excluded from the Docker build context**, including `img/bg/*.webp`. `//go:embed all:assets` (`internal/web/web.go:9`) resolves at compile time, so anything `.dockerignore` hides is silently missing from the binary — a runtime failure, not a build error.
- **`.dockerignore` patterns are not `.gitignore` patterns.** They are matched with Go's `filepath.Match`, where `*` does not cross `/`. Use an explicit `**/` prefix for anything meant to match at depth.
- **The image is never pushed to a registry** in this flow. It carries four untracked copyrighted background scenes; that is acceptable only because it moves from this machine to your own node and nowhere else.
- **Three manifest values are requirements, not defaults**, each with a reason in the spec: `replicas: 1` with `strategy: Recreate`; `dnsPolicy: ClusterFirstWithHostNet` alongside `hostNetwork: true`; `imagePullPolicy: IfNotPresent` with a non-`latest` tag.
- **No secret value is ever committed.** The example carries a placeholder only.
- Use the image tag `coyote:0.1.0` consistently across the Dockerfile docs, the manifests, and `DEPLOY.md`.
- No `Co-Authored-By` trailer on any commit.

## Deliberate deviation from the spec — read before Task 2

The spec places the secret template at `deploy/k8s/secret.example.yaml`. **Put it at
`deploy/secret.example.yaml` instead** — one level up, outside the applied directory.

`kubectl apply -f deploy/k8s/` reads every `.yaml` in the directory. With the example
inside it, a routine re-apply would overwrite the real `coyote` Secret with the
literal string `REPLACE_ME`, and every join token and `/api/provision` call would
start failing HMAC validation — a confusing, delayed failure. Keeping it outside the
applied directory makes the simple `apply -f deploy/k8s/` in `DEPLOY.md` safe.

---

## File Structure

- `Dockerfile` — **new**; multi-stage build. *(Task 1)*
- `.dockerignore` — **new**; prunes the context without touching the embedded assets. *(Task 1)*
- `deploy/k8s/deployment.yaml` — **new**; the pod, with the three constraints. *(Task 2)*
- `deploy/k8s/service.yaml` — **new**; ClusterIP for Traefik. *(Task 2)*
- `deploy/k8s/ingressroute.yaml` — **new**; Traefik CRD. *(Task 2)*
- `deploy/secret.example.yaml` — **new**; placeholder template, outside the applied dir. *(Task 2)*
- `docs/DEPLOY.md` — modified; a Kubernetes section beside the systemd one. *(Task 3)*

Dependency order: Task 1 (the image) → Task 2 (the manifests that run it) → Task 3 (the docs covering both).

---

### Task 1: Dockerfile and .dockerignore

Produces a runnable image. Independently verifiable end to end on this machine — Docker 29.1.3 is installed and the daemon is reachable.

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Produces: an image tagged `coyote:0.1.0`, entrypoint `/usr/local/bin/coyote`, user `65532:65532`, HTTP on 8080. Consumed by Task 2's manifests and Task 3's docs.

- [ ] **Step 1: Write the `.dockerignore` first**

Write it before the Dockerfile: the `COPY . .` below is only safe because this file
exists, and building without it uploads the repo's stale 22MB binary and `.git`.

Create `.dockerignore`:

```
# Git and tooling scratch
.git
.gitignore
.worktrees/
.superpowers/

# Stale build artifacts in the repo root. The pre-rename binary alone is 22MB of
# build context that would be uploaded on every build.
/coyote
/webrtc-chat
**/*.test
**/*.out

# Not part of the server image. The Anope module is a separate C++ artifact, and the
# JS tests are not embedded — //go:embed covers internal/web/assets only.
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

`internal/web/assets/` is deliberately absent from this list, including
`img/bg/*.webp`. Do not add it. Excluding any of it compiles an image whose embedded
asset set is wrong, and that surfaces as missing background chips at runtime rather
than as a build failure.

- [ ] **Step 2: Write the Dockerfile**

Create `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

FROM golang:1.26-alpine AS build
WORKDIR /src

# Dependencies first, as their own layer: it survives every source-only edit.
COPY go.mod go.sum ./
RUN go mod download

# Then the whole tree. This is not laziness — //go:embed all:assets
# (internal/web/web.go) resolves at COMPILE time, so every web asset, including the
# background .webp scenes, must be present for `go build`, not merely present at
# runtime. .dockerignore is what keeps this COPY honest.
COPY . .

# CGO off: nothing in the tree uses it, and the result must run on a distroless image
# with no libc. -trimpath keeps build paths out of the binary; -s -w drop the symbol
# and DWARF tables.
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
probes in Task 2 cover it.

- [ ] **Step 3: Build the image**

Run:

```
docker build -t coyote:0.1.0 .
```

Expected: a successful build.

**If the `golang:1.26-alpine` tag does not exist**, try `golang:1.26.1-alpine`, then
`golang:1.26`. Prefer whichever exactly matches the `go 1.26.1` directive in
`go.mod` — an older patch image would download a toolchain at build time, which
works but adds a network dependency mid-build. Record which tag you used in your
report; do not silently fall back to an older minor.

- [ ] **Step 4: Verify the binary runs on distroless**

Run:

```
docker run --rm coyote:0.1.0 -help
```

Expected: the flag usage block, exit status 2. This proves the static binary
executes on an image with no libc — a cgo-linked build fails here with a missing
dynamic loader rather than a usage message.

- [ ] **Step 5: Verify the image user**

Run:

```
docker inspect -f '{{.Config.User}}' coyote:0.1.0
```

Expected: `65532:65532`. Kubernetes' `runAsNonRoot` needs a numeric UID to match
against; a name it cannot resolve fails the pod at admission.

- [ ] **Step 6: Verify the embedded scenes survived `.dockerignore`**

This is the one thing `.dockerignore` can silently get wrong, so check it explicitly.
Start the container, read the app shell, and count the background images it injects:

```
docker run -d --name coyote-check -p 18080:8080 coyote:0.1.0
sleep 2
curl -s localhost:18080/ | grep -o '/v/[^"]*\.webp' | sort -u
docker rm -f coyote-check
```

Expected: **six** distinct `.webp` paths (`carina`, `idiocracy`, `office-space`,
`pillars`, `space-ghost`, `star-trek`). Two means `.dockerignore` swallowed the
untracked scenes — fix it rather than accepting the smaller set. Zero means the
whole asset tree is missing.

Port 18080 on the host deliberately, so this check cannot collide with anything
already listening on 8080.

- [ ] **Step 7: Confirm the Go and JS suites are untouched**

This task adds no code, so both suites must be exactly as they were:

```
go build ./...
node --test internal/web/test/*.test.js
```

Expected: build clean; 168 tests passing, 0 failing.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build: containerise coyote as a static distroless image"
```

---

### Task 2: Kubernetes manifests

The objects that run the image on k3s behind Traefik. Read the "Deliberate deviation" section above before starting — the secret template goes **outside** `deploy/k8s/`.

**Files:**
- Create: `deploy/k8s/deployment.yaml`
- Create: `deploy/k8s/service.yaml`
- Create: `deploy/k8s/ingressroute.yaml`
- Create: `deploy/secret.example.yaml`

**Interfaces:**
- Consumes: the `coyote:0.1.0` image from Task 1 (entrypoint, port 8080, UID 65532).
- Produces: `kubectl apply -f deploy/k8s/` deploys the app. Documented by Task 3.

- [ ] **Step 1: Write the Deployment**

Create `deploy/k8s/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: coyote
  labels: { app: coyote }
spec:
  # Room state is in memory with no database, so a second replica silently splits
  # rooms — two people opening the same URL land in different calls. Under
  # hostNetwork a second pod also collides on :8080 and the UDP range.
  replicas: 1
  strategy:
    # RollingUpdate would deadlock: it starts the replacement before the old pod
    # releases the host ports. The restart gap is already handled — the server
    # broadcasts server-restarting and clients re-join on their own.
    type: Recreate
  selector:
    matchLabels: { app: coyote }
  template:
    metadata:
      labels: { app: coyote }
    spec:
      # The SFU allocates ephemeral media ports across WVC_UDP_MIN..WVC_UDP_MAX with
      # no UDP mux, and nothing in Kubernetes routes an arbitrary UDP range to a pod
      # on the cluster network.
      hostNetwork: true
      # Mandatory alongside hostNetwork: without it the pod inherits the node's
      # resolver and loses cluster DNS.
      dnsPolicy: ClusterFirstWithHostNet
      terminationGracePeriodSeconds: 30   # the server drains in <=5s
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: coyote
          # Never :latest — that forces imagePullPolicy Always regardless of the
          # value below, and this image is ctr-imported, not pullable.
          image: coyote:0.1.0
          imagePullPolicy: IfNotPresent
          env:
            - name: WVC_ADDR
              value: ":8080"
            # The node's INTERNAL IP. Correct only when clients reach the node on
            # that address. On a NAT'd node (a cloud VM with a separate public IP)
            # this is wrong, and the failure is this app's nastiest: the lobby
            # preview works, everything looks healthy, and remote video is black.
            # Replace this fieldRef with the reachable address if that is you.
            - name: WVC_PUBLIC_IP
              valueFrom:
                fieldRef: { fieldPath: status.hostIP }
            - name: WVC_UDP_MIN
              value: "50000"
            - name: WVC_UDP_MAX
              value: "50199"
            - name: WVC_ADHOC
              value: "false"
            # Safe ONLY with the :8080 firewall rule documented in DEPLOY.md.
            # Without it, anyone reaching :8080 directly can forge X-Forwarded-For
            # past every ban and rate limit.
            - name: WVC_TRUST_PROXY
              value: "true"
            # Deliberately not optional: a missing secret should fail the pod, not
            # start a server that 403s every /api/provision call from Anope.
            - name: WVC_SECRET
              valueFrom:
                secretKeyRef:
                  name: coyote
                  key: secret
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
            readOnlyRootFilesystem: true   # the process writes nothing to disk
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: "200m"
              memory: "128Mi"
            limits:
              # No CPU limit deliberately: CFS throttling on an SFU surfaces as
              # audio and video jitter, and this pod owns its node's ports anyway.
              memory: "1Gi"
```

- [ ] **Step 2: Write the Service**

Create `deploy/k8s/service.yaml`:

```yaml
# Exists purely so Traefik has a stable name to route the HTTP/WebSocket plane to.
# With a hostNetwork pod the endpoint address is the node IP, which is what Traefik
# should dial. Nothing about the media plane passes through here.
apiVersion: v1
kind: Service
metadata:
  name: coyote
  labels: { app: coyote }
spec:
  type: ClusterIP
  selector:
    app: coyote
  ports:
    - name: http
      port: 8080
      targetPort: 8080
      protocol: TCP
```

- [ ] **Step 3: Write the Traefik IngressRoute**

Create `deploy/k8s/ingressroute.yaml`:

```yaml
# Traefik v3 CRD group, which current k3s ships. On Traefik v2 this is
# traefik.containo.us/v1alpha1.
#
# No WebSocket configuration is needed: Traefik forwards Upgrade natively, unlike
# the explicit header dance nginx requires. No timeout tuning either — the server
# pings every 20s (internal/server/ws.go), well inside Traefik's 180s default
# idleTimeout, so an idle call's signaling socket is never dropped.
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: coyote
spec:
  entryPoints:
    - websecure
  routes:
    - kind: Rule
      match: Host(`vc.swiftirc.net`)   # change to your host
      services:
        - name: coyote
          port: 8080
  tls:
    certResolver: letsencrypt          # change to your Traefik cert resolver
```

- [ ] **Step 4: Write the secret template — outside `deploy/k8s/`**

Create `deploy/secret.example.yaml` (note the path: **not** in `deploy/k8s/`, so a
`kubectl apply -f deploy/k8s/` cannot overwrite the real secret with the placeholder):

```yaml
# TEMPLATE ONLY — do not apply this file and do not commit a real secret.
#
# Create the real secret with:
#   kubectl create secret generic coyote --from-literal=secret='<shared HMAC secret>'
#
# It must match the Anope module's configured secret (see docs/DEPLOY.md). A mismatch
# rejects every join token and every /api/provision call.
#
# This file lives outside deploy/k8s/ on purpose: that directory is applied wholesale,
# and an example secret inside it would clobber the real one with the placeholder
# below on every re-apply.
apiVersion: v1
kind: Secret
metadata:
  name: coyote
type: Opaque
stringData:
  secret: "REPLACE_ME"
```

- [ ] **Step 5: Verify the manifests parse and hold the required invariants**

`kubectl --dry-run` needs a reachable cluster for API discovery, and there is none
here, so validate offline. This script also encodes the three constraints as an
executable check rather than trusting a read-through.

Run from the repo root:

```
python3 - <<'PY'
import pathlib, sys, yaml
docs = {}
for p in sorted(pathlib.Path("deploy/k8s").glob("*.yaml")):
    for d in yaml.safe_load_all(p.read_text()):
        if d:
            docs[(d["kind"], d["metadata"]["name"])] = d
dep = docs[("Deployment", "coyote")]
spec, tpl = dep["spec"], dep["spec"]["template"]["spec"]
c = tpl["containers"][0]
env = {e["name"]: e for e in c["env"]}
checks = [
    ("replicas is 1", spec["replicas"] == 1),
    ("strategy is Recreate", spec["strategy"]["type"] == "Recreate"),
    ("hostNetwork is true", tpl["hostNetwork"] is True),
    ("dnsPolicy is ClusterFirstWithHostNet", tpl["dnsPolicy"] == "ClusterFirstWithHostNet"),
    ("imagePullPolicy is IfNotPresent", c["imagePullPolicy"] == "IfNotPresent"),
    ("image tag is not latest", not c["image"].endswith(":latest")),
    ("runAsNonRoot", tpl["securityContext"]["runAsNonRoot"] is True),
    ("readOnlyRootFilesystem", c["securityContext"]["readOnlyRootFilesystem"] is True),
    ("all capabilities dropped", c["securityContext"]["capabilities"]["drop"] == ["ALL"]),
    ("no cpu limit", "cpu" not in c["resources"].get("limits", {})),
    ("WVC_PUBLIC_IP from status.hostIP",
     env["WVC_PUBLIC_IP"]["valueFrom"]["fieldRef"]["fieldPath"] == "status.hostIP"),
    ("WVC_SECRET is not optional",
     not env["WVC_SECRET"]["valueFrom"]["secretKeyRef"].get("optional", False)),
    ("Service present", ("Service", "coyote") in docs),
    ("IngressRoute present", ("IngressRoute", "coyote") in docs),
    ("no Secret in the applied directory", ("Secret", "coyote") not in docs),
]
for name, ok in checks:
    print(("ok   " if ok else "FAIL ") + name)
sys.exit(1 if any(not ok for _, ok in checks) else 0)
PY
```

Expected: fifteen `ok` lines and exit 0. Any `FAIL` is a real defect — fix the
manifest, do not adjust the check.

Then confirm the template parses too, and is where it belongs:

```
python3 -c "import yaml;print(yaml.safe_load(open('deploy/secret.example.yaml'))['metadata']['name'])"
ls deploy/k8s/
```

Expected: prints `coyote`; the directory listing shows exactly three files and **no**
secret manifest.

- [ ] **Step 6: Commit**

```bash
git add deploy/
git commit -m "deploy: k3s manifests for coyote behind a Traefik ingress"
```

---

### Task 3: DEPLOY.md Kubernetes section

Documents both prior tasks: the build-and-import flow, the three constraints, and the firewall changes that differ from the systemd path.

**Files:**
- Modify: `docs/DEPLOY.md` (insert a new section between the **systemd unit** section and the **SwiftIRC / Anope integration** section)

**Interfaces:**
- Consumes: the image name/tag from Task 1 and the manifest paths from Task 2.

- [ ] **Step 1: Insert the Kubernetes section**

In `docs/DEPLOY.md`, immediately after the systemd unit section (it ends with the
`journalctl -u coyote -f` block and the paragraph about `server-restarting`) and
immediately before `## SwiftIRC / Anope integration: !vc → token link → join`,
insert:

````markdown
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
- a real tag, never `:latest` — `:latest` forces `imagePullPolicy: Always` whatever
  the manifest says.

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
````

- [ ] **Step 2: Verify the document still reads correctly**

Run:

```
grep -n "^## " docs/DEPLOY.md
```

Expected: the new `## Kubernetes (k3s + Traefik)` appears between `## systemd unit`
and `## SwiftIRC / Anope integration: !vc → token link → join`, and every other
top-level heading is unchanged and in its original order.

Then confirm the fenced blocks are balanced — the section nests fenced code inside a
fenced block, which is the easiest thing to get wrong here:

```
python3 -c "
import sys
n = sum(1 for l in open('docs/DEPLOY.md') if l.startswith('\`\`\`'))
print('fence markers:', n, 'balanced' if n % 2 == 0 else 'UNBALANCED')
sys.exit(0 if n % 2 == 0 else 1)"
```

Expected: an even count, reported `balanced`.

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOY.md
git commit -m "docs: deploying coyote on k3s behind Traefik"
```

---

## Self-Review

**Spec coverage:**
- Multi-stage distroless image, deps layer before source, `CGO_ENABLED=0 -trimpath -ldflags="-s -w"` → Task 1 Step 2.
- `COPY . .` justified by compile-time `//go:embed` → Task 1 Step 2 comment; enforced by Task 1 Step 6's scene count.
- `.dockerignore` with `filepath.Match` semantics, never excluding `internal/web/assets/` → Task 1 Step 1 and the Global Constraints.
- `USER 65532:65532`, `EXPOSE`, no `HEALTHCHECK` → Task 1 Step 2; verified Step 5.
- `replicas: 1` + `Recreate`; `hostNetwork` + `dnsPolicy`; `imagePullPolicy` + non-`latest` tag → Task 2 Step 1, verified executably in Step 5.
- `WVC_PUBLIC_IP` fieldRef with override commented → Task 2 Step 1.
- `WVC_SECRET` not optional → Task 2 Step 1, asserted in Step 5.
- `readOnlyRootFilesystem`, dropped caps, no CPU limit → Task 2 Step 1, asserted in Step 5.
- Service, IngressRoute, secret template → Task 2 Steps 2-4.
- Traefik v3 group, no WS config, no timeout tuning → Task 2 Step 3 comments and Task 3's Traefik notes.
- `DEPLOY.md` covering import flow, three constraints, firewall + XFF spoofing, licensing, smoke check → Task 3 Step 1.
- No code changes; suites stay green → Global Constraints, checked in Task 1 Step 7.
- Spec's edge cases (reschedule, missing secret, double pod, TLS with a read-only rootfs, clean-clone build) are each covered by a manifest comment or a `DEPLOY.md` paragraph above.

**Deviation from spec:** one, flagged prominently before Task 2 — the secret template
moves from `deploy/k8s/` to `deploy/`, because `kubectl apply -f deploy/k8s/` would
otherwise overwrite the real secret with `REPLACE_ME`. Task 2 Step 5 asserts no
Secret is in the applied directory.

**Placeholder scan:** No TBD/TODO. Every step carries complete file content or an
exact command with its expected output. Task 1 Step 3 anticipates a missing base
image tag with a concrete fallback order rather than leaving it open.

**Type consistency:** the tag `coyote:0.1.0` is identical in Task 1 Steps 3-6, Task 2
Step 1, and Task 3 Step 1. The Service name `coyote` and port 8080 match between the
Deployment's `containerPort`, the Service's `targetPort`, and the IngressRoute's
`services.port`. The Secret name `coyote` and key `secret` match between the
Deployment's `secretKeyRef`, the template, and the `kubectl create secret` line in
`DEPLOY.md`. UID 65532 matches between the Dockerfile's `USER`, the pod
`securityContext`, and Task 1 Step 5's expected output. `deploy/k8s/` contains
exactly the three files Task 2 Step 5 asserts.
