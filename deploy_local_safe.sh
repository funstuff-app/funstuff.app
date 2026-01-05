#!/usr/bin/env bash
set -euo pipefail

# Safe local deploy (default target: /opt/mobileair)
# - Does NOT rm -rf the target directory
# - Copies build artifacts into place without nuking the directory
# - Optional: use a staging dir + atomic swap with a timestamped backup
#
# Usage:
#   ./deploy_local_safe.sh
#   ./deploy_local_safe.sh --in-place
#   ./deploy_local_safe.sh --target "$HOME/Applications/mobileair"
#   ./deploy_local_safe.sh --target "$HOME/Applications/mobileair" --in-place

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO_ROOT/dist/mobileair"
TS="$(date +%Y%m%d-%H%M%S)"

TARGET="/opt/mobileair"
IN_PLACE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --in-place)
      IN_PLACE=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--target DIR] [--in-place]";
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "ERROR: --target requires a directory path" >&2
  exit 2
fi

STAGING="$TARGET.__staging"
BACKUP="$TARGET.backup-$TS"

sudo_if_needed() {
  local cmd="$1"
  shift
  local pathArg=""
  if [[ $# -gt 0 ]]; then
    pathArg="${@: -1}"
  fi

  if [[ -n "$pathArg" && ( "$cmd" == "mkdir" || "$cmd" == "rm" || "$cmd" == "rsync" || "$cmd" == "mv" ) ]]; then
    local parent
    parent="$(dirname "$pathArg")"
    if [[ -w "$parent" ]]; then
      "$cmd" "$@"
      return
    fi
  fi

  sudo "$cmd" "$@"
}

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: Build output not found: $SRC" >&2
  echo "Run: python -m PyInstaller --noconfirm --clean mobileair.spec" >&2
  exit 1
fi

if [[ "$IN_PLACE" == "1" ]]; then
  echo "Deploying in-place to $TARGET (no deletes; may leave stale files)..."
  sudo_if_needed mkdir -p "$TARGET"
  sudo_if_needed rsync -a "$SRC/" "$TARGET/"
  echo "Done."
  exit 0
fi

echo "Deploying via staging + swap to $TARGET"

sudo_if_needed rm -rf "$STAGING" || true
sudo_if_needed mkdir -p "$STAGING"

# Make staging match the build output exactly.
sudo_if_needed rsync -a --delete "$SRC/" "$STAGING/"

# Backup current (if exists), then swap.
if [[ -d "$TARGET" ]]; then
  sudo_if_needed mv "$TARGET" "$BACKUP"
fi
sudo_if_needed mv "$STAGING" "$TARGET"

# Note: leave backup in place so rollback is easy.
echo "Done. Backup at: $BACKUP"
