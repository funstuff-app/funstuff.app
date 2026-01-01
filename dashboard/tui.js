/**
 * Browser-based TUI console interface.
 * 
 * This file consumes the shared TUI format from /api/tui endpoint,
 * which provides pre-formatted sensor data that mirrors the Python
 * Textual TUI rendering logic.
 * 
 * The goal is to have consistent display between terminal and web.
 */

// ============================================================================
// Shared format constants (must match mobileair/tui_format.py)
// ============================================================================
const POLLUTANT_ORDER = ["PM25", "PM10", "OZNE"];
const VALUE_WIDTH = 5;
const MAX_NAME_LEN = 25;

// ============================================================================
// State
// ============================================================================
const API_URL = '/api/state';        // Raw state for detail views
const TUI_API_URL = '/api/tui';       // Pre-formatted TUI state
let appState = {
    mobile: [],
    fixed: [],
    meta: {},
    ts: 0
};
let tuiState = null;  // Cached TUI-formatted state
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
        // Fetch both raw state and TUI-formatted state in parallel
        const [rawRes, tuiRes] = await Promise.all([
            fetch(API_URL),
            fetch(TUI_API_URL)
        ]);
        
        const data = await rawRes.json();
        appState = data;
        
        if (tuiRes.ok) {
            tuiState = await tuiRes.json();
        }

        maybeShowOutlierToast(data);
        
        // Use TUI state timestamp if available, otherwise raw state
        const ts = tuiState?.ts || data.ts;
        const date = new Date(ts * 1000);
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
    // Use pre-formatted TUI state if available (already sorted and filtered)
    if (tuiState && tuiState.sensors && tuiState.sensors.length > 0) {
        return tuiState.sensors;
    }
    
    // Fallback to raw state processing
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
        
        // Name/ID line
        const nameLine = document.createElement('div');
        nameLine.className = 'sensor-header';
        
        // Use pre-formatted name from TUI state if available
        let displayName = s.display_name || s.id;
        if (!s.display_name && s.name) {
            displayName = `${s.id} (${s.name})`;
        }
        
        // Pin icon
        if (s.pinned) {
            const pin = document.createElement('span');
            pin.textContent = '📌';
            pin.style.color = '#fb4934'; // Red pin
            nameLine.appendChild(pin);
        }

        // Parked/Ghosted indicator
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
        
        // Readings line - use pre-formatted columns if available
        const readingsLine = document.createElement('div');
        readingsLine.className = 'sensor-readings';
        
        if (s.columns && Array.isArray(s.columns)) {
            // Use shared format columns from /api/tui
            renderColumnsFromSharedFormat(readingsLine, s.columns);
        } else if (s.readings) {
            // Fallback to legacy rendering from raw state
            renderColumnsFromRawReadings(readingsLine, s.readings);
        }
        
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

/**
 * Render pollutant columns using the shared format from /api/tui.
 * This mirrors the Python TUI rendering exactly.
 */
function renderColumnsFromSharedFormat(container, columns) {
    columns.forEach((col, i) => {
        if (i > 0) {
            // Add separator between columns
            const sep = document.createElement('span');
            sep.textContent = '  ';
            sep.className = 'col-separator';
            container.appendChild(sep);
        }
        
        if (col.has_value) {
            const rEl = document.createElement('div');
            rEl.className = 'reading';
            
            const label = document.createElement('span');
            label.className = 'reading-label';
            label.textContent = col.label + ':';
            
            const val = document.createElement('span');
            val.className = 'reading-value';
            // Use pre-formatted value (already right-aligned)
            val.textContent = col.formatted;
            val.style.color = col.color;
            
            const trend = document.createElement('span');
            trend.className = 'reading-trend';
            trend.textContent = ' ' + col.trend_symbol;
            trend.style.color = col.trend_color;
            
            rEl.appendChild(label);
            rEl.appendChild(val);
            rEl.appendChild(trend);
            container.appendChild(rEl);
        } else {
            // Empty placeholder for alignment (matches Python TUI)
            const placeholder = document.createElement('span');
            placeholder.className = 'reading-placeholder';
            // label(4) + ": "(2) + value(VALUE_WIDTH=5) + " "(1) + trend(1) = 13
            const width = col.label.length + 2 + VALUE_WIDTH + 2;
            placeholder.textContent = ' '.repeat(width);
            container.appendChild(placeholder);
        }
    });
}

/**
 * Fallback: Render columns from raw readings (legacy format).
 */
