
const API_URL = '/api/state';
let appState = {
    mobile: [],
    fixed: [],
    meta: {},
    ts: 0
};
let selectedSensorId = null;
let selectedSensorType = null; // 'mobile' or 'fixed'
let lastOutlierToastKey = null;

// Poll every 60 seconds
setInterval(fetchData, 60000);
fetchData();

document.addEventListener('keydown', handleKeydown);

// Initialize footer clicks
document.querySelectorAll('.key-binding').forEach(el => {
    el.addEventListener('click', () => {
        const key = el.querySelector('.key').textContent.toLowerCase().replace('^', '');
        handleAction(key);
    });
});

function handleKeydown(e) {
    if (e.key === 'r') handleAction('r');
    else if (e.key === 'j' || e.key === 'ArrowDown') moveSelection(1);
    else if (e.key === 'k' || e.key === 'ArrowUp') moveSelection(-1);
    else if (e.key === 'n') handleAction('n');
    else if (e.key === 'm') handleAction('m');
    else if (e.key === 'M') handleAction('M');
    else if (e.key === 'q') handleAction('q');
}

function handleAction(key) {
    switch(key) {
        case 'r':
            fetchData();
            break;
        case 'n':
            if (selectedSensorId) {
                const s = getAllSensors().find(x => x.id === selectedSensorId);
                const newName = prompt(`Enter name for ${selectedSensorId}:`, s.name || "");
                if (newName !== null) {
                    // In a real app, we'd POST this back. For now, just update locally to show it works.
                    // To persist, we'd need an API endpoint.
                    alert("Renaming not fully implemented in this static view (requires backend API update).");
                }
            }
            break;
        case 'm':
            window.open('/', '_blank');
            break;
        case 'M': // Shift+m usually
            window.open('/', '_blank');
            break;
        case 'q':
            document.body.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100vh;color:#fff;"><h1>Session Ended</h1></div>';
            break;
    }
}

async function fetchData() {
    document.getElementById('update-time').textContent = 'Fetching...';
    try {
        const res = await fetch(API_URL);
        const data = await res.json();
        appState = data;

        maybeShowOutlierToast(data);
        
        const date = new Date(data.ts * 1000);
        // Format: YYYY-MM-DD HH:MM:SS
        const dateStr = date.getFullYear() + "-" + 
            String(date.getMonth()+1).padStart(2, '0') + "-" + 
            String(date.getDate()).padStart(2, '0') + " " + 
            String(date.getHours()).padStart(2, '0') + ":" + 
            String(date.getMinutes()).padStart(2, '0') + ":" + 
            String(date.getSeconds()).padStart(2, '0');
            
        document.getElementById('update-time').textContent = dateStr;
        
        renderList();
        renderDetails();
        renderJson();
    } catch (err) {
        console.error(err);
        document.getElementById('update-time').textContent = 'Error';
    }
}

function ensureToastHost() {
    let host = document.getElementById('toast-host');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'toast-host';
    host.style.position = 'fixed';
    host.style.right = '12px';
    host.style.bottom = '12px';
    host.style.zIndex = '9999';
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    host.style.gap = '8px';
    document.body.appendChild(host);
    return host;
}

function showToast(message) {
    const host = ensureToastHost();
    const el = document.createElement('div');
    el.textContent = message;
    el.style.padding = '8px 10px';
    el.style.border = '1px solid #665c54';
    el.style.background = '#1d2021';
    el.style.color = '#fbf1c7';
    el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    el.style.fontSize = '12px';
    el.style.maxWidth = '420px';
    el.style.boxShadow = '0 1px 0 rgba(0,0,0,0.4)';
    host.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 300ms ease';
        setTimeout(() => el.remove(), 350);
    }, 4500);
}

