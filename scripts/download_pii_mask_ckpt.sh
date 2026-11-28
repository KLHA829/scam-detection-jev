#!/usr/bin/env bash
# Download and hash-verify the published PII mask checkpoint.
# The frozen encoder (hfl/chinese-roberta-wwm-ext, ~400 MB) is NOT in this
# asset; Hugging Face Hub supplies it the first time jevlike_serve.py starts.
#
# Canonical release:
#   Tag:    jevlike-pii-mask-hn2
#   Asset:  jevlike_hf_pii_mask_hn2.pt
#   SHA256: 55a52625d328f58e5aa227039b31f83308f8a5e2b233ca61ad7de614a8a9a5fa
#
# Usage:
#   scripts/download_pii_mask_ckpt.sh
#
# Writes models/jevlike_hf_pii_mask.pt by default. If JEVLIKE_MASK_CKPT is set,
# a relative value is resolved from the repo root. Set JEVLIKE_CKPT_FORCE=1 to
# replace an existing file.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${JEVLIKE_RELEASE_REPO:-KLHA829/scam-detection-jev}"
TAG="jevlike-pii-mask-hn2"
ASSET="jevlike_hf_pii_mask_hn2.pt"
EXPECTED_SHA256="55a52625d328f58e5aa227039b31f83308f8a5e2b233ca61ad7de614a8a9a5fa"
DEST="${JEVLIKE_MASK_CKPT:-$ROOT/models/jevlike_hf_pii_mask.pt}"
case "$DEST" in
  /*) ;;
  *) DEST="$ROOT/$DEST" ;;
esac
DIR="$(dirname "$DEST")"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
# Windows ships `python`, not `python3` (a Windows venv has only python.exe), so the
# API fallback cannot assume the POSIX name.
PY="$(command -v python3 || command -v python || true)"
DOWNLOAD_URL="${JEVLIKE_DOWNLOAD_URL:-https://github.com/${REPO}/releases/download/${TAG}/${ASSET}}"
MIN_BYTES="${JEVLIKE_CKPT_MIN_BYTES:-1000000}"

mkdir -p "$DIR"
TMP="$DIR/.${ASSET}.partial"
SRC="$DIR/$ASSET"

looks_like_checkpoint() {
  local path="$1"
  [[ -f "$path" ]] || return 1
  local size
  size="$(wc -c < "$path" | tr -d ' ')"
  if [[ "$size" -lt "$MIN_BYTES" ]]; then
    echo "[WARN] $path is ${size} bytes (want >= ${MIN_BYTES}; likely an HTML login page)" >&2
    return 1
  fi
  if head -c 256 "$path" | grep -qiE '<html|<!doctype'; then
    echo "[WARN] $path looks like HTML, not a .pt checkpoint" >&2
    return 1
  fi
  return 0
}

sha256_of_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    if [[ -z "$PY" ]]; then
      echo "[ERROR] cannot verify SHA-256: no sha256sum, shasum, or python on PATH" >&2
      return 1
    fi
    "$PY" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$file"
  fi
}

download_direct() {
  echo "[INFO] trying $DOWNLOAD_URL"
  local hdr=(-sSL --fail --location --output "$TMP")
  if [[ -n "$TOKEN" ]]; then
    hdr+=(-H "Authorization: Bearer ${TOKEN}")
    hdr+=(-H "Accept: application/octet-stream")
  fi
  if curl "${hdr[@]}" "$DOWNLOAD_URL" 2>/dev/null; then
    mv -f "$TMP" "$SRC"
    return 0
  fi
  rm -f "$TMP"
  return 1
}

download_with_gh() {
  echo "[INFO] gh release download $TAG ($ASSET) from $REPO"
  # Run from $DIR with a relative --dir. gh is a native binary on Windows and does
  # not translate MSYS paths: given /c/Users/... it writes to C:\c\Users\... instead
  # — silently, exit 0 — so the checkpoint lands outside the repo and the caller's
  # existence check fails. A relative --dir sidesteps path translation entirely.
  (
    cd "$DIR" || exit 1
    gh release download "$TAG" \
      --repo "$REPO" \
      --pattern "$ASSET" \
      --dir . \
      --clobber
  )
}

download_with_api() {
  local api="https://api.github.com/repos/${REPO}/releases/tags/${TAG}"
  echo "[INFO] GitHub API $api → asset $ASSET"
  local hdr=(-sS -H "Accept: application/vnd.github+json")
  if [[ -n "$TOKEN" ]]; then
    hdr+=(-H "Authorization: Bearer ${TOKEN}")
  fi
  local asset_url
  if [[ -z "$PY" ]]; then
    echo "[ERROR] no python3/python on PATH; cannot parse the release API response" >&2
    return 1
  fi
  asset_url="$(
    curl "${hdr[@]}" "$api" | "$PY" -c "
import json, sys
data = json.load(sys.stdin)
want = '''${ASSET}'''
for row in data.get('assets') or []:
    if row.get('name') == want:
        print(row.get('url') or '')
        sys.exit(0)
raise SystemExit('asset not found: ' + want)
"
  )"
  if [[ -z "$asset_url" ]]; then
    echo "[ERROR] could not resolve asset API URL for $ASSET in $TAG" >&2
    return 1
  fi
  local dl=(-sSL --fail -H "Accept: application/octet-stream")
  if [[ -n "$TOKEN" ]]; then
    dl+=(-H "Authorization: Bearer ${TOKEN}")
  fi
  curl "${dl[@]}" "$asset_url" -o "$TMP"
  mv -f "$TMP" "$SRC"
}

if [[ "${JEVLIKE_CKPT_FORCE:-0}" != "1" ]] && looks_like_checkpoint "$DEST"; then
  echo "[OK] already have $DEST ($(ls -lh "$DEST" | awk '{print $5}'))"
else
  ok=0
  if download_direct && looks_like_checkpoint "$SRC"; then
    ok=1
  else
    echo "[INFO] browser URL needs a logged-in session on a private repo; falling back to gh / API"
    rm -f "$TMP"
    if command -v gh >/dev/null 2>&1 && download_with_gh && looks_like_checkpoint "$SRC"; then
      ok=1
    elif download_with_api && looks_like_checkpoint "$SRC"; then
      ok=1
    fi
  fi

  if [[ "$ok" -ne 1 ]]; then
    echo "[ERROR] failed to download $ASSET from $DOWNLOAD_URL" >&2
    echo "[ERROR] Release page: https://github.com/${REPO}/releases/tag/${TAG}" >&2
    echo "[ERROR] For a private repo, run: gh auth login   (or set GH_TOKEN)" >&2
    exit 1
  fi

  if [[ "$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")" != "$(cd "$(dirname "$DEST")" && pwd)/$(basename "$DEST")" ]]; then
    cp -f "$SRC" "$DEST"
    echo "[OK] copied $SRC -> $DEST"
  else
    echo "[OK] checkpoint at $DEST"
  fi
fi

actual="$(sha256_of_file "$DEST")"
if [[ "$actual" != "$EXPECTED_SHA256" ]]; then
  echo "[ERROR] SHA-256 mismatch for $DEST" >&2
  echo "[ERROR] got:      $actual" >&2
  echo "[ERROR] expected: $EXPECTED_SHA256" >&2
  echo "[ERROR] remove the file or rerun with JEVLIKE_CKPT_FORCE=1 after checking why it differs" >&2
  exit 1
fi

echo "[OK] sha256 verified for PII mask checkpoint: $EXPECTED_SHA256"
echo "[INFO] Set JEVLIKE_MASK_CKPT=$DEST (or keep the default models/ path)."
echo "[INFO] First worker start still downloads ${JEVLIKE_ENCODER:-hfl/chinese-roberta-wwm-ext} from Hugging Face (~400 MB)."
