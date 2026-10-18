
# Build the React/Vite frontend.
FROM node:22-alpine AS frontend-build
WORKDIR /src

COPY client/package*.json ./client/
RUN cd client && npm ci

COPY client/ ./client/
COPY server/internal/web/ ./server/internal/web/

# Vite outputs to ../server/internal/web/dist.
RUN cd client && npm run build

# Compile the Go server with the built frontend embedded.
FROM golang:1.24-alpine AS go-build
WORKDIR /src/server

COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./
COPY --from=frontend-build /src/server/internal/web/dist ./internal/web/dist

RUN CGO_ENABLED=0 GOOS=linux \
    go build -trimpath -ldflags="-s -w" \
    -o /out/flako-server ./cmd/server

# Fetch and verify the pinned Litestream release (sha256 from the release's checksums.txt:
# https://github.com/benbjohnson/litestream/releases/download/v0.5.17/checksums.txt).
FROM alpine:3.22 AS litestream
ARG TARGETARCH
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256_AMD64=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
ARG LITESTREAM_SHA256_ARM64=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64; sha="$LITESTREAM_SHA256_AMD64" ;; \
      arm64) arch=arm64;  sha="$LITESTREAM_SHA256_ARM64" ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    f="litestream-${LITESTREAM_VERSION}-linux-${arch}.tar.gz"; \
    wget -q -O "/tmp/$f" "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/$f"; \
    echo "$sha  /tmp/$f" | sha256sum -c -; \
    tar -xzf "/tmp/$f" -C /usr/local/bin litestream

# Small runtime image; no Node or Go compiler needed.
FROM alpine:3.22 AS runtime
RUN apk add --no-cache ca-certificates sqlite \
    && addgroup -S app \
    && adduser -S -G app app \
    && mkdir -p /data \
    && chown app:app /data

WORKDIR /app
COPY --from=go-build /out/flako-server /usr/local/bin/flako-server
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY docker/entrypoint.sh docker/litestream.yml /app/
# Strip CRs in case the files were checked out with Windows line endings (breaks sh in Alpine).
RUN sed -i 's/\r$//' /app/entrypoint.sh /app/litestream.yml && chmod 755 /app/entrypoint.sh

ENV ADDR=:8080
ENV DB_PATH=/data/notes.db

EXPOSE 8080
USER app

# The entrypoint runs the server; with all R2_* vars set it also restores/streams the DB via
# Litestream, and with none set it behaves exactly like running flako-server directly.
ENTRYPOINT ["/app/entrypoint.sh"]
