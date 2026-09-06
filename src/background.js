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

// ── Anonymous install identifier ────────────────────────────────────────────
// UUID generated once per browser profile, never transmitted with PII.
const _IID_KEY         = '_zqlite_install_id';
let   _cachedInstallId = null;
async function _getInstallId() {
  if (_cachedInstallId) return _cachedInstallId;
  return new Promise(resolve => {
    chrome.storage.local.get([_IID_KEY], r => {
      if (r[_IID_KEY]) { _cachedInstallId = r[_IID_KEY]; return resolve(r[_IID_KEY]); }
      const id = crypto.randomUUID();
      chrome.storage.local.set({ [_IID_KEY]: id }, () => { _cachedInstallId = id; resolve(id); });
    });
  });
}

// RPC endpoints tried in order; falls back on hard error
const RPC_ENDPOINTS = [
  'https://solana.publicnode.com',
  'https://api.mainnet-beta.solana.com',
];

// ── Analytics helpers ────────────────────────────────────────────────────────
// OPS-169. fetch() only rejects on network failure, so an HTTP 403/400 resolves
// normally — the previous `.catch(() => {})` discarded every server-side rejection
// without either end noticing. That is how a structured-ingest path can return zero
// rows for months while looking healthy.
//
// Two surfaces, deliberately:
//   1. a local ring buffer, for live debugging in the service-worker console;
//   2. `prior_failures` attached to the next SUCCESSFUL send, so the server learns
//      about an outage on recovery even if nobody ever opens that console.
// (1) alone would recreate the original defect one level up: an unread failure log
// is as silent as a swallowed 4xx.
const _FAIL_KEY = '_zqlite_telemetry_failures';
const _FAIL_MAX = 20;

function _recordSendFailure(status, type, detail) {
  try {
    chrome.storage.local.get([_FAIL_KEY], (r) => {
      const arr = Array.isArray(r?.[_FAIL_KEY]) ? r[_FAIL_KEY] : [];
      arr.push({ t: Date.now(), status, type, detail: String(detail ?? '').slice(0, 200) });
      chrome.storage.local.set({ [_FAIL_KEY]: arr.slice(-_FAIL_MAX) });
    });
  } catch (_) {}
}

// Summarise buffered failures so they can ride along on the next request.
function _peekFailures() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([_FAIL_KEY], (r) => {
        const arr = Array.isArray(r?.[_FAIL_KEY]) ? r[_FAIL_KEY] : [];
        if (!arr.length) return resolve(null);
        resolve({
          reported: arr.length,
          summary: {
            count:       arr.length,
            oldest_ts:   arr[0].t,
            last_status: arr[arr.length - 1].status,
          },
        });
      });
    } catch (_) { resolve(null); }
  });
}

// Drop only the entries we actually reported — failures logged while the reporting
// request was in flight must survive.
function _clearReportedFailures(n) {
  try {
    chrome.storage.local.get([_FAIL_KEY], (r) => {
      const arr = Array.isArray(r?.[_FAIL_KEY]) ? r[_FAIL_KEY] : [];
      chrome.storage.local.set({ [_FAIL_KEY]: arr.slice(n) });
    });
  } catch (_) {}
}

// Single exit point for every analytics POST. Never throws; always resolves.
async function _postEvent(url, bodyObj, typeLabel) {
  const pending = await _peekFailures();
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(pending ? { ...bodyObj, prior_failures: pending.summary } : bodyObj),
    });
    if (r.ok) {
      if (pending) _clearReportedFailures(pending.reported);
      return;
    }
    let detail = '';
    try { detail = (await r.text()).slice(0, 200); } catch (_) {}
    console.warn('[ZendIQ] telemetry rejected', r.status, typeLabel, detail);
    _recordSendFailure(r.status, typeLabel, detail);
  } catch (err) {
    const m = err?.message ?? String(err);
    console.warn('[ZendIQ] telemetry send failed', typeLabel, m);
    _recordSendFailure(0, typeLabel, m);
  }
}

