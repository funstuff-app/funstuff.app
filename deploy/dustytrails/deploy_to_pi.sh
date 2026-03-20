#!/usr/bin/env bash
#
# Deploy MobileAir Dashboard to Raspberry Pi as "dustytrails"
#
# Builds locally (prepares runtime files) and deploys over SSH.
# Does NOT send the git repo - only necessary runtime files.
#
# Target: pi@raspi.local
# Service: dustytrails (exposed via reverse proxy)
#
# Usage:
#   ./deploy_to_pi.sh              # Full deploy (files + setup service)
#   ./deploy_to_pi.sh --files-only # Only sync files, don't restart service
#   ./deploy_to_pi.sh --setup-only # Only setup service (assumes files exist)

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────
SERVICE_NAME="dustytrails"
DASHBOARD_PORT="8766"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STAGING_DIR="$SCRIPT_DIR/.staging"
LOCAL_DATA_DIR="${HOME}/.mobileair"

# Source local deploy config (sets PI_HOST, PI_USER, secrets)
if [[ -f "$SCRIPT_DIR/deploy.config" ]]; then
    # shellcheck source=deploy.config.example
    source "$SCRIPT_DIR/deploy.config"
else
    echo -e "\033[0;31m[ERROR]\033[0m deploy.config not found."
    echo -e "        Copy deploy.config.example to deploy.config and fill in your values."
    exit 1
fi

# Validate required config
if [[ -z "${PI_HOST:-}" || -z "${PI_USER:-}" ]]; then
    echo -e "\033[0;31m[ERROR]\033[0m deploy.config must set PI_HOST and PI_USER"
    exit 1
fi

PI_TARGET="${PI_USER}@${PI_HOST}"

# Derived paths (depend on PI_USER from config)
INSTALL_DIR="/home/${PI_USER}/dustytrails"
REMOTE_DATA_DIR="/home/${PI_USER}/.mobileair"

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

# ─────────────────────────────────────────────────────────────────────────────
# Patch dashboard files for subpath deployment
# Changes absolute paths to relative paths so they work under /dustytrails/
# ─────────────────────────────────────────────────────────────────────────────
patch_dashboard_for_subpath() {
    log_info "Patching dashboard for subpath deployment..."
    
    local dashboard_dir="$STAGING_DIR/dashboard"
    
    # Use portable sed: write to temp file then move
    patch_file() {
        local file="$1"
        shift
        local tmp="${file}.tmp"
        sed "$@" "$file" > "$tmp" && mv "$tmp" "$file"
    }
    
    # Cache-busting version based on timestamp
    local cache_bust="v=$(date +%s)"
    
    # Patch index.html - convert absolute paths to relative + add cache busting
    # Handle both absolute (/app.js) and relative (app.js) paths
    patch_file "$dashboard_dir/index.html" \
        -e 's|href="/manifest.json"|href="manifest.json"|g' \
        -e 's|href="/icon-180.png"|href="icon-180.png"|g' \
        -e "s|href=\"/styles.css\"|href=\"styles.css?${cache_bust}\"|g" \
        -e "s|href=\"styles.css\"|href=\"styles.css?${cache_bust}\"|g" \
        -e "s|src=\"/map_nav_engine.js\"|src=\"map_nav_engine.js?${cache_bust}\"|g" \
        -e "s|src=\"map_nav_engine.js\"|src=\"map_nav_engine.js?${cache_bust}\"|g" \
        -e "s|src=\"/camera_fit_logic.js\"|src=\"camera_fit_logic.js?${cache_bust}\"|g" \
        -e "s|src=\"camera_fit_logic.js\"|src=\"camera_fit_logic.js?${cache_bust}\"|g" \
        -e "s|src=\"/app.js\"|src=\"app.js?${cache_bust}\"|g" \
        -e "s|src=\"app.js\"|src=\"app.js?${cache_bust}\"|g"
    
    # NOTE: API paths kept absolute - tunnel serves at root, not subpath
    # patch_file "$dashboard_dir/app.js" \
    #     -e 's|fetch("/api/|fetch("api/|g' \
    #     -e 's|fetch(`/api/|fetch(`api/|g'
    
    # Patch tui.js - convert absolute API paths to relative
    # const API_URL = '/api/state' → const API_URL = 'api/state'
    # window.open('/') → window.open('.')
    patch_file "$dashboard_dir/tui.js" \
        -e "s|= '/api/|= 'api/|g" \
        -e "s|window.open('/'|window.open('.'|g"
    
    # Patch manifest.json - update start_url if needed
    patch_file "$dashboard_dir/manifest.json" \
        -e 's|"start_url": "/"|"start_url": "."|g'
    
    log_info "Dashboard patched for subpath deployment"
}

