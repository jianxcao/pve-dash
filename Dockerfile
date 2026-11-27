# syntax=docker/dockerfile:1

# --- Stage 1: Build Frontend SPA Assets (native host arch via $BUILDPLATFORM) ---
FROM --platform=$BUILDPLATFORM node:22-alpine AS web-builder
WORKDIR /src/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN ./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build

# --- Stage 2: Cross-Compile Pure-Go Single Binary ---
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS go-builder
ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
ARG COMMIT=none
ARG BUILD_TIME=unknown

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY web/embed.go ./web/embed.go
COPY --from=web-builder /src/web/dist ./web/dist

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath \
    -ldflags "-s -w -X github.com/jianxcao/pve-dash/internal/version.Version=${VERSION} -X github.com/jianxcao/pve-dash/internal/version.Commit=${COMMIT} -X github.com/jianxcao/pve-dash/internal/version.BuildTime=${BUILD_TIME}" \
    -o /out/pve-dash ./cmd/pve-dash

# --- Stage 3: Minimal Alpine Runtime ---
FROM alpine:3.21

LABEL org.opencontainers.image.title="PVE Dash" \
      org.opencontainers.image.description="Modern multi-cluster Proxmox VE control plane (single binary + PWA)" \
      org.opencontainers.image.source="https://github.com/jianxcao/pve-dash" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache ca-certificates tzdata openssh-client && \
    mkdir -p /app/data && \
    chmod 0700 /app/data

WORKDIR /app
COPY --from=go-builder /out/pve-dash /app/pve-dash

ENV PVE_DASH_LISTEN=:8080 \
    PVE_DASH_DATA_DIR=/app/data \
    TZ=UTC

VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/app/pve-dash"]
