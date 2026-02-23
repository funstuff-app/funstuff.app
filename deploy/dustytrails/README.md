# Dusty Trails - Raspberry Pi Deployment

Deploys the MobileAir dashboard to a Raspberry Pi as a systemd service named "dustytrails".

## Target

Configured via `deploy.config` (copy `deploy.config.example` to get started).

- **Install Path**: `~/dustytrails`
- **Service Name**: `dustytrails`
- **Internal Port**: `8766`
- **Public URL**: `https://funstuff.app/dustytrails`

## Quick Deploy

```bash
# From this directory
./deploy_to_pi.sh
```

This will:
1. Build a staging directory with only runtime files (no tests, no git)
2. Patch dashboard files for subpath deployment (`/dustytrails`)
3. Deploy app files via rsync to the Pi
4. Deploy `~/.mobileair` data directory (road graphs, snapshots, history)
5. Setup systemd service and start it

## Options

```bash
# Full deploy (default) - app + data + service
./deploy_to_pi.sh

# Only sync app files (faster for code-only changes)
./deploy_to_pi.sh --files-only

# Only sync data directory (~/.mobileair)
./deploy_to_pi.sh --data-only

# Full deploy but skip data sync (faster if data hasn't changed)
./deploy_to_pi.sh --skip-data

# Only setup service (assumes files already deployed)
./deploy_to_pi.sh --setup-only

# Override host/user (instead of deploy.config)
./deploy_to_pi.sh --host 192.168.1.100 --user pi
```

## Prerequisites

### On your local machine
- SSH key access to the Pi (password-less login)
- rsync installed

### On the Pi
- Raspberry Pi OS (Debian-based)
- SSH enabled
- Internet access (for apt and pip packages)

## Reverse Proxy Setup

The dashboard runs on port 8766. To expose it at `funstuff.app/dustytrails`, 
configure your reverse proxy. See `caddy-snippet.txt` for examples.

### With Caddy

```caddy
funstuff.app {
    handle_path /dustytrails/* {
        reverse_proxy home-pi.local:8766
    }
}
```

### With nginx

```nginx
location /dustytrails/ {
    proxy_pass http://home-pi.local:8766/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Managing the Service

Replace `<user>@<host>` with your Pi target from `deploy.config`.

```bash
# View logs
ssh -t <user>@<host> 'sudo journalctl -u dustytrails -f'

# Check status
ssh -t <user>@<host> 'sudo systemctl status dustytrails'

# Restart
ssh -t <user>@<host> 'sudo systemctl restart dustytrails'

# Stop
ssh -t <user>@<host> 'sudo systemctl stop dustytrails'
```

## Files Deployed

Only runtime files are deployed (no git repo, no tests):

### Application (`~/dustytrails/`)
```
~/dustytrails/
├── dashboard_server.py     # Main server
├── airnow_slc.py           # Air quality data fetcher
├── airnow_api.py           # AirNow API client
├── aqi_breakpoints.csv     # AQI calculation data
├── requirements.txt        # Python dependencies
├── dustytrails.service     # Systemd service file
├── mobileair/              # Core Python package
│   ├── __init__.py
│   ├── aqi.py
│   ├── config.py
│   ├── dashboard.py
│   └── ... (other modules)
├── dashboard/              # Static web files (patched for /dustytrails)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── ... (other assets)
└── venv/                   # Python virtual environment (created on Pi)
```

### Data (`~/.mobileair/`)
```
~/.mobileair/
├── fixed_history.json      # Historical fixed sensor data
├── sensor_names.json       # Custom sensor names
├── pinned_sensors.json     # Pinned sensors list
├── cache_fixed.json        # API cache (regenerates)
├── cache_mobile.json       # API cache (regenerates)
├── roads/                  # Road graph data for map matching
│   ├── utah_centerlines_graph.json
│   ├── trax_lines_graph.json
│   └── ... (geojson files)
└── snapshots/              # Historical snapshots by date
    ├── 2025-12-25.json
    └── ...
```

**Note:** The `.env` file and SSL certificates are NOT copied (contain secrets).

## Troubleshooting

### Can't connect to Pi
```bash
# Test SSH connection
ssh <user>@<host> 'echo ok'

# If that fails, check:
# - Pi is on and connected to network
# - SSH keys are set up
# - Hostname resolves (try IP address instead)
```

### Service won't start
```bash
# Check logs
ssh -t <user>@<host> 'sudo journalctl -u dustytrails -n 50'

# Common issues:
# - Python dependencies failed to install
# - Port 8766 already in use
# - Permission issues in ~/dustytrails
```

### Dashboard shows 404 for API calls
- Make sure reverse proxy uses `handle_path` (not `handle`) to strip the prefix
- Check browser console for actual request URLs
