#!/usr/bin/env bash
set -euo pipefail

# Safe local deploy (default target: ~/.local/mobileair)
# - Does NOT rm -rf the target directory
# - Copies build artifacts into place without nuking the directory
# - Optional: use a staging dir + atomic swap with a timestamped backup
#
# Usage:
#   ./deploy_local_safe.sh
#   ./deploy_local_safe.sh --in-place
#   ./deploy_local_safe.sh --target "$HOME/.local/mobileair" --in-place

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO_ROOT/dist/mobileair_bundle"
TS="$(date +%Y%m%d-%H%M%S)"

TARGET="${HOME}/.local/mobileair"
IN_PLACE=0
WRAPPER_DIR="${HOME}/.local/bin"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --wrapper-dir)
      WRAPPER_DIR="${2:-}"
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

if [[ -z "$WRAPPER_DIR" ]]; then
  echo "ERROR: --wrapper-dir requires a directory path" >&2
  exit 2
fi

STAGING="$TARGET.__staging"
BACKUP="$TARGET.backup-$TS"

install_wrapper() {
  local wrapperDir="$WRAPPER_DIR"
  mkdir -p "$wrapperDir"
  local wrapperPath="$wrapperDir/mobileair"

  # IMPORTANT: do NOT symlink the binary into PATH; PyInstaller one-folder builds
  # expect _internal next to the executable. Use a wrapper that execs the real binary.
  cat > "$wrapperPath" <<EOF
#!/usr/bin/env bash
exec "${TARGET}/mobileair" "\$@"
EOF
  chmod +x "$wrapperPath"

  echo "Installed command: $wrapperPath"

  # Show what the current shell would run (helps when an older /usr/local/bin/mobileair shadows this).
  local resolved
  resolved="$(command -v mobileair 2>/dev/null || true)"
  if [[ -n "$resolved" ]]; then
    echo "PATH resolves 'mobileair' to: $resolved"
    if [[ "$resolved" != "$wrapperPath" ]]; then
      echo "WARNING: Another 'mobileair' earlier on PATH is shadowing the wrapper."
      echo "Run: which -a mobileair"
    fi
  else
    echo "NOTE: 'mobileair' is not currently on PATH in this shell."
  fi

  echo "If 'mobileair' is not found, ensure this is on your PATH:"
  echo "  export PATH=\"${wrapperDir}:\$PATH\""
}

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
  install_wrapper
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

# Ad-hoc code sign the binary at its FINAL path to prevent macOS firewall prompts.
# The firewall tracks by path + signature. Signing after mv ensures path is stable.
# The '-' identity means ad-hoc (no Apple Developer ID required).
if command -v codesign &>/dev/null; then
  codesign --force --deep --sign - "$TARGET/mobileair" 2>/dev/null || true
fi

# Add to macOS firewall allowlist to prevent "accept incoming connections" prompts.
# This requires sudo but only needs to be done once per path.
FIREWALL_CMD="/usr/libexec/ApplicationFirewall/socketfilterfw"
if [[ -x "$FIREWALL_CMD" ]]; then
  echo "Adding to macOS firewall allowlist (may require sudo password)..."
  # Remove any stale rule first, then add fresh
  sudo "$FIREWALL_CMD" --remove "$TARGET/mobileair" >/dev/null 2>&1 || true
  sudo "$FIREWALL_CMD" --add "$TARGET/mobileair"
  sudo "$FIREWALL_CMD" --unblockapp "$TARGET/mobileair"
fi

install_wrapper

# Note: leave backup in place so rollback is easy.
echo "Done. Backup at: $BACKUP"
