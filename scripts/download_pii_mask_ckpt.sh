#!/usr/bin/env bash
# Download and hash-verify the published PII mask checkpoint.
# The frozen encoder (hfl/chinese-roberta-wwm-ext, ~400 MB) is NOT in this
# asset; Hugging Face Hub supplies it the first time jevlike_serve.py starts.
#
# Canonical release:
#   Tag:    jevlike-pii-mask-hn1
#   Asset:  jevlike_hf_pii_mask_hn1.pt
#   SHA256: b6b644cd377e3b82f6f44d83618fd043b341b04c6b6ca1778e2da35d5d35220a
#
# Usage:
#   scripts/download_pii_mask_ckpt.sh
#
# Writes models/jevlike_hf_pii_mask.pt by default. If JEVLIKE_MASK_CKPT is set,
# a relative value is resolved from the repo root. Set JEVLIKE_CKPT_FORCE=1 to
# replace an existing file.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="jevlike-pii-mask-hn1"
ASSET="jevlike_hf_pii_mask_hn1.pt"
EXPECTED_SHA256="b6b644cd377e3b82f6f44d83618fd043b341b04c6b6ca1778e2da35d5d35220a"
DEST="${JEVLIKE_MASK_CKPT:-$ROOT/models/jevlike_hf_pii_mask.pt}"
case "$DEST" in
  /*) ;;
  *) DEST="$ROOT/$DEST" ;;
esac

export JEVLIKE_RELEASE_TAG="$TAG"
export JEVLIKE_RELEASE_ASSET="$ASSET"
export JEVLIKE_CKPT="$DEST"

"$ROOT/scripts/download_jevlike_ckpt.sh"

sha256_of_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    local py
    py="$(command -v python3 || command -v python || true)"
    if [[ -z "$py" ]]; then
      echo "[ERROR] cannot verify SHA-256: no sha256sum, shasum, or python on PATH" >&2
      return 1
    fi
    "$py" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$file"
  fi
}

actual="$(sha256_of_file "$DEST")"
if [[ "$actual" != "$EXPECTED_SHA256" ]]; then
  echo "[ERROR] SHA-256 mismatch for $DEST" >&2
  echo "[ERROR] got:      $actual" >&2
  echo "[ERROR] expected: $EXPECTED_SHA256" >&2
  echo "[ERROR] remove the file or rerun with JEVLIKE_CKPT_FORCE=1 after checking why it differs" >&2
  exit 1
fi

echo "[OK] sha256 verified for PII mask checkpoint: $EXPECTED_SHA256"
echo "[INFO] worker path: $DEST"