function maybeShowOutlierToast(state) {
    const scrubs = state && state.meta && Array.isArray(state.meta.outlier_scrubs) ? state.meta.outlier_scrubs : [];
    if (!scrubs.length) return;

    // Only toast the newest scrub event per fetch.
    const last = scrubs[scrubs.length - 1];
    if (!last) return;

    const key = `${last.ts}|${last.sensor_id}|${last.pollutant}|${(last.removed || []).join(',')}`;
    if (key === lastOutlierToastKey) return;
    lastOutlierToastKey = key;

    const removed = Array.isArray(last.removed) ? last.removed : [];
    const removedText = removed.length ? removed.map(x => (typeof x === 'number' ? x.toFixed(1) : String(x))).join(', ') : 'value';
    showToast(`Outlier scrubbed: ${last.sensor_id} ${last.pollutant} (${removedText})`);
}

function getAllSensors() {
    const mobile = appState.mobile.map(s => ({...s, type: 'mobile'}));
    const fixed = appState.fixed.map(s => ({...s, type: 'fixed'}));
    
    // Filter fixed to SLC area
    const filteredFixed = fixed.filter(s => {
        const lat = s.lat;
        const lon = s.lon;
        return (lat >= 40.4 && lat <= 41.0 && lon >= -112.25 && lon <= -111.7);
    });

    let all = [...mobile, ...filteredFixed];
    
    // Sort: Ghosted first, then Pinned, then ID.
    all.sort((a, b) => {
        const aGhost = !!a.ghosted;
        const bGhost = !!b.ghosted;
        if (aGhost !== bGhost) return aGhost ? -1 : 1; 
        
        const aPinned = !!a.pinned;
        const bPinned = !!b.pinned;
        if (aPinned !== bPinned) return aPinned ? -1 : 1; 
        
        return a.id.localeCompare(b.id);
    });
    
    return all;
}

function renderList() {
    const listEl = document.getElementById('sensor-list');
    listEl.innerHTML = '';
    
    const sensors = getAllSensors();
    
    if (!selectedSensorId && sensors.length > 0) {
        selectedSensorId = sensors[0].id;
        selectedSensorType = sensors[0].type;
    }
    
    sensors.forEach(s => {
        const el = document.createElement('div');
        el.className = 'sensor-item ' + s.type;
        if (s.id === selectedSensorId) el.classList.add('selected');
        // Removed ghosted class logic that dims the item
        
        // Name/ID line
        const nameLine = document.createElement('div');
        nameLine.className = 'sensor-header';
        
        let displayName = s.id;
        if (s.name) displayName += ` (${s.name})`;
        
        // Pin icon
        if (s.pinned) {
            const pin = document.createElement('span');
            pin.textContent = '📌';
            pin.style.color = '#fb4934'; // Red pin
            nameLine.appendChild(pin);
        }

        // Parked indicator
        if (s.ghosted) {
            const parked = document.createElement('span');
            parked.textContent = '(Parked)';
            parked.style.color = '#928374'; // Dim text color
            parked.style.marginLeft = '8px';
            parked.style.fontSize = '11px';
            nameLine.appendChild(parked);
        }
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = displayName;
        nameLine.appendChild(nameSpan);
        
        el.appendChild(nameLine);
        
        // Readings line
        const readingsLine = document.createElement('div');
        readingsLine.className = 'sensor-readings';
        
        ['PM25', 'PM10', 'OZNE'].forEach(key => {
            let rKey = key;
            if (key === 'PM25' && !s.readings['PM25']) rKey = 'PM2.5';
            if (key === 'OZNE' && !s.readings['OZNE']) rKey = 'Ozone';
            
            let reading = s.readings[rKey] || s.readings[key] || s.readings[key.toLowerCase()];
            
            if (reading) {
                const rEl = document.createElement('div');
                rEl.className = 'reading';
                
                const label = document.createElement('span');
                label.className = 'reading-label';
                label.textContent = key + ':';
                
                const val = document.createElement('span');
                val.className = 'reading-value';
                val.textContent = parseFloat(reading.value).toFixed(1); // 1 decimal place
                
                // Color logic: if selected, use white/bright. If not, use reading color.
                // Actually TUI screenshot shows colored values even when not selected.
                // When selected, TUI shows white values? No, screenshot shows "0.7 -" in Cyan.
                // Wait, the selected item in screenshot has "PM25: 0.7 - | PM10: 6.3 - | OZNE: 33.4 -"
                // The values are colored Cyan.
                val.style.color = reading.color;
                
                const trend = document.createElement('span');
                trend.className = 'reading-trend';
                trend.textContent = getTrendSymbol(reading, key);
                // Trend color usually dim
                trend.style.color = '#666';
                
                rEl.appendChild(label);
                rEl.appendChild(val);
                rEl.appendChild(trend);
                readingsLine.appendChild(rEl);
                
                if (key !== 'OZNE') {
                    const sep = document.createElement('span');
                    sep.textContent = '|';
                    sep.style.color = '#444';
                    readingsLine.appendChild(sep);
                }
            }
        });
        
        el.appendChild(readingsLine);
        
        el.onclick = () => {
            selectedSensorId = s.id;
            selectedSensorType = s.type;
            renderList();
            renderDetails();
            renderJson();
        };
        
        listEl.appendChild(el);
    });
    
    const selectedEl = listEl.querySelector('.selected');
    if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest' });
    }
}

