#!/usr/bin/env bash
# Non-interactive verify-scam-bot smoke for CI (Ubuntu + Git Bash on Windows).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/.cursor/skills/verify-scam-bot/bin"

export PUPPETEER_SKIP_DOWNLOAD="${PUPPETEER_SKIP_DOWNLOAD:-true}"

"$BIN/launch-stub"
"$BIN/doctor"
node "$BIN/drive-mask-before-llm"
node "$BIN/drive-agents-invariants"
node "$BIN/drive-malicious-host-block"
node "$BIN/drive-llm-review-cooldown"
"$BIN/cleanup"

echo "ci-verify-smoke: all drives passed"
