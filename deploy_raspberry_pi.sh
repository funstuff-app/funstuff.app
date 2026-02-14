#!/bin/bash
# MobileAir Dashboard Server - Raspberry Pi Deployment Script
#
# Works for both first-time setup and incremental updates.
# On first run: installs system packages, creates venv, sets up systemd service.
# On subsequent runs: syncs only changed files and restarts the service.
#
# Run as root or with sudo.
#
# Usage:
#   sudo ./deploy_raspberry_pi.sh               # Full deploy (auto-detects first run vs update)
#   sudo ./deploy_raspberry_pi.sh --setup        # Force first-time setup steps
#   sudo ./deploy_raspberry_pi.sh --files-only   # Only sync files, don't restart service
#   sudo ./deploy_raspberry_pi.sh --restart-only # Only restart the service
#
# After installation:
#   - Service runs on port 8766 by default
#   - Access dashboard at http://<pi-ip>:8766/
#   - Logs: sudo journalctl -u mobileair -f
#   - Status: sudo systemctl status mobileair

set -e

# Configuration
INSTALL_DIR="/opt/mobileair"
SERVICE_USER="mobileair"
SERVICE_NAME="mobileair"
DASHBOARD_PORT="${MOBILEAIR_PORT:-8766}"
DASHBOARD_HOST="${MOBILEAIR_HOST:-0.0.0.0}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse arguments
FORCE_SETUP=0
FILES_ONLY=0
RESTART_ONLY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --setup)       FORCE_SETUP=1; shift ;;
        --files-only)  FILES_ONLY=1; shift ;;
        --restart-only) RESTART_ONLY=1; shift ;;
        -h|--help)
            sed -n '2,/^$/{ s/^# \?//; p }' "$0"
            exit 0
            ;;
        *)
            log_error "Unknown argument: $1"
            exit 1
            ;;
    esac
done

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   log_error "This script must be run as root (use sudo)"
   exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect first run: venv missing or service user missing
IS_FIRST_RUN=0
if [[ ! -d "$INSTALL_DIR/venv" ]] || ! id "$SERVICE_USER" &>/dev/null; then
    IS_FIRST_RUN=1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Restart-only mode
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$RESTART_ONLY" == "1" ]]; then
    log_info "Restarting $SERVICE_NAME..."
    systemctl restart "$SERVICE_NAME"
    sleep 2
    systemctl status "$SERVICE_NAME" --no-pager || true
    exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# First-time setup (or --setup): system packages, user, venv
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$IS_FIRST_RUN" == "1" ]] || [[ "$FORCE_SETUP" == "1" ]]; then
    log_info "Running first-time setup..."

    log_info "Installing system dependencies..."
    apt-get update -qq
    apt-get install -y -qq python3 python3-pip python3-venv git curl

    if ! id "$SERVICE_USER" &>/dev/null; then
        log_info "Creating service user: $SERVICE_USER"
        useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
    fi

    mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/data"

    if [[ ! -d "$INSTALL_DIR/venv" ]]; then
        log_info "Creating Python virtual environment..."
        python3 -m venv "$INSTALL_DIR/venv"
    fi
else
    log_info "Existing installation detected — skipping system setup"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Sync project files (rsync: only transfers changed files)
# ─────────────────────────────────────────────────────────────────────────────
log_info "Syncing project files..."
mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/data"

if [[ -f "$SCRIPT_DIR/dashboard_server.py" ]]; then
    # Sync individual Python/data files
    rsync -a --checksum \
        "$SCRIPT_DIR/dashboard_server.py" \
        "$SCRIPT_DIR/mobileair_core.py" \
        "$SCRIPT_DIR/airnow_slc.py" \
        "$SCRIPT_DIR/airnow_api.py" \
        "$SCRIPT_DIR/aqi_breakpoints.csv" \
        "$SCRIPT_DIR/requirements.txt" \
        "$INSTALL_DIR/"

    # Sync mobileair package (only .py, skip __pycache__)
    rsync -a --checksum \
        --include='*.py' \
        --exclude='__pycache__' \
        --exclude='*.pyc' \
        "$SCRIPT_DIR/mobileair/" \
        "$INSTALL_DIR/mobileair/"

    # Sync dashboard static files (skip tests/ and build/)
    rsync -a --checksum \
        --exclude='tests/' \
        --exclude='build/' \
        --exclude='__pycache__' \
        "$SCRIPT_DIR/dashboard/" \
        "$INSTALL_DIR/dashboard/"

    # Copy existing data if present
    if [[ -f "$SCRIPT_DIR/fixed_history.json" ]]; then
        rsync -a --checksum "$SCRIPT_DIR/fixed_history.json" "$INSTALL_DIR/data/"
    fi
