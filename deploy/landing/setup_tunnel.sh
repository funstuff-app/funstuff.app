#!/usr/bin/env bash
#
# One-time setup: Cloudflare Tunnel for Pi services
#
# This script:
#   1. Installs cloudflared on the Pi (if not present)
#   2. Creates a named tunnel (if not present)
#   3. Writes the ingress config (~/.cloudflared/config.yml)
#   4. Installs cloudflared as a systemd service
#
# After running this, you still need to add DNS records in Cloudflare:
#   cloudflared tunnel route dns <TUNNEL_NAME> <each hostname>
# Or manually add CNAME records pointing to <tunnel-id>.cfargotunnel.com
#
# Prerequisites:
#   - cloudflared must be authenticated on the Pi:
#       ssh <pi> 'cloudflared tunnel login'
#     This opens a browser to authorize your Cloudflare account and saves
#     a cert at ~/.cloudflared/cert.pem
#
# Usage:
#   ./setup_tunnel.sh

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Configuration — edit these for your setup
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/tunnel.config"
if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
else
    echo "Error: No tunnel.config found. Copy tunnel.config.example and customize." >&2
    exit 1
fi

# Validate required config
for var in PI_HOST PI_USER TUNNEL_NAME DASHBOARD_DOMAIN DASHBOARD_PORT LANDING_DOMAIN LANDING_DOMAIN_WWW LANDING_PORT; do
    if [[ -z "${!var:-}" ]]; then
        echo "Error: $var must be set in tunnel.config" >&2
        exit 1
    fi
done

PI_TARGET="${PI_USER}@${PI_HOST}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  Cloudflare Tunnel Setup"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "  Target:     $PI_TARGET"
echo "  Tunnel:     $TUNNEL_NAME"
echo "  Dashboard:  $DASHBOARD_DOMAIN → localhost:$DASHBOARD_PORT"
echo "  Landing:    $LANDING_DOMAIN → localhost:$LANDING_PORT"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Check SSH
# ─────────────────────────────────────────────────────────────────────────────
log_step "Testing SSH to $PI_TARGET..."
if ! ssh -o ConnectTimeout=5 "$PI_TARGET" "echo ok" &>/dev/null; then
    log_error "Cannot SSH to $PI_TARGET"
    exit 1
fi
log_info "SSH OK"

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Check cloudflared is installed
# ─────────────────────────────────────────────────────────────────────────────
log_step "Checking cloudflared..."
if ! ssh "$PI_TARGET" "command -v cloudflared" &>/dev/null; then
    log_error "cloudflared is not installed on the Pi."
    echo ""
    echo "  Install it first:"
    echo "    ssh $PI_TARGET"
    echo "    curl -L https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-archive-keyring.gpg > /dev/null"
    echo "    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-archive-keyring.gpg] https://pkg.cloudflare.com/cloudflared \$(lsb_release -cs) main' | sudo tee /etc/apt/sources.list.d/cloudflared.list"
    echo "    sudo apt update && sudo apt install cloudflared"
    echo ""
    echo "  Then authenticate:"
    echo "    cloudflared tunnel login"
    echo ""
    exit 1
fi
log_info "cloudflared installed: $(ssh "$PI_TARGET" "cloudflared --version 2>&1 | head -1")"

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Check authentication
# ─────────────────────────────────────────────────────────────────────────────
log_step "Checking cloudflared authentication..."
if ! ssh "$PI_TARGET" "test -f /home/${PI_USER}/.cloudflared/cert.pem"; then
    log_error "cloudflared is not authenticated."
    echo ""
    echo "  Run on the Pi:"
    echo "    ssh $PI_TARGET 'cloudflared tunnel login'"
    echo ""
    echo "  This will open a browser to authorize your Cloudflare account."
    echo ""
    exit 1
fi
log_info "Authenticated"

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Create tunnel if it doesn't exist
# ─────────────────────────────────────────────────────────────────────────────
log_step "Checking tunnel '$TUNNEL_NAME'..."
if ssh "$PI_TARGET" "cloudflared tunnel list 2>/dev/null | grep -q '$TUNNEL_NAME'"; then
    log_info "Tunnel '$TUNNEL_NAME' already exists"
else
    log_warn "Creating tunnel '$TUNNEL_NAME'..."
    ssh "$PI_TARGET" "cloudflared tunnel create $TUNNEL_NAME"
    log_info "Tunnel created"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Write ingress config
# ─────────────────────────────────────────────────────────────────────────────
log_step "Writing tunnel config..."

CREDS_FILE=$(ssh "$PI_TARGET" "basename /home/${PI_USER}/.cloudflared/*.json")

# Backup existing config if present
ssh "$PI_TARGET" "test -f /home/${PI_USER}/.cloudflared/config.yml && cp /home/${PI_USER}/.cloudflared/config.yml /home/${PI_USER}/.cloudflared/config.yml.bak || true"

ssh "$PI_TARGET" "cat > /home/${PI_USER}/.cloudflared/config.yml << 'CFEOF'
tunnel: ${TUNNEL_NAME}
credentials-file: /home/${PI_USER}/.cloudflared/${CREDS_FILE}

ingress:
  - hostname: ${DASHBOARD_DOMAIN}
    service: http://localhost:${DASHBOARD_PORT}
  - hostname: ${LANDING_DOMAIN}
    service: http://localhost:${LANDING_PORT}
  - hostname: ${LANDING_DOMAIN_WWW}
    service: http://localhost:${LANDING_PORT}
  - service: http_status:404
CFEOF"

log_info "Config written to ~/.cloudflared/config.yml"

# ─────────────────────────────────────────────────────────────────────────────
# Step 6: Install/restart cloudflared service
# ─────────────────────────────────────────────────────────────────────────────
log_step "Setting up cloudflared systemd service..."
if ssh "$PI_TARGET" "systemctl is-active cloudflared" &>/dev/null; then
    log_info "cloudflared service already running, restarting..."
    ssh -t "$PI_TARGET" "sudo systemctl restart cloudflared"
else
    log_warn "Installing cloudflared as a service..."
    ssh -t "$PI_TARGET" "sudo cloudflared --config /home/${PI_USER}/.cloudflared/config.yml service install"
fi

sleep 2
if ssh "$PI_TARGET" "systemctl is-active cloudflared" &>/dev/null; then
    log_info "cloudflared service is running"
else
    log_error "cloudflared service failed to start"
    ssh "$PI_TARGET" "sudo journalctl -u cloudflared -n 10 --no-pager"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 7: DNS routing
# ─────────────────────────────────────────────────────────────────────────────
echo ""
log_info "════════════════════════════════════════════════════════════"
log_info " Tunnel '$TUNNEL_NAME' is running!"
log_info ""
log_info " Next: add DNS records in Cloudflare for each hostname."
log_info " Run these on the Pi (or add CNAME records manually):"
log_info ""
log_info "   cloudflared tunnel route dns $TUNNEL_NAME $DASHBOARD_DOMAIN"
log_info "   cloudflared tunnel route dns $TUNNEL_NAME $LANDING_DOMAIN"
log_info "   cloudflared tunnel route dns $TUNNEL_NAME $LANDING_DOMAIN_WWW"
log_info ""
log_info " Verify:"
log_info "   curl -I https://$DASHBOARD_DOMAIN/"
log_info "   curl -I https://$LANDING_DOMAIN/"
log_info "════════════════════════════════════════════════════════════"
