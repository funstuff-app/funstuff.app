#!/usr/bin/env python3
"""Test dashboard server with Utah AQ down."""
import time
import json
import urllib.request
from dashboard_server import start_server_in_thread

stop_event, httpd = start_server_in_thread(host='127.0.0.1', port=18770, interval=5.0)

# Check at 12s (after Utah AQ 10s timeout) and 18s (after AirNow 15s delay)
for t in [12, 18]:
    if t == 12:
        time.sleep(12)
    else:
        time.sleep(6)
    try:
        with urllib.request.urlopen('http://127.0.0.1:18770/api/state', timeout=5) as r:
            st = json.loads(r.read())
            fixed = st.get('fixed', [])
            home = [f for f in fixed if f.get('id') == 'Home']
            airnow = [f for f in fixed if 'AIRNOW' in str(f.get('id', ''))]
            err = st.get('meta', {}).get('last_fetch_error', '')
            print(f'{t}s: {len(fixed)} fixed (Home={len(home)}, AirNow={len(airnow)})')
            for f in fixed[:5]:
                print(f'  {f.get("id")}: {f.get("emoji", "?")}')
            if err:
                print(f'  err: {err[:60]}')
    except Exception as e:
        print(f'{t}s: {e}')

stop_event.set()
httpd.shutdown()
