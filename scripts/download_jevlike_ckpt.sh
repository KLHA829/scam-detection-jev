#!/usr/bin/env bash
# Download the jevlike HF-encoder head checkpoint from GitHub Releases.
# The frozen encoder (hfl/chinese-roberta-wwm-ext, ~400 MB) is NOT in this
# asset; Hugging Face Hub supplies it the first time jevlike_serve.py starts.
#
# Usage:
#   scripts/download_jevlike_ckpt.sh
#   JEVLIKE_RELEASE_TAG=jevlike-hf-hn800 scripts/download_jevlike_ckpt.sh
#
# Private repo: `gh` must be logged in, or set GH_TOKEN / GITHUB_TOKEN.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${JEVLIKE_RELEASE_REPO:-KLHA829/scam-detection-jev}"
TAG="${JEVLIKE_RELEASE_TAG:-jevlike-hf-hn800}"
ASSET="${JEVLIKE_RELEASE_ASSET:-jevlike_hf_chinese_roberta_hn800.pt}"
DEST="${JEVLIKE_CKPT:-$ROOT/models/jevlike_hf_chinese_roberta.pt}"
DIR="$(dirname "$DEST")"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

mkdir -p "$DIR"

download_with_gh() {
  echo "[INFO] gh release download $TAG ($ASSET) from $REPO"
  gh release download "$TAG" \
    --repo "$REPO" \
    --pattern "$ASSET" \
    --dir "$DIR" \
    --clobber
}

asset_api_url() {
  local api="https://api.github.com/repos/${REPO}/releases/tags/${TAG}"
  local hdr=(-sS -H "Accept: application/vnd.github+json")
  if [[ -n "$TOKEN" ]]; then
    hdr+=(-H "Authorization: Bearer ${TOKEN}")
  fi
  curl "${hdr[@]}" "$api" | python3 -c "
import json, sys
data = json.load(sys.stdin)
want = '''${ASSET}'''
assets = data.get('assets') or []
for row in assets:
    if row.get('name') == want:
        print(row.get('url') or '')
        sys.exit(0)
raise SystemExit('asset not found: ' + want)
"
}

download_with_curl() {
  local url
  url="$(asset_api_url)"
  if [[ -z "$url" ]]; then
    echo "[ERROR] could not resolve asset URL for $ASSET in $TAG" >&2
    return 1
  fi
  echo "[INFO] curl asset $ASSET from $REPO@$TAG"
  local hdr=(-sSL -H "Accept: application/octet-stream")
  if [[ -n "$TOKEN" ]]; then
    hdr+=(-H "Authorization: Bearer ${TOKEN}")
  fi
  curl "${hdr[@]}" "$url" -o "$DIR/$ASSET"
}

if command -v gh >/dev/null 2>&1; then
  download_with_gh
else
  echo "[INFO] gh not found; using curl + GitHub API"
  download_with_curl
fi

SRC="$DIR/$ASSET"
if [[ ! -f "$SRC" ]]; then
  echo "[ERROR] expected $SRC after download" >&2
  exit 1
fi

if [[ "$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")" != "$(cd "$(dirname "$DEST")" && pwd)/$(basename "$DEST")" ]]; then
  cp -f "$SRC" "$DEST"
  echo "[OK] copied $SRC -> $DEST"
else
  echo "[OK] checkpoint at $DEST"
fi

ls -lh "$SRC" "$DEST" 2>/dev/null | uniq
echo "[INFO] Set JEVLIKE_CKPT=$DEST (or keep the default models/ path)."
echo "[INFO] First worker start still downloads ${JEVLIKE_ENCODER:-hfl/chinese-roberta-wwm-ext} from Hugging Face (~400 MB)."