else
    log_warn "Project files not found in $SCRIPT_DIR — skipping file sync"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Install/update Python dependencies (only when requirements.txt changed)
# ─────────────────────────────────────────────────────────────────────────────
REQS_HASH_FILE="$INSTALL_DIR/.requirements_hash"
CURRENT_REQS_HASH=$(sha256sum "$INSTALL_DIR/requirements.txt" 2>/dev/null | cut -d' ' -f1)
PREV_REQS_HASH=$(cat "$REQS_HASH_FILE" 2>/dev/null || echo "")

if [[ "$IS_FIRST_RUN" == "1" ]] || [[ "$FORCE_SETUP" == "1" ]] || [[ "$CURRENT_REQS_HASH" != "$PREV_REQS_HASH" ]]; then
    log_info "Installing Python dependencies..."
    "$INSTALL_DIR/venv/bin/pip" install --upgrade pip -q
    "$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt" -q
    echo "$CURRENT_REQS_HASH" > "$REQS_HASH_FILE"
else
    log_info "requirements.txt unchanged — skipping pip install"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Set permissions
# ─────────────────────────────────────────────────────────────────────────────
log_info "Setting permissions..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod -R 755 "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR/data"

if [[ "$FILES_ONLY" == "1" ]]; then
    log_info "Files synced. Skipping service restart (--files-only)."
    exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Create/update systemd service file (only if changed)
# ─────────────────────────────────────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NEW_SERVICE_CONTENT="[Unit]
Description=MobileAir Dashboard Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}

Environment=\"PYTHONUNBUFFERED=1\"
Environment=\"MOBILEAIR_DATA_DIR=${INSTALL_DIR}/data\"

ExecStart=${INSTALL_DIR}/venv/bin/python ${INSTALL_DIR}/dashboard_server.py --host ${DASHBOARD_HOST} --port ${DASHBOARD_PORT}

Restart=always
RestartSec=10

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}/data

MemoryMax=256M
CPUQuota=50%

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target"

SERVICE_CHANGED=0
if [[ ! -f "$SERVICE_FILE" ]] || [[ "$(cat "$SERVICE_FILE")" != "$NEW_SERVICE_CONTENT" ]]; then
    log_info "Updating systemd service file..."
    echo "$NEW_SERVICE_CONTENT" > "$SERVICE_FILE"
    systemctl daemon-reload
    SERVICE_CHANGED=1
else
    log_info "Service file unchanged — skipping daemon-reload"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Enable and restart service
# ─────────────────────────────────────────────────────────────────────────────
systemctl enable "$SERVICE_NAME" 2>/dev/null
log_info "Restarting $SERVICE_NAME..."
systemctl restart "$SERVICE_NAME"
sleep 3

# ─────────────────────────────────────────────────────────────────────────────
# Verify
# ─────────────────────────────────────────────────────────────────────────────
if systemctl is-active --quiet "$SERVICE_NAME"; then
    PI_IP=$(hostname -I | awk '{print $1}')

    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo -e "${GREEN}MobileAir deployed successfully!${NC}"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""
    echo "  Dashboard URL:  http://${PI_IP}:${DASHBOARD_PORT}/"
    echo "  API endpoint:   http://${PI_IP}:${DASHBOARD_PORT}/api/state"
    echo ""
    echo "  Useful commands:"
    echo "    View logs:     sudo -t journalctl -u ${SERVICE_NAME} -f"
    echo "    Status:        sudo -t systemctl status ${SERVICE_NAME}"
    echo "    Restart:       sudo -t systemctl restart ${SERVICE_NAME}"
    echo ""
else
    log_error "Service failed to start. Check logs with:"
    echo "  sudo -t journalctl -u ${SERVICE_NAME} -n 50"
    exit 1
fi

# Log rotation (idempotent — overwrites are fine)
cat > /etc/logrotate.d/${SERVICE_NAME} << EOF
/var/log/${SERVICE_NAME}/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0640 ${SERVICE_USER} ${SERVICE_USER}
}
EOF

log_info "Deployment complete!"