function renderColumnsFromRawReadings(container, readings) {
    POLLUTANT_ORDER.forEach((key, i) => {
        let rKey = key;
        if (key === 'PM25' && !readings['PM25']) rKey = 'PM2.5';
        if (key === 'OZNE' && !readings['OZNE']) rKey = 'Ozone';
        
        let reading = readings[rKey] || readings[key] || readings[key.toLowerCase()];
        
        if (i > 0) {
            const sep = document.createElement('span');
            sep.textContent = '  ';
            sep.className = 'col-separator';
            container.appendChild(sep);
        }
        
        if (reading) {
            const rEl = document.createElement('div');
            rEl.className = 'reading';
            
            const label = document.createElement('span');
            label.className = 'reading-label';
            label.textContent = key + ':';
            
            const val = document.createElement('span');
            val.className = 'reading-value';
            val.textContent = parseFloat(reading.value).toFixed(1).padStart(VALUE_WIDTH);
            val.style.color = reading.color;
            
            const trend = document.createElement('span');
            trend.className = 'reading-trend';
            trend.textContent = ' ' + getTrendSymbol(reading, key);
            trend.style.color = '#666';
            
            rEl.appendChild(label);
            rEl.appendChild(val);
            rEl.appendChild(trend);
            container.appendChild(rEl);
        } else {
            // Empty placeholder
            const placeholder = document.createElement('span');
            placeholder.className = 'reading-placeholder';
            const width = key.length + 2 + VALUE_WIDTH + 2;
            placeholder.textContent = ' '.repeat(width);
            container.appendChild(placeholder);
        }
    });
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

/**
 * Get raw reading data for a column (needed for history sparklines).
 * This looks up the reading in either the shared format or raw state.
 */
function getReadingForColumn(sensor, pollutantKey) {
    // First try the readings property from shared format
    if (sensor.readings && typeof sensor.readings === 'object') {
        // Try exact key first
        let reading = sensor.readings[pollutantKey];
        if (reading) return reading;
        
        // Try alternate key names
        if (pollutantKey === 'PM25') {
            reading = sensor.readings['PM2.5'] || sensor.readings['pm25'];
        } else if (pollutantKey === 'OZNE') {
            reading = sensor.readings['Ozone'] || sensor.readings['ozone'] || sensor.readings['O3'];
        } else {
            reading = sensor.readings[pollutantKey.toLowerCase()];
        }
        if (reading) return reading;
    }
    
    // Fallback: look up in raw appState
    const rawSensor = [...(appState.mobile || []), ...(appState.fixed || [])]
        .find(s => s.id === sensor.id);
    
    if (rawSensor && rawSensor.readings) {
        let reading = rawSensor.readings[pollutantKey];
        if (!reading && pollutantKey === 'PM25') {
            reading = rawSensor.readings['PM2.5'];
        }
        if (!reading && pollutantKey === 'OZNE') {
            reading = rawSensor.readings['Ozone'] || rawSensor.readings['ozone'];
        }
        return reading;
    }
    
    return null;
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
    // Use pre-formatted type_label from shared format if available
    let displayName = s.display_name || s.id;
    const typeLabel = s.type_label || (s.type === 'mobile' ? 'Mobile Sensor' : 'Fixed Sensor');
    displayName += ` (${typeLabel})`;
    nameHeader.textContent = displayName;
    box.appendChild(nameHeader);
    
    const loc = document.createElement('div');
    loc.className = 'sensor-location';
    if (s.lat != null && s.lon != null) {
        loc.textContent = `Location: ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`;
    } else {
        loc.textContent = 'Location: Unknown';
    }
    box.appendChild(loc);
    
    const table = document.createElement('div');
    table.className = 'pollutant-table';
    
    ['Pollutant', 'Value', 'Level', 'History'].forEach(h => {
        const th = document.createElement('div');
        th.className = 'col-header';
        th.textContent = h;
        table.appendChild(th);
    });
    
    // Use columns from shared format if available, otherwise fall back to readings
    const columnsToRender = s.columns || POLLUTANT_ORDER.map(key => {
        // Build column from raw readings
        const readings = s.readings || {};
        let rKey = key;
        if (key === 'PM25' && !readings['PM25']) rKey = 'PM2.5';
        if (key === 'OZNE' && !readings['OZNE']) rKey = 'Ozone';
        const reading = readings[rKey] || readings[key] || readings[key.toLowerCase()];
        
        if (reading) {
            return {
                key: key,
                label: key,
                value: reading.value,
                formatted: parseFloat(reading.value).toFixed(1).padStart(VALUE_WIDTH),
                color: reading.color,
                has_value: true,
                trend_symbol: getTrendSymbol(reading, key),
                trend_color: '#888888',
            };
        }
        return { key: key, label: key, has_value: false };
    });
    
    columnsToRender.forEach(col => {
        if (!col.has_value) return;
        
        const nameEl = document.createElement('div');
        nameEl.className = 'p-name';
        nameEl.textContent = col.label;
        table.appendChild(nameEl);
        
        const valEl = document.createElement('div');
        valEl.className = 'p-value';
        valEl.textContent = col.formatted + ' ' + col.trend_symbol;
        valEl.style.color = col.color;
        table.appendChild(valEl);
        
        const levelEl = document.createElement('div');
        levelEl.className = 'p-level';
        
        // Get reading data for level bar and history
        const reading = getReadingForColumn(s, col.key);
        
        const bar = document.createElement('div');
        bar.style.height = '100%';

        // Level bar = severity by AQI/harm (not raw concentration).
        let pct = aqiPct(col.key, col.value);
        // Tiny visible stub for non-zero severity (like the TUI's ▌).
        if (pct > 0 && pct < 2) pct = 2;
        
        bar.style.width = pct + '%';
        bar.style.backgroundColor = col.color;
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
        if (reading && reading.history && reading.history.length) {
            const points = reading.history.slice(-20);
            const colors = reading.history_colors ? reading.history_colors.slice(-20) : [];
            
            points.forEach((pt, i) => {
                const hBar = document.createElement('div');
                hBar.className = 'hist-bar';
                // Sparkline = relative history for readability at low levels.
                const scale = sparkSeverityScale(col.key, points);
                let hPct = sparkPct(points, pt) * scale;
                if (hPct > 0 && hPct < 2) hPct = 2;
                hBar.style.height = hPct + '%';
                hBar.style.backgroundColor = colors[i] || col.color;
                histEl.appendChild(hBar);
            });
        } else {
            histEl.textContent = '...';
        }
        table.appendChild(histEl);
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
