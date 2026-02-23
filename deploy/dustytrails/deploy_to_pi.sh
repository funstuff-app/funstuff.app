#!/usr/bin/env bash
#
# Deploy MobileAir Dashboard to Raspberry Pi as "dustytrails"
#
# Builds locally (prepares runtime files) and deploys over SSH.
# Does NOT send the git repo - only necessary runtime files.
#
# Service: dustytrails (serves at funstuff.app/dustytrails via reverse proxy)
#
# Usage:
#   ./deploy_to_pi.sh              # Full deploy (files + setup service)
#   ./deploy_to_pi.sh --files-only # Only sync files, don't restart service
#   ./deploy_to_pi.sh --setup-only # Only setup service (assumes files exist)

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

SERVICE_NAME="dustytrails"
INSTALL_DIR="/home/${PI_USER}/dustytrails"
DASHBOARD_PORT="8766"
BASE_PATH="/dustytrails"  # For reverse proxy path prefix

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STAGING_DIR="$SCRIPT_DIR/.staging"
MINIFY_CACHE_DIR="$SCRIPT_DIR/.minify_cache"
LOCAL_DATA_DIR="${HOME}/.mobileair"
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
    # Generic: handles any .js/.css file referenced in script/link tags
    patch_file "$dashboard_dir/index.html" \
        -e 's|href="/manifest.json"|href="manifest.json"|g' \
        -e 's|href="/icon-180.png"|href="icon-180.png"|g' \
        -e "s|href=\"/\([^\"]*\.css\)?v=[^\"]*\"|href=\"\1?${cache_bust}\"|g" \
        -e "s|href=\"/\([^\"]*\.css\)\"|href=\"\1?${cache_bust}\"|g" \
        -e "s|href=\"\([^/][^\"]*\.css\)?v=[^\"]*\"|href=\"\1?${cache_bust}\"|g" \
        -e "s|src=\"/\([^\"]*\.js\)?v=[^\"]*\"|src=\"\1?${cache_bust}\"|g" \
        -e "s|src=\"/\([^\"]*\.js\)\"|src=\"\1?${cache_bust}\"|g" \
        -e "s|src=\"\([^/][^\"]*\.js\)?v=[^\"]*\"|src=\"\1?${cache_bust}\"|g"
    
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
    
    log_info "Dashboard patched for $BASE_PATH"
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
    mkdir -p "$MINIFY_CACHE_DIR"
    
    local skipped=0
    local minified=0
    
    for jsfile in "$dashboard_dir"/*.js; do
        [[ -f "$jsfile" ]] || continue
        local basename
        basename=$(basename "$jsfile")
        
        # Hash the post-patch, pre-minify content
        local src_hash
        src_hash=$(shasum -a 256 "$jsfile" | cut -d' ' -f1)
        local cached_hash="$MINIFY_CACHE_DIR/${basename}.sha256"
        local cached_min="$MINIFY_CACHE_DIR/${basename}"
        
        # Reuse cached minified output if source hash matches
        if [[ "$FORCE_REBUILD" != "1" ]] && \
           [[ -f "$cached_hash" ]] && [[ -f "$cached_min" ]] && \
           [[ "$(cat "$cached_hash")" == "$src_hash" ]]; then
            cp "$cached_min" "$jsfile"
            skipped=$((skipped + 1))
            continue
        fi
        
        local tmp="${jsfile}.min"
        if terser "$jsfile" --compress --mangle -o "$tmp" 2>/dev/null; then
            mv "$tmp" "$jsfile"
            # Cache: source hash + minified output
            echo "$src_hash" > "$cached_hash"
            cp "$jsfile" "$cached_min"
            log_info "  Minified $basename"
            minified=$((minified + 1))
        else
            log_info "  Skipped $basename (terser failed)"
            rm -f "$tmp"
        fi
    done
    
    log_info "  $minified re-minified, $skipped cached"
}

# ─────────────────────────────────────────────────────────────────────────────
# Parse arguments
# ─────────────────────────────────────────────────────────────────────────────
FILES_ONLY=0
SETUP_ONLY=0
DATA_ONLY=0
SKIP_DATA=0
FORCE_REBUILD=0

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
        --force)
            FORCE_REBUILD=1
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
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --files-only   Only sync app files, don't sync data or restart service"
            echo "  --data-only    Only sync ~/.mobileair data directory"
            echo "  --skip-data    Skip syncing ~/.mobileair (faster for code-only updates)"
            echo "  --force        Force full rebuild (re-stage and re-minify all files)"
            echo "  --setup-only   Only setup service (assumes files already deployed)"
            echo "  --host HOST    Pi hostname/IP (overrides deploy.config)"
            echo "  --user USER    Pi username (overrides deploy.config)"
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
    
    # Copy dashboard static files (all .js, .css, .html, .json — no tests or backups)
    log_info "Copying dashboard static files..."
    for ext in js css html json; do
        for f in "$REPO_ROOT/dashboard/"*."$ext"; do
            [[ -f "$f" ]] || continue
            # Skip monolith backup — not needed in production
            [[ "$(basename "$f")" == "app_monolith.js" ]] && continue
            cp "$f" "$STAGING_DIR/dashboard/"
        done
    done
    
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
    rsync -avz --checksum --delete \
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
    
    # Sync data directory, excluding secrets, logs, and server-accumulated state
    log_info "Syncing data files (this may take a while for road graphs)..."
    rsync -avz \
        --exclude='.env' \
        --exclude='*.log' \
        --exclude='dev-cert.pem' \
        --exclude='dev-key.pem' \
        --exclude='*.pem' \
        --exclude='fixed_history.json' \
        --exclude='cache_mobile.json' \
        --exclude='cache_fixed.json' \
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
    
    # First, do the non-sudo parts
    ssh "$PI_TARGET" bash << REMOTE_SCRIPT
set -euo pipefail

INSTALL_DIR="$INSTALL_DIR"
SERVICE_NAME="dustytrails"

echo "Creating Python virtual environment..."
if [[ ! -d "\$INSTALL_DIR/venv" ]]; then
    python3 -m venv "\$INSTALL_DIR/venv"
fi

echo "Installing Python dependencies..."
"\$INSTALL_DIR/venv/bin/pip" install --upgrade pip -q
"\$INSTALL_DIR/venv/bin/pip" install -r "\$INSTALL_DIR/requirements.txt" -q

echo "Setting permissions..."
mkdir -p "\$INSTALL_DIR/data"
chmod -R 755 "\$INSTALL_DIR"
chmod 700 "\$INSTALL_DIR/data"

echo "Python environment ready!"
REMOTE_SCRIPT

    log_info "Python environment set up."
    
    # Now update the service file with correct path and copy it
    log_info "Updating service file with correct paths..."
    local service_content
    service_content=$(cat << EOF
[Unit]
Description=Dusty Trails - MobileAir Dashboard Server
Documentation=https://funstuff.app/dustytrails
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${PI_USER}
Group=${PI_USER}
WorkingDirectory=${INSTALL_DIR}

# Environment
Environment="PYTHONUNBUFFERED=1"
Environment="HOME=/home/${PI_USER}"
Environment="DUSTY_PURPLEAIR_API_KEY=${DUSTY_PURPLEAIR_API_KEY:-}"
Environment="DUSTY_OWNER_TOKEN=${DUSTY_OWNER_TOKEN:-}"

# Run the dashboard server
ExecStart=${INSTALL_DIR}/venv/bin/python ${INSTALL_DIR}/dashboard_server.py --host 0.0.0.0 --port 8766

# Restart policy
Restart=always
RestartSec=10

# Security hardening
NoNewPrivileges=true
PrivateTmp=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dustytrails

[Install]
WantedBy=multi-user.target
EOF
)
    
    # Write service file to Pi
    echo "$service_content" | ssh "$PI_TARGET" "cat > $INSTALL_DIR/dustytrails.service"
    
    # Try to install service with sudo (will prompt for password)
    log_info "Installing systemd service (may prompt for password)..."
    ssh -t "$PI_TARGET" bash << REMOTE_SUDO
set -e
sudo cp "$INSTALL_DIR/dustytrails.service" /etc/systemd/system/dustytrails.service
sudo systemctl daemon-reload
sudo systemctl enable dustytrails
sudo systemctl restart dustytrails
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
    echo "  Public URL: https://funstuff.app$BASE_PATH"
    echo ""
    echo "  Commands:"
    echo "    Logs:    ssh $PI_TARGET 'sudo journalctl -u $SERVICE_NAME -f'"
    echo "    Status:  ssh $PI_TARGET 'sudo systemctl status $SERVICE_NAME'"
    echo "    Restart: ssh $PI_TARGET 'sudo systemctl restart $SERVICE_NAME'"
    echo ""
}

main