function getTrendSymbol(reading, pollutantKey) {
    const histRaw = reading && Array.isArray(reading.history) ? reading.history : [];
    if (histRaw.length < 5) return '-';

    const vals = [];
    for (const v of histRaw) {
        const n = (typeof v === 'number') ? v : parseFloat(v);
        if (isFinite(n)) vals.push(n);
    }
    
    const n = vals.length;
    if (n < 5) return '-';

    // Use a smaller window (8 samples) to be more responsive to recent changes
    // and "forget" old spikes faster.
    const windowSize = 8;
    const window = vals.slice(-windowSize);
    const current = window[window.length - 1];
    const startVal = window[0];
    
    // Thresholds matching mobileair_core.py
    let threshold = 1.0;
    if (pollutantKey) {
        const pk = pollutantKey.toLowerCase();
        if (pk.includes('pm25') || pk.includes('pm2.5')) threshold = 1.0;
        else if (pk.includes('pm10')) threshold = 2.0;
        else if (pk.includes('ozne') || pk.includes('ozone')) threshold = 2.0;
    }
    
    const delta = current - startVal;
    
    // Stable check: if the last 3 samples are very close, it's unchanged.
    // This ensures that if a drop happened a while ago but we've been flat for 3 samples,
    // we don't keep showing a down arrow.
    const last3 = window.slice(-3);
    if (last3.length >= 3) {
        const range3 = Math.max(...last3) - Math.min(...last3);
        if (range3 < threshold * 0.5) return '-';
    }

    // Count moves to filter noise
    let posMoves = 0;
    let negMoves = 0;
    const stepNoise = Math.max(threshold * 0.2, 0.1);
    for (let i = 0; i < window.length - 1; i++) {
        const d = window[i+1] - window[i];
        if (d >= stepNoise) posMoves++;
        else if (d <= -stepNoise) negMoves++;
    }

    let symbol = '-';
    if (delta > threshold && posMoves > 1) symbol = '▲';
    else if (delta < -threshold && negMoves > 1) symbol = '▼';

    // Recovery logic: if the very last step contradicts the trend, neutralize it.
    // This prevents a single "bounce" at the end from showing a trend that just reversed.
    const lastStep = current - window[window.length - 2];
    if (symbol === '▲' && lastStep < -threshold * 0.5) symbol = '-';
    if (symbol === '▼' && lastStep > threshold * 0.5) symbol = '-';

    return symbol;
}

