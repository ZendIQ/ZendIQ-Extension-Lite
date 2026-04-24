/**
 * ZendIQ Lite – analytics.js
 * Fire-and-forget event logging helpers for popup and content scripts.
 * Background.js injects install_id into every outbound payload via the LOG_EVENT handler.
 */

const BACKEND_URL = 'https://zendiq-backend.onrender.com';

// ── logEvent — backward-compat event logger ───────────────────────────────────
function logEvent(type, data) {
  if (!type || typeof type !== 'string') return;
  chrome.runtime.sendMessage({
    type:    'LOG_EVENT',
    url:     BACKEND_URL + '/api/events',
    payload: {
      type,
      source: 'lite',
      data:   data ?? {},
      ts:     Date.now(),
      v:      chrome.runtime.getManifest().version,
    },
  }, () => void chrome.runtime.lastError);
}

// ── Category-based helpers (route to structured tables via background.js) ─────
// background.js injects install_id into every outbound payload.
function _logCat(category, type, data) {
  chrome.runtime.sendMessage({
    type:    'LOG_EVENT',
    url:     BACKEND_URL + '/api/events',
    payload: {
      category,
      type,
      source: 'lite',
      data:   data ?? {},
      ts:     Date.now(),
      v:      chrome.runtime.getManifest().version,
    },
  }, () => void chrome.runtime.lastError);
}

function logSession(type, data)      { _logCat('session', type, data); }
function logTrade(data)              { _logCat('trade', 'trade', data); }
function logMev(data)                { _logCat('mev', 'mev_detection', data); }
function logError(errCategory, data) { _logCat('error', errCategory, data); }
function logFunnel(event, data)      { _logCat('funnel', event, { event, ...(data ?? {}) }); }