# ─────────────────────────────────────────────────────────────────────────────
# Minify JavaScript files for production
# ─────────────────────────────────────────────────────────────────────────────
minify_javascript() {
    if ! command -v terser &> /dev/null; then
        log_info "terser not found, skipping minification"
        return 0
    fi
    
    log_info "Minifying JavaScript files..."
    local dashboard_dir="$STAGING_DIR/dashboard"
    
    for jsfile in "$dashboard_dir"/*.js; do
        if [[ -f "$jsfile" ]]; then
            local basename=$(basename "$jsfile")
            local tmp="${jsfile}.min"
            if terser "$jsfile" --compress --mangle -o "$tmp" 2>/dev/null; then
                mv "$tmp" "$jsfile"
                log_info "  Minified $basename"
            else
                log_info "  Skipped $basename (minification failed)"
                rm -f "$tmp"
            fi
        fi
    done
}

# ─────────────────────────────────────────────────────────────────────────────
# Parse arguments
# ─────────────────────────────────────────────────────────────────────────────
FILES_ONLY=0
SETUP_ONLY=0
DATA_ONLY=0
SKIP_DATA=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --files-only)
            FILES_ONLY=1
            shift
            ;;
        --setup-only)
            SETUP_ONLY=1
            shift
            ;;
        --data-only)
            DATA_ONLY=1
            shift
            ;;
        --skip-data)
            SKIP_DATA=1
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
            INSTALL_DIR="/home/${PI_USER}/dustytrails"
            REMOTE_DATA_DIR="/home/${PI_USER}/.mobileair"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --files-only   Only sync app files, don't sync data or restart service"
            echo "  --data-only    Only sync ~/.mobileair data directory"
            echo "  --skip-data    Skip syncing ~/.mobileair (faster for code-only updates)"
            echo "  --setup-only   Only setup service (assumes files already deployed)"
            echo "  --host HOST    Override PI_HOST from deploy.config"
            echo "  --user USER    Override PI_USER from deploy.config"
            echo "  -h, --help     Show this help"
            exit 0
            ;;
        *)
            log_error "Unknown argument: $1"
            exit 1
            ;;
    esac
done

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Build/stage files locally
# ─────────────────────────────────────────────────────────────────────────────
build_staging() {
    log_step "Building staging directory..."
    
    # Clean and create staging directory
    rm -rf "$STAGING_DIR"
    mkdir -p "$STAGING_DIR"
    mkdir -p "$STAGING_DIR/mobileair"
    mkdir -p "$STAGING_DIR/dashboard"
    mkdir -p "$STAGING_DIR/data"
    
    # Copy Python server files
    log_info "Copying server files..."
    cp "$REPO_ROOT/dashboard_server.py" "$STAGING_DIR/"
    cp "$REPO_ROOT/airnow_slc.py" "$STAGING_DIR/"
    cp "$REPO_ROOT/airnow_api.py" "$STAGING_DIR/"
    cp "$REPO_ROOT/aqi_breakpoints.csv" "$STAGING_DIR/"
    
    # Copy requirements (we'll use it on the Pi)
    cp "$REPO_ROOT/requirements.txt" "$STAGING_DIR/"
    
    # Copy mobileair package (only .py files, no __pycache__)
    log_info "Copying mobileair package..."
    for f in "$REPO_ROOT/mobileair/"*.py; do
        cp "$f" "$STAGING_DIR/mobileair/"
    done
    
    # Copy dashboard static files (no tests)
    log_info "Copying dashboard static files..."
    cp "$REPO_ROOT/dashboard/index.html" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/app.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/camera_fit_logic.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/map_nav_engine.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/config.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/projections.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/colors.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/aqi.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/format_utils.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/data_utils.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/advection_solver.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/map_view.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/sidebar_ui.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/styles.css" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/tui.html" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/tui.css" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/tui.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/manifest.json" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/pa_advection_worker.js" "$STAGING_DIR/dashboard/"
    cp "$REPO_ROOT/dashboard/pa_field_worker.js" "$STAGING_DIR/dashboard/"
    
    # Patch dashboard files for subpath deployment
    # The reverse proxy uses handle_path which strips /dustytrails prefix,
    # so backend paths remain as-is. But browser-side paths need fixing.
    patch_dashboard_for_subpath
    
    # Minify JavaScript for production
    minify_javascript
    
    # Copy icons if they exist
    for icon in icon-180.png icon-192.png icon-512.png icon-maskable-512.png icon.svg; do
        if [[ -f "$REPO_ROOT/dashboard/$icon" ]]; then
            cp "$REPO_ROOT/dashboard/$icon" "$STAGING_DIR/dashboard/"
        fi
    done
    
    # Copy existing data if present
    if [[ -f "$REPO_ROOT/fixed_history.json" ]]; then
        log_info "Copying existing data..."
        cp "$REPO_ROOT/fixed_history.json" "$STAGING_DIR/data/"
    fi
    
    # Copy service files from this deploy directory
    cp "$SCRIPT_DIR/dustytrails.service" "$STAGING_DIR/"
    
    log_info "Staging complete: $(du -sh "$STAGING_DIR" | cut -f1)"
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Deploy files to Pi
# ─────────────────────────────────────────────────────────────────────────────
deploy_files() {
    log_step "Deploying to $PI_TARGET..."
    
    # Test SSH connection
    if ! ssh -o ConnectTimeout=5 "$PI_TARGET" "echo 'SSH OK'" &>/dev/null; then
        log_error "Cannot connect to $PI_TARGET"
        log_error "Make sure the Pi is accessible and SSH keys are set up"
        exit 1
    fi
    
    # Create install directory on Pi (in user home, no sudo needed)
    log_info "Creating directory structure on Pi..."
    ssh "$PI_TARGET" "mkdir -p '$INSTALL_DIR'"
    
    # Sync files using rsync (efficient, only transfers changes)
    log_info "Syncing application files..."
    rsync -avz --delete \
        --exclude='*.pyc' \
        --exclude='__pycache__' \
        --exclude='.staging' \
        --exclude='venv' \
        "$STAGING_DIR/" \
        "$PI_TARGET:$INSTALL_DIR/"
    
    log_info "Files deployed to $PI_TARGET:$INSTALL_DIR"
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 2b: Deploy ~/.mobileair data directory
# ─────────────────────────────────────────────────────────────────────────────
deploy_data() {
    log_step "Deploying data directory (~/.mobileair)..."
    
    if [[ ! -d "$LOCAL_DATA_DIR" ]]; then
        log_warn "Local data directory not found: $LOCAL_DATA_DIR"
        log_warn "Skipping data sync"
        return 0
    fi
    
    # Create remote data directory
    log_info "Creating data directory on Pi..."
    ssh "$PI_TARGET" "mkdir -p '$REMOTE_DATA_DIR'"
    
    # Sync data directory, excluding secrets, logs, and snapshots.
    # Snapshots are NOT synced: the Pi saves its own daily and those are
    # the authoritative copies.  Road graphs and other data files ARE pushed.
    log_info "Syncing data files (this may take a while for road graphs)..."
    rsync -avz \
        --exclude='.env' \
        --exclude='*.log' \
        --exclude='dev-cert.pem' \
        --exclude='dev-key.pem' \
        --exclude='*.pem' \
        --exclude='prefs_log.ndjson' \
        --exclude='snapshots/' \
        "$LOCAL_DATA_DIR/" \
        "$PI_TARGET:$REMOTE_DATA_DIR/"
    
    # Set permissions
    ssh "$PI_TARGET" "chmod -R 755 '$REMOTE_DATA_DIR' && chmod 700 '$REMOTE_DATA_DIR/snapshots' 2>/dev/null || true"
    
    log_info "Data deployed to $PI_TARGET:$REMOTE_DATA_DIR"
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Setup service on Pi
# ─────────────────────────────────────────────────────────────────────────────
setup_service() {
    log_step "Setting up service on Pi..."
    
    # First, do the non-sudo parts: venv + deps + system libs
    ssh "$PI_TARGET" bash <<REMOTE_VENV
set -euo pipefail
echo "Creating Python virtual environment..."
[[ -d "$INSTALL_DIR/venv" ]] || python3 -m venv "$INSTALL_DIR/venv"
echo "Installing Python dependencies..."
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip -q
"$INSTALL_DIR/venv/bin/pip" install -r "$INSTALL_DIR/requirements.txt" -q
mkdir -p "$INSTALL_DIR/data"
chmod -R 755 "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR/data"
echo "Python environment ready!"
REMOTE_VENV
    log_info "Python environment set up."

    # Install system-level native libraries needed by cfgrib/eccodes on ARM
    log_info "Ensuring native ecCodes library is installed..."
    ssh "$PI_TARGET" bash <<'REMOTE_APT'
if ! dpkg -s libeccodes-dev >/dev/null 2>&1; then
    echo "Installing libeccodes-dev..."
    sudo apt-get install -y libeccodes-dev
else
    echo "libeccodes-dev already installed."
fi
REMOTE_APT
    log_info "Native dependencies OK."

    # Template the service file from the repo copy (single source of truth).
    # Replace the hardcoded user/paths with values from deploy.config.
    log_info "Templating service file..."
    local svc_src="$SCRIPT_DIR/dustytrails.service"
    local svc_tmp
    svc_tmp="$(mktemp)"
    sed -e "s|__USER__|${PI_USER}|g" \
        -e "s|/opt/dustytrails|${INSTALL_DIR}|g" \
        "$svc_src" > "$svc_tmp"

    # Copy service file to Pi
    scp -q "$svc_tmp" "$PI_TARGET:$INSTALL_DIR/dustytrails.service"
    rm -f "$svc_tmp"

    # Install service + build secrets drop-in entirely on the Pi.
    # API keys are passed as simple args; the owner token is generated
    # on the Pi and persisted across deploys.
    log_info "Installing systemd service (may prompt for password)..."
    local pa_key="${DUSTY_PURPLEAIR_API_KEY:-}"
    local an_key="${AIRNOW_API_KEY:-}"
    local ow_tok="${DUSTY_OWNER_TOKEN:-}"
    ssh -t "$PI_TARGET" bash <<REMOTE_SUDO
set -e
sudo cp "$INSTALL_DIR/dustytrails.service" /etc/systemd/system/dustytrails.service
sudo mkdir -p /etc/systemd/system/dustytrails.service.d

# Build secrets.conf on the Pi
SECRETS="[Service]"
[[ -n "$pa_key" ]] && SECRETS="\${SECRETS}
Environment=\"DUSTY_PURPLEAIR_API_KEY=$pa_key\""
[[ -n "$an_key" ]] && SECRETS="\${SECRETS}
Environment=\"AIRNOW_API_KEY=$an_key\""

# Token priority: deploy.config > existing on Pi > generate new
TOKEN="$ow_tok"
if [[ -z "\$TOKEN" ]]; then
    TOKEN=\$(grep -oP 'DUSTY_OWNER_TOKEN=\K[^"]+' /etc/systemd/system/dustytrails.service.d/secrets.conf 2>/dev/null || true)
fi
if [[ -z "\$TOKEN" ]]; then
    TOKEN=\$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
    echo ""
    echo "  ┌─────────────────────────────────────────────────────────────┐"
    echo "  │  Generated new DUSTY_OWNER_TOKEN:                           │"
    echo "  │  \$TOKEN"
    echo "  │                                                             │"
    echo "  │  Save to deploy.config and set in browser:                  │"
    echo "  │  /#tok=\$TOKEN"
    echo "  └─────────────────────────────────────────────────────────────┘"
    echo ""
fi
SECRETS="\${SECRETS}
Environment=\"DUSTY_OWNER_TOKEN=\${TOKEN}\""

printf '%s\n' "\$SECRETS" | sudo tee /etc/systemd/system/dustytrails.service.d/secrets.conf > /dev/null
sudo chmod 600 /etc/systemd/system/dustytrails.service.d/secrets.conf
sudo systemctl daemon-reload
sudo systemctl enable dustytrails
sudo systemctl restart dustytrails

# Grant passwordless sudo for service management so non-interactive SSH works.
SUDOERS_LINE="${PI_USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl daemon-reload, /usr/bin/systemctl restart dustytrails, /usr/bin/systemctl start dustytrails, /usr/bin/systemctl stop dustytrails, /usr/bin/systemctl status dustytrails *, /usr/bin/journalctl -u dustytrails *"
echo "\$SUDOERS_LINE" | sudo tee /etc/sudoers.d/dustytrails-deploy > /dev/null
sudo chmod 440 /etc/sudoers.d/dustytrails-deploy

# Allow reading journals without sudo by adding user to systemd-journal group.
sudo usermod -aG systemd-journal ${PI_USER}

sleep 2
sudo systemctl status dustytrails --no-pager || true
REMOTE_SUDO

    log_info "Service setup complete!"
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
main() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo "  Dusty Trails Deployment to Raspberry Pi"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""
    echo "  Target:  $PI_TARGET"
    echo "  Install: $INSTALL_DIR"
    echo "  Data:    $REMOTE_DATA_DIR"
    echo "  Service: $SERVICE_NAME"
    echo ""
    
    if [[ "$SETUP_ONLY" == "1" ]]; then
        setup_service
    elif [[ "$DATA_ONLY" == "1" ]]; then
        deploy_data
    elif [[ "$FILES_ONLY" == "1" ]]; then
        build_staging
        deploy_files
    else
        # Full deploy: app files + data + service
        build_staging
        deploy_files
        if [[ "$SKIP_DATA" != "1" ]]; then
            deploy_data
        fi
        setup_service
    fi
    
    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo -e "${GREEN}Deployment complete!${NC}"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""
    echo "  Dashboard:  http://$PI_HOST:$DASHBOARD_PORT/"
    echo ""
    echo "  Commands:"
    echo "    Logs:    ssh $PI_TARGET 'journalctl -u $SERVICE_NAME -f'"
    echo "    Status:  ssh $PI_TARGET 'systemctl status $SERVICE_NAME'"
    echo "    Restart: ssh $PI_TARGET 'systemctl restart $SERVICE_NAME'"
    echo ""
}

main
