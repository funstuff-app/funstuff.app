#!/bin/bash
# Copy MobileAir files to Raspberry Pi and run deployment
#
# Usage:
#   ./copy_to_pi.sh pi@192.168.1.100
#   ./copy_to_pi.sh pi@mobileair.local

set -e

if [[ -z "$1" ]]; then
    echo "Usage: $0 <user@pi-hostname-or-ip>"
    echo "Example: $0 pi@192.168.1.100"
    exit 1
fi

PI_TARGET="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_TMP="/tmp/mobileair-deploy"

echo "Copying MobileAir files to $PI_TARGET..."

# Create remote temp directory
ssh "$PI_TARGET" "mkdir -p $REMOTE_TMP"

# Copy required files using rsync (faster for directories)
rsync -avz --progress \
    "$SCRIPT_DIR/dashboard_server.py" \
    "$SCRIPT_DIR/mobileair_core.py" \
    "$SCRIPT_DIR/airnow_slc.py" \
    "$SCRIPT_DIR/aqi_breakpoints.csv" \
    "$SCRIPT_DIR/requirements.txt" \
    "$SCRIPT_DIR/deploy_raspberry_pi.sh" \
    "$PI_TARGET:$REMOTE_TMP/"

rsync -avz --progress \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    "$SCRIPT_DIR/mobileair/" \
    "$PI_TARGET:$REMOTE_TMP/mobileair/"

rsync -avz --progress \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='tests/' \
    --exclude='build/' \
    "$SCRIPT_DIR/dashboard/" \
    "$PI_TARGET:$REMOTE_TMP/dashboard/"

# Copy existing data if present
if [[ -f "$SCRIPT_DIR/fixed_history.json" ]]; then
    rsync -avz --progress \
        "$SCRIPT_DIR/fixed_history.json" \
        "$PI_TARGET:$REMOTE_TMP/"
fi

echo ""
echo "Files copied to $PI_TARGET:$REMOTE_TMP"
echo ""
echo "Now run the deployment script on the Pi:"
echo "  ssh $PI_TARGET"
echo "  cd $REMOTE_TMP"
echo "  sudo ./deploy_raspberry_pi.sh"
echo ""
echo "Or run it directly:"
echo "  ssh $PI_TARGET 'cd $REMOTE_TMP && sudo ./deploy_raspberry_pi.sh'"
