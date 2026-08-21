# syntax=docker/dockerfile:1

FROM golang:1.26.1-alpine AS build
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
