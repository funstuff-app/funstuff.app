#!/bin/bash
# MobileAir Dashboard Server - Raspberry Pi Deployment Script
# 
# This script sets up the mobileair dashboard server on a fresh Raspberry Pi OS install.
# Run as root or with sudo.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/.../deploy_raspberry_pi.sh | sudo bash
#   # OR
#   sudo ./deploy_raspberry_pi.sh
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
REPO_URL="https://github.com/YOUR_USERNAME/mobileair.git"  # Update this if using git clone

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   log_error "This script must be run as root (use sudo)"
   exit 1
fi

log_info "Starting MobileAir deployment on Raspberry Pi..."

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Update system and install dependencies
# ─────────────────────────────────────────────────────────────────────────────
log_info "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

log_info "Installing Python and dependencies..."
apt-get install -y -qq \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Create service user (if not exists)
# ─────────────────────────────────────────────────────────────────────────────
if ! id "$SERVICE_USER" &>/dev/null; then
    log_info "Creating service user: $SERVICE_USER"
    useradd --system --no-create-home --shell /bin/false "$SERVICE_USER"
else
    log_info "Service user $SERVICE_USER already exists"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Create installation directory
# ─────────────────────────────────────────────────────────────────────────────
log_info "Setting up installation directory: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data"  # For persistent data (fixed_history.json, etc.)

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Copy or clone project files
# ─────────────────────────────────────────────────────────────────────────────
# If this script is run from the project directory, copy files
# Otherwise, you'd clone from git

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$SCRIPT_DIR/dashboard_server.py" ]]; then
    log_info "Copying project files from $SCRIPT_DIR..."
    
    # Copy Python files
    cp "$SCRIPT_DIR/dashboard_server.py" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/mobileair_core.py" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/airnow_slc.py" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/aqi_breakpoints.csv" "$INSTALL_DIR/"
    cp "$SCRIPT_DIR/requirements.txt" "$INSTALL_DIR/"
    
    # Copy mobileair package
    cp -r "$SCRIPT_DIR/mobileair" "$INSTALL_DIR/"
    
    # Copy dashboard static files
    cp -r "$SCRIPT_DIR/dashboard" "$INSTALL_DIR/"
    
    # Copy existing data if present
    if [[ -f "$SCRIPT_DIR/fixed_history.json" ]]; then
        cp "$SCRIPT_DIR/fixed_history.json" "$INSTALL_DIR/data/"
    fi
else
    log_warn "Project files not found locally. You need to copy them manually to $INSTALL_DIR"
    log_warn "Required files:"
    log_warn "  - dashboard_server.py"
    log_warn "  - mobileair_core.py"
    log_warn "  - airnow_slc.py"
    log_warn "  - aqi_breakpoints.csv"
    log_warn "  - requirements.txt"
    log_warn "  - mobileair/ (directory)"
    log_warn "  - dashboard/ (directory)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Create Python virtual environment and install dependencies
# ─────────────────────────────────────────────────────────────────────────────
log_info "Creating Python virtual environment..."
python3 -m venv "$INSTALL_DIR/venv"

log_info "Installing Python dependencies..."
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip -q
"$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt" -q

# ─────────────────────────────────────────────────────────────────────────────
# Step 6: Set permissions
# ─────────────────────────────────────────────────────────────────────────────
log_info "Setting permissions..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod -R 755 "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR/data"

# ─────────────────────────────────────────────────────────────────────────────
# Step 7: Create systemd service file
# ─────────────────────────────────────────────────────────────────────────────
log_info "Creating systemd service..."

cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=MobileAir Dashboard Server
Documentation=https://github.com/YOUR_USERNAME/mobileair
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}

# Environment
Environment="PYTHONUNBUFFERED=1"
Environment="MOBILEAIR_DATA_DIR=${INSTALL_DIR}/data"

# Run headless (no TUI, just the HTTP server)
ExecStart=${INSTALL_DIR}/venv/bin/python ${INSTALL_DIR}/dashboard_server.py --host ${DASHBOARD_HOST} --port ${DASHBOARD_PORT}

# Restart policy
Restart=always
RestartSec=10

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}/data

# Resource limits (adjust for Pi model)
MemoryMax=256M
CPUQuota=50%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

# ─────────────────────────────────────────────────────────────────────────────
# Step 8: Enable and start service
# ─────────────────────────────────────────────────────────────────────────────
log_info "Enabling and starting service..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl start "$SERVICE_NAME"

# Wait a moment for service to start
sleep 3

# ─────────────────────────────────────────────────────────────────────────────
# Step 9: Verify installation
# ─────────────────────────────────────────────────────────────────────────────
if systemctl is-active --quiet "$SERVICE_NAME"; then
    log_info "Service is running!"
    
    # Get Pi's IP address
    PI_IP=$(hostname -I | awk '{print $1}')
    
    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo -e "${GREEN}MobileAir Dashboard Server installed successfully!${NC}"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""
    echo "  Dashboard URL:  http://${PI_IP}:${DASHBOARD_PORT}/"
    echo "  API endpoint:   http://${PI_IP}:${DASHBOARD_PORT}/api/state"
    echo ""
    echo "  Useful commands:"
    echo "    View logs:     sudo journalctl -u ${SERVICE_NAME} -f"
    echo "    Status:        sudo systemctl status ${SERVICE_NAME}"
    echo "    Restart:       sudo systemctl restart ${SERVICE_NAME}"
    echo "    Stop:          sudo systemctl stop ${SERVICE_NAME}"
    echo ""
    echo "  Data directory:  ${INSTALL_DIR}/data"
    echo ""
else
    log_error "Service failed to start. Check logs with:"
    echo "  sudo journalctl -u ${SERVICE_NAME} -n 50"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Optional: Set up log rotation
# ─────────────────────────────────────────────────────────────────────────────
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

log_info "Log rotation configured"
log_info "Deployment complete!"
