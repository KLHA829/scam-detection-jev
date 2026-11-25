# WhatsApp transport (whatsmeow / Docker)

Chromium-free `WaTransport` adapter (`WA_TRANSPORT=whatsmeow`) connecting over loopback HTTP/SSE to the pure-Go `wa-bridge/` sidecar, plus multi-stage Linux Docker packaging in [`Dockerfile`](../../../Dockerfile). Runtime `resolveTransportName` in `lib/wa-transport/index.js` keeps `wwebjs` as the default fallback until manual live QR validation is completed; `Dockerfile` defaults to `WA_TRANSPORT=whatsmeow` with `/data` state paths.

## Sub-features

- **Transport selection & contract** (`lib/wa-transport/index.js`, `lib/wa-transport/contract.test.js`): `resolveTransportName` returns `wwebjs` when unset, selects `createWhatsmeowTransport` for `WA_TRANSPORT=whatsmeow`, and throws on unsupported transport names.
- **Loopback HTTP/SSE adapter & auto-start** (`lib/wa-transport/whatsmeow.js`, `lib/wa-transport/whatsmeow.test.js`): `validateBridgeBaseUrl` restricts `WA_BRIDGE_URL` (default `http://127.0.0.1:8767`) to loopback (`127.*`, `localhost`, `::1`, `http://` only when auto-starting), optionally starts `WA_BRIDGE_BIN` (`wa-bridge/wa-bridge[.exe]`) via `WA_BRIDGE_AUTO_START`, and stores SSE cursors plus handled self message IDs in `WA_BRIDGE_CURSOR_PATH` (default `./wa-bridge-cursor.json`).
- **Pure-Go sidecar** (`wa-bridge/`): Go module using `go.whatsmeow` and pure-Go SQLite (`WA_BRIDGE_DB_PATH`) with unit tests in `wa-bridge/bridge_test.go`.
- **Cross-platform build helper** (`scripts/build-wa-bridge.js`, `npm run wa-bridge:build`): builds `CGO_ENABLED=0` binaries (`wa-bridge/wa-bridge[.exe]` for native host builds, or `wa-bridge/wa-bridge-<goos>-<goarch>[.exe]` when cross-compiling with `--goos`/`--goarch` unless `--out` is given).
- **Linux Docker packaging** (`Dockerfile`, `.dockerignore`): two-stage `golang:1.26-bookworm` builder + `node:22-bookworm-slim` runtime setting `PUPPETEER_SKIP_DOWNLOAD=true`, `WA_TRANSPORT=whatsmeow`, `WA_BRIDGE_AUTO_START=1`, `WA_BRIDGE_BIN=/app/wa-bridge/wa-bridge`, and `/data` persistence paths (`WA_BRIDGE_DB_PATH`, `WA_BRIDGE_CURSOR_PATH`, `OPERATOR_MODE_PATH`, `REVIEW_QUEUE_PATH`, `LLM_REVIEW_COOLDOWN_PATH`, `BOT_CONTACT_NAMES_PATH`, `USER_RESTORED_CHATS_PATH`, `BLOCK_LOG_PATH`). `.dockerignore` excludes local `wa-data`, `wa-bridge/wa-bridge-*`, `**/wa-bridge.db*`, and `**/wa-bridge-cursor.json`.

## How to get to it (user POV)

1. Build the native sidecar (`npm run wa-bridge:build`) and set `WA_TRANSPORT=whatsmeow` (plus `WA_BRIDGE_AUTO_START=1` or point `WA_BRIDGE_URL` to a running `wa-bridge`).
2. Start the live PII mask worker (`JEVLIKE_MASK_CKPT` exported), then run `npm start` and scan the terminal QR code once to link the WhatsApp Web device.
3. For Docker, build `docker build -t scam-detection-jev .` and mount a persistent volume at `/data` (passing `JEVLIKE_BASE_URL` and `LLM_REVIEW_*` via env).

## Driving it with verify-scam-bot

Keep offline verification separate from live-network QR boot smoke and manual Docker checks:

1. **Offline adapter & Go sidecar verification** (no stub HTTP server or WhatsApp connection needed):

   ```bash
   node --test lib/wa-transport/contract.test.js lib/wa-transport/whatsmeow.test.js
   node scripts/build-wa-bridge.js --goos linux --goarch amd64
   (cd wa-bridge && go vet ./... && go test -v ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" .)
   ```

   On Linux CI (`ubuntu-latest` in `.github/workflows/test.yml`), run `go test -race ./...` inside `wa-bridge/`. Also check full repo compatibility with `npm test`, `npm run lint`, and `npm run typecheck`.

2. **Best-effort live QR boot smoke** (no QR scan; connects only far enough to emit `scan QR to link WhatsApp Web`):

   ```bash
   npm run test:e2e:boot:whatsmeow
   ```

   `scripts/e2e-boot-qr.js --transport whatsmeow` compiles `wa-bridge` into a temp binary, starts an isolated runtime dir with an in-process stub mask server and mock OpenAI completion server, verifies `[INFO] scan QR to link WhatsApp Web`, and stops the process tree cleanly. Marked `continue-on-error: true` in CI because it depends on outbound WhatsApp server reachability.

3. **Manual Docker build / `/data` runtime check** (requires a running Docker daemon; not executed by `npm test`):

   Build `docker build -t scam-detection-jev .` and run with a fresh mounted `/data` volume to verify `/data` state file creation and QR boot output without Chromium installed.

## Gotchas

- `npm test` covers `lib/wa-transport/*.test.js` and `scripts/build-wa-bridge` via Node tests, not Go tests in `wa-bridge/` or `docker build`.
- Leaving `WA_TRANSPORT` unset selects `wwebjs` locally (`resolveTransportName`), whereas `Dockerfile` bakes in `WA_TRANSPORT=whatsmeow`.
- `go test -race ./...` needs CGO (`gcc`); on Windows hosts without `gcc`, run `go test -v ./...` alongside `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"`.
- On Windows, `scripts/e2e-boot-qr.js` and local loopback tests can occasionally hit a transient `WSAEADDRINUSE` port race when binding ephemeral sockets immediately before handing a port to `wa-bridge`.
