/**
 * ZendIQ Lite – analytics.js
 * logEvent(type, data) — fire-and-forget event logging to the Lite backend.
 *
 * No-ops gracefully when liteBackendUrl is not configured or the request fails.
 * Never throws; never blocks the caller.
 */

function logEvent(type, data) {
  if (!type || typeof type !== 'string') return;
  chrome.storage.local.get(['liteBackendUrl'], ({ liteBackendUrl }) => {
    if (!liteBackendUrl || typeof liteBackendUrl !== 'string') return;
    const url = liteBackendUrl.replace(/\/+$/, '') + '/api/events';
    chrome.runtime.sendMessage({
      type: 'LOG_EVENT',
      url,
      payload: {
        type,
        data: data ?? {},
        ts: Date.now(),
        v: chrome.runtime.getManifest().version,
      },
    }, () => void chrome.runtime.lastError);
  });
}