function valueToAqi(pollutantKey, value) {
    let val = parseFloat(value);
    if (!isFinite(val)) return null;

    let key = (pollutantKey || '').toLowerCase();

    // Normalize key for breakpoint lookup.
    if (key === 'pm25' || key === 'pm2.5' || key === 'pm2_5' || key === 'pm2-5' || key === 'pm 2.5') key = 'pm2.5';
    else if (key === 'pm10' || key === 'pm 10') key = 'pm10';
    else if (key === 'ozne' || key === 'ozone' || key === 'o3') key = 'ozone';

    // Normalize units + apply EPA truncation rules.
    // OZNE feed values are typically in ppb (e.g. 20-40). Breakpoints are in ppm.
    if (key === 'ozone') {
        if (val > 1.0) val = val / 1000.0; // ppb -> ppm
        val = Math.floor(val * 1000.0) / 1000.0; // truncate to 3 decimals
    } else if (key === 'pm2.5') {
        val = Math.floor(val * 10.0) / 10.0; // truncate to 1 decimal
    } else if (key === 'pm10') {
        val = Math.floor(val); // truncate to integer
    }

    const breakpointsByKey = {
        'pm2.5': [
            { cLow: 0.0, cHigh: 9.0, aqiLow: 0, aqiHigh: 50 },
            { cLow: 9.1, cHigh: 35.4, aqiLow: 51, aqiHigh: 100 },
            { cLow: 35.5, cHigh: 55.4, aqiLow: 101, aqiHigh: 150 },
            { cLow: 55.5, cHigh: 125.4, aqiLow: 151, aqiHigh: 200 },
            { cLow: 125.5, cHigh: 225.4, aqiLow: 201, aqiHigh: 300 },
            { cLow: 225.5, cHigh: 325.4, aqiLow: 301, aqiHigh: 500 },
        ],
        'pm10': [
            { cLow: 0.0, cHigh: 54.0, aqiLow: 0, aqiHigh: 50 },
            { cLow: 55.0, cHigh: 154.0, aqiLow: 51, aqiHigh: 100 },
            { cLow: 155.0, cHigh: 254.0, aqiLow: 101, aqiHigh: 150 },
            { cLow: 255.0, cHigh: 354.0, aqiLow: 151, aqiHigh: 200 },
            { cLow: 355.0, cHigh: 424.0, aqiLow: 201, aqiHigh: 300 },
            { cLow: 425.0, cHigh: 604.0, aqiLow: 301, aqiHigh: 500 },
        ],
        'ozone': [
            { cLow: 0.000, cHigh: 0.054, aqiLow: 0, aqiHigh: 50 },
            { cLow: 0.055, cHigh: 0.070, aqiLow: 51, aqiHigh: 100 },
            { cLow: 0.071, cHigh: 0.085, aqiLow: 101, aqiHigh: 150 },
            { cLow: 0.086, cHigh: 0.105, aqiLow: 151, aqiHigh: 200 },
            { cLow: 0.106, cHigh: 0.200, aqiLow: 201, aqiHigh: 300 },
        ],
    };

    const breakpoints = breakpointsByKey[key];
    if (!breakpoints) return null;

    for (const bp of breakpoints) {
        if (bp.cLow <= val && val <= bp.cHigh) {
            if (bp.cHigh === bp.cLow) return bp.aqiHigh;
            return ((bp.aqiHigh - bp.aqiLow) / (bp.cHigh - bp.cLow)) * (val - bp.cLow) + bp.aqiLow;
        }
    }

    if (val < breakpoints[0].cLow) return breakpoints[0].aqiLow;
    if (val > breakpoints[breakpoints.length - 1].cHigh) return breakpoints[breakpoints.length - 1].aqiHigh;
    return null;
}

function aqiPct(pollutantKey, value) {
    const aqi = valueToAqi(pollutantKey, value);
    if (!isFinite(aqi)) return 0;
    // Match the Textual TUI intent: scale to 300 so "Moderate" is not half a bar.
    return Math.max(0, Math.min(100, (aqi / 300.0) * 100.0));
}

function sparkPct(points, value) {
    // Relative sparkline for legibility: scale 0..max(history)
    const v = parseFloat(value);
    if (!isFinite(v)) return 0;
    let maxV = 0;
    for (const p of points) {
        const n = parseFloat(p);
        if (isFinite(n) && n > maxV) maxV = n;
    }
    if (maxV <= 0) maxV = 1.0;
    return Math.max(0, Math.min(100, (v / maxV) * 100.0));
}

function sparkSeverityScale(pollutantKey, points) {
    // Keep sparklines readable (shape), but avoid "tall" bars when the entire window
    // is low-severity air quality.
    let maxV = null;
    for (const p of points) {
        const n = parseFloat(p);
        if (!isFinite(n)) continue;
        if (maxV === null || n > maxV) maxV = n;
    }
    if (maxV === null) return 0.0;

    const sevPct = aqiPct(pollutantKey, maxV); // 0..100 (scaled to AQI 300)
    const sev = Math.max(0, Math.min(1, sevPct / 100.0));

    // Floor keeps low pollution still visible; sqrt makes it less aggressive at low end.
    return 0.25 + 0.75 * Math.sqrt(sev);
}

