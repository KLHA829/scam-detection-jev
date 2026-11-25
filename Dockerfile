FROM golang:1.26-bookworm AS wa-bridge-builder

WORKDIR /src/wa-bridge
COPY wa-bridge/go.mod wa-bridge/go.sum ./
RUN go mod download

COPY wa-bridge/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/wa-bridge .

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    WA_TRANSPORT=whatsmeow \
    WA_BRIDGE_AUTO_START=1 \
    WA_BRIDGE_BIN=/app/wa-bridge/wa-bridge \
    WA_BRIDGE_DB_PATH=/data/wa-bridge.db \
    WA_BRIDGE_CURSOR_PATH=/data/wa-bridge-cursor.json \
    OPERATOR_MODE_PATH=/data/operator-mode.json \
    REVIEW_QUEUE_PATH=/data/review-queue.json \
    LLM_REVIEW_COOLDOWN_PATH=/data/llm-review-cooldown.json \
    BOT_CONTACT_NAMES_PATH=/data/bot-contact-names.json \
    USER_RESTORED_CHATS_PATH=/data/user-restored-chats.json \
    BLOCK_LOG_PATH=/data/blocks.jsonl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
COPY --from=wa-bridge-builder /out/wa-bridge /app/wa-bridge/wa-bridge
RUN mkdir -p /data && chown -R node:node /app /data

USER node
VOLUME ["/data"]

CMD ["node", "whatsapp-bot.js"]
