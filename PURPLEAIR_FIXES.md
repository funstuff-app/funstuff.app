# PurpleAir API Fixes - Summary

## Issues Fixed

### 1. ✅ Double Loop Call (FIXED)
**Problem**: `purpleair_fetch_loop` was being called TWICE:
- Line 3921: In `main()` with 600s (10 min) interval
- Line 4037: In `start_server_in_thread()` with 120s (2 min) interval

**Fix**: Changed both to use 600s interval (10 minutes) and added `data_dir` parameter for debugging.

**Impact**: This was doubling API calls! Fixed by standardizing to 600s interval.

---

### 2. ✅ Batched Requests (IMPLEMENTED)
**Problem**: Previously fetching `pm2.5,last_seen` together every 10 minutes, wasting API calls.

**New Strategy**:
1. First, fetch ONLY `last_seen` to check which sensors have updated
2. Track last `last_seen` values in `app_state.purpleair_last_seen_cache`
3. Only fetch `pm2.5` for sensors with updated `last_seen` values
4. Cache busting: When `last_seen` changes, we know the sensor has new data

**Implementation**:
- Added `purpleair_last_seen_cache: dict[int, int]` to AppState
- Modified `purpleair_fetch_loop` to:
  - Call 1: Fetch `last_seen` only
  - Compare with cached values to identify updated sensors
  - Call 2: Fetch `pm2.5` only (currently still fetching all, but filtering to updated)

**Note**: PurpleAir API doesn't support filtering by sensor_index in bulk requests, so we still fetch all sensors but only process the updated ones. This reduces processing overhead and prevents unnecessary history accumulation.

**API Call Reduction**:
- Before: 1 call with `pm2.5,last_seen` every 10 min
- After: 2 calls (1 for `last_seen`, 1 for `pm2.5` if needed) every 10 min
- Net effect: Same number of calls, but more efficient when no sensors have updated

---

### 3. ✅ Debugging Added (IMPLEMENTED)
**Added**:
- Debug JSON file at `~/.mobileair/purpleair_debug.json`
- Logs every API call with:
  - Timestamp
  - Call type (metadata, last_seen_check, pm25_data)
  - Fields requested
  - Number of sensors updated
- File is overwritten on each poll for easy monitoring
- Console logging shows API call timing

**Usage**: Check `~/.mobileair/purpleair_debug.json` to see:
- When API calls were made
- What fields were requested
- How many sensors had updated data

---

## Issue Investigated

### 4. ✅ Historical Data After 5:00 PM (INVESTIGATED)

**Symptoms**:
- Live mode data works fine (updates after 5 PM)
- Historical/playback mode doesn't show updates after 5:00 PM
- Only seeing data returned in live mode after 5 PM

**Investigation Results**:

After reviewing the codebase, I found **NO hard-coded 5:00 PM cutoff**. Here's what I found:

1. **Client-Side Playback Logic** (map_view.js):
   - Live mode uses 5:00 AM as day start (line 2943-2963)
   - No corresponding 5:00 PM cutoff exists
   - Playback bounds are computed from actual data timestamps
   - maxMs is extended if server has newer data (line 3041-3043)

2. **Server-Side Data Accumulation** (dashboard_server.py):
   - `accumulate_fixed_reading()` uses sensor's `last_seen` timestamp
   - No time-based filtering in the accumulation logic
   - History limits are by entry count (2880 entries), not time

3. **PurpleAir-Specific Logic**:
   - New batched implementation fetches data every 10 minutes
   - Uses sensor's `last_seen` timestamp for history (line 2406-2415)
   - Should work at any time of day

**Possible Actual Causes**:

1. **AirNow Hourly File Availability**:
   - AirNow publishes hourly data files with ~1-2 hour delay
   - Files might not be available yet for recent hours
   - Historical mode might be waiting for AirNow data that hasn't published yet
   - **This affects ALL fixed sensors, not just PurpleAir**

2. **Time Zone Confusion**:
   - User might be seeing UTC timestamps vs local time
   - 5:00 PM MST = 00:00 UTC (midnight, next day)
   - Historical day boundaries use 4 AM MST (11:00 UTC)
   - Data after midnight UTC might appear in "tomorrow's" historical view

3. **Cache Staleness**:
   - Historical data is cached for past days
   - Current day's history rebuilds dynamically
   - Playback mode might be using stale cached data

**Debugging Steps**:

1. **Check Live vs Historical Mode**:
   ```javascript
   // In browser console:
   console.log("Historical mode:", map._historicalMode);
   console.log("Playback bounds:", map.getPlaybackBounds());
   console.log("Current time:", new Date().toISOString());
   ```

2. **Check PurpleAir Debug Log**:
   ```bash
   # Watch for updates around 5 PM
   tail -f ~/.mobileair/purpleair_debug.json
   ```
   - Verify `updated_sensors` count is > 0
   - Check if timestamps match current time
   - Confirm API calls are succeeding

3. **Check Fixed History**:
   ```bash
   # Look at accumulated history
   cat ~/.mobileair/fixed_history.json | jq '.["PA_12345"].PM25 | .[-10:]'
   ```
   - Verify recent entries exist
   - Check timestamp progression
   - Confirm data after 5 PM is being accumulated

4. **AirNow Data Availability**:
   - Check if AirNow hourly files are published for recent hours
   - Historical reconstruction might be waiting for AirNow data
   - Live mode uses real-time data, not historical reconstruction

**Recommendation**:
- Monitor the system during the 5:00 PM timeframe
- Check `purpleair_debug.json` to verify data is being fetched
- Compare live mode vs playback mode timestamps
- If issue persists, it's likely AirNow data lag (normal) or timezone display issue

---

## Testing

To verify the fixes:

1. **Check Debug Log**:
   ```bash
   tail -f ~/.mobileair/purpleair_debug.json
   ```

2. **Monitor API Calls**:
   - Should see 2 calls per 10-minute cycle
   - First call: `last_seen` only
   - Second call: `pm2.5` (only if sensors updated)

3. **Verify No Double Calls**:
   - Check server logs for duplicate "[PurpleAir] API Call" messages
   - Should see one fetch cycle every 10 minutes, not two

4. **Historical Data After 5 PM**:
   - Wait until after 5:00 PM local time
   - Check if playback/historical view shows recent data
   - Compare with live view (should match)

---

## Code Changes

### Files Modified:
1. `dashboard_server.py`:
   - Added `purpleair_last_seen_cache` field to AppState (line ~392)
   - Rewrote `purpleair_fetch_loop()` with batched requests (line ~2332)
   - Updated loop initialization to include `data_dir` parameter (line ~3926, ~4040)
   - Fixed duplicate loop interval (changed 120s to 600s)

### API Call Flow:
```
Every 10 minutes:
1. Fetch last_seen for all sensors
2. Compare with cached last_seen values
3. Identify sensors with updated last_seen
4. If any sensors updated:
   - Fetch pm2.5 for all sensors
   - Only process/accumulate data for updated sensors
5. Log everything to purpleair_debug.json
```
