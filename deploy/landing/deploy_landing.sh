#!/usr/bin/env bash
#
# Deploy landing page to Raspberry Pi
#
# Deploys the landing page static files and server behind the existing
# cloudflared tunnel.
#
# Configuration lives in deploy.config (copy deploy.config.example to start).
# Service: funstuff-landing
#
# Usage:
#   ./deploy_landing.sh              # Full deploy
#   ./deploy_landing.sh --files-only # Only sync files, skip service setup

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/deploy.config"
if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
else
    echo "Error: No deploy.config found. Copy deploy.config.example and customize." >&2
    exit 1
fi

if [[ -z "${PI_HOST:-}" || -z "${PI_USER:-}" ]]; then
    echo "Error: PI_HOST and PI_USER must be set in deploy.config" >&2
    exit 1
fi
PI_TARGET="${PI_USER}@${PI_HOST}"

SERVICE_NAME="funstuff-landing"
INSTALL_DIR="/home/${PI_USER}/funstuff"
LANDING_PORT="8767"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

FILES_ONLY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --files-only)
            FILES_ONLY=true
            shift
            ;;
        --host)
            PI_HOST="$2"
            PI_TARGET="${PI_USER}@${PI_HOST}"
            shift 2
            ;;
        --user)
            PI_USER="$2"
            PI_TARGET="${PI_USER}@${PI_HOST}"
            shift 2
            ;;
        *)
            log_error "Unknown argument: $1"
            exit 1
            ;;
    esac
done

# ─────────────────────────────────────────────────────────────────────────────
# Verify local files exist
# ─────────────────────────────────────────────────────────────────────────────
log_step "Checking local files..."

LANDING_DIR="$REPO_ROOT/landing"
SERVER_FILE="$REPO_ROOT/landing_server.py"

if [[ ! -d "$LANDING_DIR" ]]; then
  log_error "Landing directory not found: $LANDING_DIR"
  exit 1
fi

if [[ ! -f "$SERVER_FILE" ]]; then
  log_error "Server file not found: $SERVER_FILE"
  exit 1
fi

if [[ ! -f "$LANDING_DIR/index.html" ]]; then
  log_error "index.html not found in $LANDING_DIR"
  exit 1
fi

log_info "Local files OK"

# ─────────────────────────────────────────────────────────────────────────────
# Test SSH connectivity
# ─────────────────────────────────────────────────────────────────────────────
log_step "Testing SSH to ${PI_TARGET}..."
if ! ssh -o ConnectTimeout=5 "$PI_TARGET" 'echo ok' >/dev/null 2>&1; then
  log_error "Cannot SSH to $PI_TARGET"
  exit 1
fi
log_info "SSH OK"

# ─────────────────────────────────────────────────────────────────────────────
# Create install directory on Pi
# ─────────────────────────────────────────────────────────────────────────────
log_step "Creating ${INSTALL_DIR} on Pi..."
ssh "$PI_TARGET" "mkdir -p ${INSTALL_DIR}/landing"

# ─────────────────────────────────────────────────────────────────────────────
# Sync files
# ─────────────────────────────────────────────────────────────────────────────
log_step "Syncing landing page files..."

rsync -avz --delete \
  --exclude='mp3s/' \
  "$LANDING_DIR/" \
  "${PI_TARGET}:${INSTALL_DIR}/landing/"

log_step "Syncing server..."
rsync -avz \
  "$SERVER_FILE" \
  "${PI_TARGET}:${INSTALL_DIR}/landing_server.py"

log_info "Files synced"

if [[ "$FILES_ONLY" == true ]]; then
  log_info "Files-only mode. Restarting service..."
  ssh -t "$PI_TARGET" "sudo systemctl restart ${SERVICE_NAME} 2>/dev/null || true"
  log_info "Done (files only)"
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Install systemd service
# ─────────────────────────────────────────────────────────────────────────────
log_step "Installing systemd service..."

# Substitute PI_USER into service file
service_content=$(sed "s/__PI_USER__/${PI_USER}/g" "$SCRIPT_DIR/funstuff-landing.service")
echo "$service_content" | ssh "$PI_TARGET" "cat > /tmp/${SERVICE_NAME}.service"

log_info "You may be prompted for the Pi sudo password..."
ssh -t "$PI_TARGET" "
  sudo mv /tmp/${SERVICE_NAME}.service /etc/systemd/system/${SERVICE_NAME}.service &&
  sudo systemctl daemon-reload &&
  sudo systemctl enable ${SERVICE_NAME} &&
  sudo systemctl restart ${SERVICE_NAME}
"

log_info "Service installed and started"

# ─────────────────────────────────────────────────────────────────────────────
# Verify
# ─────────────────────────────────────────────────────────────────────────────
log_step "Verifying service..."
sleep 2
STATUS=$(ssh "$PI_TARGET" "systemctl is-active ${SERVICE_NAME} 2>/dev/null || echo 'inactive'")
if [[ "$STATUS" == "active" ]]; then
  log_info "Service is running"
else
  log_error "Service status: $STATUS"
  ssh "$PI_TARGET" "sudo journalctl -u ${SERVICE_NAME} -n 10 --no-pager"
  exit 1
fi

# Quick HTTP check on the Pi itself
RESPONSE=$(ssh "$PI_TARGET" "curl -s -o /dev/null -w '%{http_code}' http://localhost:${LANDING_PORT}/ 2>/dev/null || echo '000'")
if [[ "$RESPONSE" == "200" ]]; then
  log_info "Landing page responding (HTTP $RESPONSE)"
else
  log_warn "Landing page returned HTTP $RESPONSE (may still be starting)"
fi

echo ""
log_info "════════════════════════════════════════════════════════"
log_info " Landing page deployed!"
log_info ""
log_info " Internal: http://${PI_HOST}:${LANDING_PORT}/"
log_info ""
log_info " To expose publicly, see deploy/landing/setup_tunnel.sh"
log_info "════════════════════════════════════════════════════════"
