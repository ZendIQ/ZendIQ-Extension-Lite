/**
 * ZendIQ Lite — background.js
 * Service worker. Handles all external fetches (popup cannot fetch cross-origin in MV3).
 * Handles: PING, FETCH_JSON, RPC_CALL
 */

// Allowed origins for FETCH_JSON — prevents SSRF
const FETCH_JSON_ALLOWED = new Set([
  'https://api.rugcheck.xyz',
  'https://api.dexscreener.com',
  'https://api.geckoterminal.com',
  'https://api.mainnet-beta.solana.com',
  'https://solana.publicnode.com',
]);

// Backend URL — hardcoded for the store build.
const BACKEND_URL = 'https://zendiq-backend.onrender.com';
const _backendOrigin = new URL(BACKEND_URL).origin;

// RPC endpoints tried in order; falls back on hard error
const RPC_ENDPOINTS = [
  'https://solana.publicnode.com',
  'https://api.mainnet-beta.solana.com',
];

// ── Analytics helpers ────────────────────────────────────────────────────────
// Fire-and-forget: POST an event to the user-configured backend.
// Silently no-ops when no backend URL has been set.
function _logToBackend(type, data) {
  fetch(BACKEND_URL + '/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, data: data ?? {}, v: chrome.runtime.getManifest().version, ts: Date.now(), ext_id: chrome.runtime.id }),
  }).catch(() => {});
}

// extension_installed — fires once on fresh install or on any version update
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason !== 'install' && reason !== 'update') return;
  _logToBackend('extension_installed', {
    reason,
    prev_version: previousVersion ?? null,
    browser: navigator.userAgent.includes('Brave') ? 'brave' : 'chrome',
  });
});

// daily_active — at most once per UTC calendar day on any service worker wake
(function () {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  chrome.storage.local.get(['_zqlite_last_active_day'], ({ _zqlite_last_active_day }) => {
    if (_zqlite_last_active_day === today) return;
    chrome.storage.local.set({ _zqlite_last_active_day: today });
    _logToBackend('daily_active', { day: today });
  });
})();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // ── Ping ────────────────────────────────────────────────────────────────
  if (msg.type === 'PING') {
    sendResponse({ ok: true, data: 'pong' });
    return true;
  }

  // ── Generic JSON GET ─────────────────────────────────────────────────────
  if (msg.type === 'FETCH_JSON') {
    let parsedUrl;
    try { parsedUrl = new URL(msg.url); } catch {
      sendResponse({ ok: false, error: 'Invalid URL' });
      return true;
    }
    const allowed = FETCH_JSON_ALLOWED.has(parsedUrl.origin) || (parsedUrl.origin === _backendOrigin);
    if (!allowed) {
      sendResponse({ ok: false, error: 'URL not in allowlist' });
      return true;
    }
    const fetchOpts = msg.headers ? { headers: msg.headers } : {};
    fetch(msg.url, fetchOpts)
      .then(async r => {
        if (!r.ok) {
          const status = r.status;
          if (status !== 429 && status !== 503) {
            console.error('[ZendIQ Lite] FETCH_JSON error: HTTP', status, msg.url);
          }
          sendResponse({ ok: false, error: 'HTTP ' + status, status });
          return;
        }
        const data = await r.json();
        sendResponse({ ok: true, data });
      })
      .catch(err => {
        console.error('[ZendIQ Lite] FETCH_JSON fetch error:', err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  // ── RPC call ─────────────────────────────────────────────────────────────
  if (msg.type === 'RPC_CALL') {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: msg.method, params: msg.params ?? [],
    });
    const tryNext = (endpoints) => {
      if (!endpoints.length) {
        sendResponse({ ok: false, error: 'All RPC endpoints failed' });
        return;
      }
      const [url, ...rest] = endpoints;
      // 5-second per-endpoint timeout prevents a hanging endpoint from blocking
      // the fallback chain and causing the whole 20s bridge timeout to fire.
      const ac = new AbortController();
      const t  = setTimeout(() => ac.abort(), 5000);
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ac.signal })
        .then(r => { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(data => {
          if (data?.error && rest.length) { tryNext(rest); return; }
          sendResponse({ ok: true, data });
        })
        .catch(() => { clearTimeout(t); tryNext(rest); });
    };
    tryNext(RPC_ENDPOINTS);
    return true;
  }

  // ── Open popup ───────────────────────────────────────────────────────────
  if (msg.type === 'OPEN_POPUP') {
    try { chrome.action.openPopup(); } catch (_) {}
    sendResponse({ ok: true });
    return true;
  }

  // ── Event logging (fire-and-forget from analytics.js) ─────────────────
  if (msg.type === 'LOG_EVENT') {
    const { url, payload } = msg;
    if (!url || typeof url !== 'string') { sendResponse({ ok: false }); return true; }
    {
      let urlOriginOk = false;
      try { urlOriginOk = new URL(url).origin === _backendOrigin; } catch {}
      if (!urlOriginOk) {
        sendResponse({ ok: false, error: 'Invalid backend URL' });
        return;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
    }
    return true;
  }

});
