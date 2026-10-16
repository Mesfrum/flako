
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
    -o /out/shribe-server ./cmd/server

# Small runtime image; no Node or Go compiler needed.
FROM alpine:3.22 AS runtime
RUN apk add --no-cache ca-certificates \
    && addgroup -S app \
    && adduser -S -G app app \
    && mkdir -p /data \
    && chown app:app /data

WORKDIR /app
COPY --from=go-build /out/shribe-server /usr/local/bin/shribe-server

ENV ADDR=:8080
ENV DB_PATH=/data/notes.db

EXPOSE 8080
USER app

ENTRYPOINT ["/usr/local/bin/shribe-server"]
