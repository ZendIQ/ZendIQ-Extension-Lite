/**
 * ZendIQ Lite — page-config.js
 * Sets up window.__zqlite namespace + postMessage-based rpcCall / pageJsonFetch.
 * Runs in MAIN world at document_start — all other scripts depend on this.
 */
(function () {
  'use strict';
  if (window.__zqlite) return;
  console.log('[ZendIQ Lite] ✓ page-config.js running on', location.hostname);

  // ── Correlation map for async postMessage round-trips ─────────────────────
  let _msgId = 0;
  const _pending = new Map();

  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;
    const d = e.data;

    if (d.type === 'ZQLITE_SETTINGS_RESPONSE') {
      const s = d.settings ?? {};
      if (s.enabled      !== undefined) ns.settings.enabled      = s.enabled;
      if (s.minRiskLevel)               ns.settings.minRiskLevel = s.minRiskLevel;
      if (s.sites)                      ns.settings.sites = { ...ns.settings.sites, ...s.sites };
      return;
    }

    if (d.type === 'ZQLITE_RPC_RESPONSE' || d.type === 'ZQLITE_FETCH_RESPONSE') {
      const p = _pending.get(d._id);
      if (!p) return;
      _pending.delete(d._id);
      if (d.result?.ok) p.resolve(d.result.data);
      else p.reject(new Error(d.result?.error ?? 'Bridge response failed'));
      return;
    }

    if (d.type === 'ZQLITE_SEC_REVIEWED_RESPONSE') {
      ns.walletReviewedAutoApprove = !!d.reviewed;
      return;
    }
  });

  function _bridge(type, payload) {
    return new Promise((resolve, reject) => {
      const id = ++_msgId;
      _pending.set(id, { resolve, reject });
      window.postMessage({ type, _id: id, ...payload }, '*');
      setTimeout(() => {
        if (_pending.has(id)) { _pending.delete(id); reject(new Error('Bridge timeout')); }
      }, 20000);
    });
  }

  const ns = window.__zqlite = {
    // ── State ────────────────────────────────────────────────────────────────
    walletHooked:            false,
    walletPubkey:            null,
    lastOutputMint:          null,
    lastInputMint:           null,
    lastTokenScore:          null,
    lastOrderDetails:        null,
    lastPumpSolAmount:       null,   // SOL amount captured from pump.fun trade API POST body    _jupRpcUrl:              null,  // sniffed from jup.ag’s own RPC calls — CORS-ok from this origin    _scoringReady:           false,
    walletSecurityResult:    null,
    walletSecurityChecking:  false,
    walletReviewedAutoApprove: false,
    recentSwaps:             [],

    // ── Settings (loaded from storage via bridge) ─────────────────────────
    settings: {
      enabled:      true,
      minRiskLevel: 'MEDIUM',   // ALL | MEDIUM | HIGH | CRITICAL
      sites: { jupiter: true, raydium: true, pumpfun: true },
    },

    // ── Methods injected by other modules ─────────────────────────────────
    handleTransaction:        null,
    resolveWalletPubkey:      null,
    runWalletSecurityCheck:   null,
    detectWalletType:         null,

    // ── I/O helpers ───────────────────────────────────────────────────────
    rpcCall(method, params = []) {
      return _bridge('ZQLITE_RPC_CALL', { method, params });
    },
    pageJsonFetch(url, headers) {
      return _bridge('ZQLITE_FETCH', { url, headers: headers || null });
    },
  };

  // Request settings from storage on page load
  window.postMessage({ type: 'ZQLITE_GET_SETTINGS' }, '*');
})();