async function _logToBackend(type, data, extras) {
  const install_id = await _getInstallId();
  return _postEvent(BACKEND_URL + '/api/events', {
    type, source: 'lite', install_id,
    data: data ?? {},
    v:   chrome.runtime.getManifest().version,
    ts:  Date.now(),
    ext_id: chrome.runtime.id,
    ...(extras ?? {}),
  }, type);
}

// extension_installed — fires once on fresh install or on any version update
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  if (reason !== 'install' && reason !== 'update') return;
  const ua      = navigator.userAgent;
  const locale  = navigator.language ?? '';
  const country = locale.includes('-') ? locale.split('-').pop() : locale.toUpperCase();
  const os      = ua.includes('Windows') ? 'windows' : ua.includes('Mac OS X') ? 'mac' : ua.includes('Linux') ? 'linux' : 'other';
  const browser = ua.includes('Brave') ? 'brave' : 'chrome';
  _logToBackend('extension_installed', {
    reason, prev_version: previousVersion ?? null,
    browser, os, locale: locale.slice(0, 10),
    country: (typeof country === 'string' && country.length === 2) ? country : null,
  }, { category: 'install' });
});

// daily_active — at most once per UTC calendar day on any service worker wake
(function () {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  chrome.storage.local.get(['_zqlite_last_active_day'], (result) => {
    const { _zqlite_last_active_day } = result ?? {};
    if (_zqlite_last_active_day === today) return;
    chrome.storage.local.set({ _zqlite_last_active_day: today });
    _logToBackend('daily_active', { day: today }, { category: 'heartbeat' });
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
          if (status !== 429 && status !== 502 && status !== 503) {
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

  // ── Quote accuracy polling — runs in background so page navigation can't kill it ──
  // ── Symbol lookup for unknown input tokens ────────────────────────────────
  if (msg.type === 'FETCH_SYMBOL') {
    const { mint, signature } = msg;
    sendResponse({ ok: true });
    if (!mint || !signature) return false;
    (async () => {
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 6000);
        const r = await fetch(
          `https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`,
          { headers: { Accept: 'application/json' }, signal: ac.signal }
        );
        if (!r.ok) return;
        const data = await r.json();
        // DexScreener returns an array of pairs; grab symbol from first pair's baseToken
        const sym = (Array.isArray(data) ? data : data?.pairs ?? [])
          .slice(0, 5).map(p => p?.baseToken?.symbol).find(s => s && typeof s === 'string');
        if (!sym) return;
        chrome.storage.local.get(['zqlite_swap_history'], ({ zqlite_swap_history: hist = [] }) => {
          if (!Array.isArray(hist)) return;
          const idx = hist.findIndex(e => e.signature === signature);
          if (idx === -1 || hist[idx].tokenIn) return; // don't overwrite an existing value
          hist[idx].tokenIn = sym;
          chrome.storage.local.set({ zqlite_swap_history: hist });
        });
      } catch {}
    })();
    return false;
  }

  if (msg.type === 'FETCH_ACCURACY') {
    const { signature, outputMint, quotedRawOut, outputDecimals } = msg;
    let walletPubkey = msg.walletPubkey ?? null;
    sendResponse({ ok: true }); // acknowledge immediately; work is fire-and-forget
    if (!signature || !outputMint) return false;
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const isSOL = outputMint === SOL_MINT;
    const _parseAmt = (e) => {
      const t = e?.uiTokenAmount;
      if (!t) return 0;
      if (t.uiAmountString != null && t.uiAmountString !== '') return parseFloat(t.uiAmountString) || 0;
      if (t.uiAmount       != null) return t.uiAmount;
      if (t.amount != null && t.decimals != null) return Number(t.amount) / Math.pow(10, t.decimals);
      return 0;
    };
    const _patchStorage = (qAcc, actualOut, quotedOut) => {
      chrome.storage.local.get(['zqlite_swap_history'], ({ zqlite_swap_history: hist = [] }) => {
        if (!Array.isArray(hist)) return;
        const idx = hist.findIndex(e => e.signature === signature);
        if (idx === -1) return;
        let changed = false;
        if (hist[idx].quoteAccuracy == null) { hist[idx].quoteAccuracy = qAcc; changed = true; }
        if (actualOut != null && hist[idx].actualOut == null) { hist[idx].actualOut = actualOut; changed = true; }
        if (quotedOut != null && hist[idx].quotedOut == null) { hist[idx].quotedOut = quotedOut; changed = true; }
        if (changed) chrome.storage.local.set({ zqlite_swap_history: hist });
      });
    };
    (async () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction',
        params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] });
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          // Re-resolve wallet pubkey from storage on each attempt — may have been null at call time
          if (!walletPubkey) {
            await new Promise(res => chrome.storage.local.get(['zqlite_wallet_pubkey'], ({ zqlite_wallet_pubkey: pk }) => {
              if (pk) walletPubkey = pk;
              res();
            }));
          }
          if (!walletPubkey) continue; // still not available — retry
          let tx = null;
          for (const url of RPC_ENDPOINTS) {
            try {
              const ac = new AbortController();
              const t  = setTimeout(() => ac.abort(), 8000);
              const r  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ac.signal });
              clearTimeout(t);
              if (!r.ok) continue;
              const d = await r.json();
              if (d?.result?.meta) { tx = d.result; break; }
            } catch {}
          }
          if (!tx?.meta) continue;
          const meta = tx.meta;
          let actualOut = null;
          if (isSOL) {
            const m2   = tx.transaction?.message ?? {};
            const keys = m2.staticAccountKeys ?? m2.accountKeys ?? [];
            const idx  = keys.findIndex(k => (typeof k === 'string' ? k : k.pubkey) === walletPubkey);
            if (idx >= 0) {
              const recv = (meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0) + (meta.fee ?? 0);
              if (recv > 0) actualOut = recv / 1e9;
            }
          } else {
            const post = meta.postTokenBalances ?? [];
            const pre  = meta.preTokenBalances  ?? [];
            let postEntry = post.find(e => e.mint === outputMint && e.owner === walletPubkey);
            let preEntry  = pre.find( e => e.mint === outputMint && e.owner === walletPubkey);
            if (!postEntry) {
              const cands = post.filter(e => e.mint === outputMint);
              let best = 0;
              for (const pe of cands) {
                const pr = pre.find(e => e.mint === outputMint && e.accountIndex === pe.accountIndex);
                const d  = _parseAmt(pe) - _parseAmt(pr);
                if (d > best) { best = d; postEntry = pe; preEntry = pr; }
              }
            }
            if (postEntry) { const d = _parseAmt(postEntry) - _parseAmt(preEntry); if (d > 0) actualOut = d; }
          }
          if (actualOut == null) { if (attempt < 3) continue; _patchStorage(-1, null, null); return; }
          let quoteAccuracy = null, quotedOutUI = null;
          if (quotedRawOut != null && quotedRawOut > 0 && outputDecimals != null) {
            quotedOutUI = Number(quotedRawOut) / Math.pow(10, outputDecimals);
            if (quotedOutUI > 0) quoteAccuracy = Math.min(100, (actualOut / quotedOutUI) * 100);
          }
          _patchStorage(quoteAccuracy ?? -1, actualOut, quotedOutUI);
          return;
        } catch {}
      }
      _patchStorage(-1, null, null);
    })();
    return false; // response already sent synchronously
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
    let urlOriginOk = false;
    try { urlOriginOk = new URL(url).origin === _backendOrigin; } catch {}
    if (!urlOriginOk) { sendResponse({ ok: false, error: 'Invalid backend URL' }); return true; }
    // Inject install_id so structured-table routes have it even from popup scripts.
    // NOTE: deliberately does NOT inject ext_id — adding it here would change which
    // requests the server's ext-ID gate rejects, which is a separate reviewed step.
    _getInstallId().then(install_id =>
      _postEvent(url, { ...(payload ?? {}), install_id }, payload?.type ?? 'LOG_EVENT'));
    sendResponse({ ok: true });
    return true;
  }

});