function moveSelection(dir) {
    const sensors = getAllSensors();
    const idx = sensors.findIndex(s => s.id === selectedSensorId);
    if (idx === -1) return;
    
    let newIdx = idx + dir;
    if (newIdx < 0) newIdx = 0;
    if (newIdx >= sensors.length) newIdx = sensors.length - 1;
    
    selectedSensorId = sensors[newIdx].id;
    selectedSensorType = sensors[newIdx].type;
    renderList();
    renderDetails();
    renderJson();
}

function renderDetails() {
    const container = document.getElementById('details-content');
    container.innerHTML = '';
    
    const sensors = getAllSensors();
    const s = sensors.find(s => s.id === selectedSensorId);
    
    if (!s) {
        container.innerHTML = '<div class="placeholder-text">Select a sensor</div>';
        return;
    }
    
    // Use tui-box structure
    const box = document.createElement('div');
    box.className = 'tui-box details-box';
    
    const title = document.createElement('div');
    title.className = 'tui-box-title';
    title.textContent = 'Sensor Details';
    box.appendChild(title);
    
    const nameHeader = document.createElement('div');
    nameHeader.className = 'sensor-name-large';
    let displayName = s.id;
    if (s.type === 'mobile') displayName += ' (Mobile Sensor)';
    if (s.type === 'fixed') displayName += ' (Fixed Sensor)';
    nameHeader.textContent = displayName;
    box.appendChild(nameHeader);
    
    const loc = document.createElement('div');
    loc.className = 'sensor-location';
    loc.textContent = `Location: ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`;
    box.appendChild(loc);
    
    const table = document.createElement('div');
    table.className = 'pollutant-table';
    
    ['Pollu...', 'Value', 'Level', 'History'].forEach(h => {
        const th = document.createElement('div');
        th.className = 'col-header';
        th.textContent = h;
        table.appendChild(th);
    });
    
    const pollutants = [
        { key: 'PM25', label: 'PM25' },
        { key: 'PM10', label: 'PM10' },
        { key: 'OZNE', label: 'OZNE' }
    ];
    
    pollutants.forEach(p => {
        let rKey = p.key;
        if (p.key === 'PM25' && !s.readings['PM25']) rKey = 'PM2.5';
        if (p.key === 'OZNE' && !s.readings['OZNE']) rKey = 'Ozone';
        
        const reading = s.readings[rKey] || s.readings[p.key.toLowerCase()];
        
        if (reading) {
            const nameEl = document.createElement('div');
            nameEl.className = 'p-name';
            nameEl.textContent = p.label;
            table.appendChild(nameEl);
            
            const valEl = document.createElement('div');
            valEl.className = 'p-value';
            valEl.textContent = parseFloat(reading.value).toFixed(1) + ' ' + getTrendSymbol(reading, p.key);
            valEl.style.color = reading.color;
            table.appendChild(valEl);
            
            const levelEl = document.createElement('div');
            levelEl.className = 'p-level';
            
            // Create segments for the bar to look like characters
            // TUI uses block characters. We can simulate with a gradient or multiple divs.
            // Let's use a simple filled div for now, but maybe dotted background?
            // TUI screenshot shows solid blocks.
            
            const bar = document.createElement('div');
            bar.style.height = '100%';

            // Level bar = severity by AQI/harm (not raw concentration).
            let pct = aqiPct(p.key, reading.value);
            // Tiny visible stub for non-zero severity (like the TUI's ▌).
            if (pct > 0 && pct < 2) pct = 2;
            
            bar.style.width = pct + '%';
            bar.style.backgroundColor = reading.color;
            levelEl.appendChild(bar);
            
            // Add dotted background for the rest
            const bg = document.createElement('div');
            bg.style.position = 'absolute';
            bg.style.top = '0';
            bg.style.left = '0';
            bg.style.width = '100%';
            bg.style.height = '100%';
            bg.style.backgroundImage = 'radial-gradient(#555 1px, transparent 1px)';
            bg.style.backgroundSize = '4px 4px';
            bg.style.opacity = '0.5';
            bg.style.zIndex = '0';
            levelEl.appendChild(bg);
            bar.style.zIndex = '1';
            bar.style.position = 'relative';
            
            table.appendChild(levelEl);
            
            const histEl = document.createElement('div');
            histEl.className = 'p-history';
            if (reading.history && reading.history.length) {
                const points = reading.history.slice(-20);
                const colors = reading.history_colors ? reading.history_colors.slice(-20) : [];
                
                points.forEach((pt, i) => {
                    const hBar = document.createElement('div');
                    hBar.className = 'hist-bar';
                    // Sparkline = relative history for readability at low levels.
                    const scale = sparkSeverityScale(p.key, points);
                    let hPct = sparkPct(points, pt) * scale;
                    if (hPct > 0 && hPct < 2) hPct = 2;
                    hBar.style.height = hPct + '%';
                    hBar.style.backgroundColor = colors[i] || reading.color;
                    histEl.appendChild(hBar);
                });
            } else {
                histEl.textContent = '...';
            }
            table.appendChild(histEl);
        }
    });
    
    box.appendChild(table);
    container.appendChild(box);
}

function renderJson() {
    // Ensure the container structure exists
    const pane = document.getElementById('raw-data-pane');
    let inner = document.getElementById('json-content-inner');
    
    if (!inner) {
        // First time setup: replace content with our TUI box structure
        pane.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'tui-box raw-data-box';
        
        const title = document.createElement('div');
        title.className = 'tui-box-title';
        title.textContent = 'Raw API Data (Live)';
        box.appendChild(title);
        
        const pre = document.createElement('pre');
        pre.id = 'json-content-inner';
        pre.style.margin = '0';
        pre.style.overflow = 'auto';
        pre.style.flex = '1';
        box.appendChild(pre);
        
        pane.appendChild(box);
        inner = pre;
    }
    
    const sensors = getAllSensors();
    const s = sensors.find(s => s.id === selectedSensorId);
    
    if (s) {
        // Construct a "cool" view of the data
        const view = {};
        
        // Metadata
        view._meta = {
            fetched_at: new Date().toLocaleTimeString(),
            status: s.ghosted ? "PARKED" : "ACTIVE",
            type: s.type.toUpperCase()
        };

        // Readings with partial history
        Object.keys(s.readings).forEach(k => {
            const r = s.readings[k];
            const histLen = r.history ? r.history.length : 0;
            const last5 = r.history ? r.history.slice(-5) : [];
            
            view[k] = {
                value: r.value,
                color: r.color,
                unit: r.unit || "ug/m3", // Assuming unit
                history_tail: last5,
                history_count: histLen
            };
        });
        
        // Mobility (Full object)
        if (s.mobility) {
            view.mobility = s.mobility;
        }
        
        // Raw coordinates
        view.location = {
            lat: s.lat,
            lon: s.lon
        };

        // Trail (if mobile)
        if (s.trail) {
            view.trail_points = s.trail.length;
            view.last_trail_point = s.trail[s.trail.length - 1];
        }
        
        const displayObj = {
            id: s.id,
            ...view
        };
        
        inner.innerHTML = syntaxHighlight(displayObj);
        
        // Flash effect
        inner.style.opacity = '0.5';
        setTimeout(() => inner.style.opacity = '1', 100);
        
    } else {
        inner.textContent = '{}';
    }
}

function syntaxHighlight(json) {
    if (typeof json != 'string') {
        json = JSON.stringify(json, undefined, 2);
    }
    json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        var cls = 'number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'key';
                return '<span style="color:#d3869b">' + match.replace('":', '"') + '</span>:'; // Purple keys
            } else {
                cls = 'string';
                return '<span style="color:#b8bb26">' + match + '</span>'; // Green strings
            }
        } else if (/true|false/.test(match)) {
            cls = 'boolean';
            return '<span style="color:#d3869b">' + match + '</span>';
        } else if (/null/.test(match)) {
            cls = 'null';
            return '<span style="color:#fabd2f">' + match + '</span>';
        }
        return '<span style="color:#83a598">' + match + '</span>'; // Blue numbers
    });
}
