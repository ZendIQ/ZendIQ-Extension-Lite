/**
 * ZendIQ Lite — bridge.js
 * Runs in ISOLATED world. Bridges MAIN world ↔ chrome.storage and background service worker.
 */

window.addEventListener('message', (e) => {
  if (!e.data || typeof e.data !== 'object') return;
  const d = e.data;

  // ── Settings request ───────────────────────────────────────────────────────
  if (d.type === 'ZQLITE_GET_SETTINGS') {
    chrome.storage.local.get(['zqlite_settings'], ({ zqlite_settings: s = {} }) => {
      window.postMessage({
        type: 'ZQLITE_SETTINGS_RESPONSE',
        settings: {
          enabled:      s.enabled      !== false,
          minRiskLevel: s.minRiskLevel ?? 'MEDIUM',
          sites: s.sites ?? { jupiter: true, raydium: true, pumpfun: true },
        },
      }, '*');
    });
    return;
  }

  // ── RPC call → background ──────────────────────────────────────────────────
  if (d.type === 'ZQLITE_RPC_CALL') {
    const { _id, method, params } = d;
    chrome.runtime.sendMessage({ type: 'RPC_CALL', method, params }, (res) => {
      if (chrome.runtime.lastError) return;
      try { window.postMessage({ type: 'ZQLITE_RPC_RESPONSE', _id, result: res }, '*'); } catch (_) {}
    });
    return;
  }

  // ── JSON fetch → background ────────────────────────────────────────────────
  if (d.type === 'ZQLITE_FETCH') {
    const { _id, url, headers } = d;
    chrome.runtime.sendMessage({ type: 'FETCH_JSON', url, headers: headers || null }, (res) => {
      if (chrome.runtime.lastError) return;
      try { window.postMessage({ type: 'ZQLITE_FETCH_RESPONSE', _id, result: res }, '*'); } catch (_) {}
    });
    return;
  }

  // ── History update → chrome.storage ───────────────────────────────────────
  if (d.type === 'ZQLITE_HISTORY_UPDATE') {
    const entry = d.entry;
    if (!entry || typeof entry !== 'object') return;
    chrome.storage.local.get(['zqlite_swap_history'], ({ zqlite_swap_history: hist = [] }) => {
      hist = Array.isArray(hist) ? hist : [];
      hist.unshift(entry);
      if (hist.length > 100) hist = hist.slice(0, 100);
      chrome.storage.local.set({ zqlite_swap_history: hist });
    });
    return;
  }

  // ── History patch — merge signature into most recent entry ────────────────
  if (d.type === 'ZQLITE_HISTORY_PATCH') {
    const sig = d.signature;
    if (typeof sig !== 'string' || sig.length < 40) return;
    chrome.storage.local.get(['zqlite_swap_history'], ({ zqlite_swap_history: hist = [] }) => {
      if (!Array.isArray(hist)) return;
      // Find the matching entry by signature, or fall back to the most recent unsigned entry
      let idx = hist.findIndex(e => e.signature === sig);
      if (idx === -1) idx = hist.findIndex(e => !e.signature);
      if (idx === -1) return;
      let changed = false;
      if (!hist[idx].signature) { hist[idx].signature = sig; changed = true; }
      if (d.quoteAccuracy != null && hist[idx].quoteAccuracy == null) {
        hist[idx].quoteAccuracy = d.quoteAccuracy;
        changed = true;
      }
      if (d.actualOut != null && hist[idx].actualOut == null) {
        hist[idx].actualOut = d.actualOut; changed = true;
      }
      if (d.quotedOut != null && hist[idx].quotedOut == null) {
        hist[idx].quotedOut = d.quotedOut; changed = true;
      }
      if (changed) chrome.storage.local.set({ zqlite_swap_history: hist });
      // If tokenIn symbol is still unknown, kick off an async DexScreener symbol lookup
      if (!hist[idx].tokenIn && hist[idx].inputMint) {
        chrome.runtime.sendMessage(
          { type: 'FETCH_SYMBOL', mint: hist[idx].inputMint, signature: sig },
          () => { void chrome.runtime.lastError; }
        );
      }
    });
    return;
  }

  // ── Accuracy polling request — forwarded to background so it survives page unload ──
  if (d.type === 'ZQLITE_FETCH_ACCURACY') {
    const { signature, outputMint, walletPubkey, quotedRawOut, outputDecimals } = d;
    if (!signature || !outputMint) return;
    chrome.runtime.sendMessage(
      { type: 'FETCH_ACCURACY', signature, outputMint, walletPubkey: walletPubkey ?? null,
        quotedRawOut: quotedRawOut ?? null, outputDecimals: outputDecimals ?? null },
      () => { void chrome.runtime.lastError; }
    );
    return;
  }

  // ── Save wallet pubkey ─────────────────────────────────────────────────────
  if (d.type === 'ZQLITE_SAVE_PUBKEY') {
    if (typeof d.pubkey === 'string' && d.pubkey.length >= 32) {
      chrome.storage.local.set({ zqlite_wallet_pubkey: d.pubkey });
    }
    return;
  }

  // ── Save current token scan (popup Monitor tab reads this) ────────────────
  if (d.type === 'ZQLITE_SAVE_SCAN') {
    if (d.scan && typeof d.scan === 'object') {
      chrome.storage.local.set({ zqlite_current_scan: d.scan });
    }
    return;
  }

  // ── Wallet security result ─────────────────────────────────────────────────
  if (d.type === 'ZQLITE_SAVE_SEC_RESULT') {
    const r = d.result;
    if (r && typeof r === 'object') chrome.storage.local.set({ secLastResult: r });
    return;
  }

  if (d.type === 'ZQLITE_GET_SEC_REVIEWED') {
    const key = `secReviewed_${d.walletType}`;
    chrome.storage.local.get([key], (items) => {
      try { window.postMessage({ type: 'ZQLITE_SEC_REVIEWED_RESPONSE', walletType: d.walletType, reviewed: !!items[key] }, '*'); } catch (_) {}
    });
    return;
  }

  // ── Save settings from page ────────────────────────────────────────────────
  if (d.type === 'ZQLITE_SAVE_SETTINGS') {
    const allowed = { enabled: 'boolean', minRiskLevel: 'string', sites: 'object' };
    const out = {};
    for (const [k, t] of Object.entries(allowed)) {
      if (d.settings?.[k] !== undefined && typeof d.settings[k] === t) out[k] = d.settings[k];
    }
    if (!Object.keys(out).length) return;
    chrome.storage.local.get(['zqlite_settings'], ({ zqlite_settings: s = {} }) => {
      chrome.storage.local.set({ zqlite_settings: { ...s, ...out } });
    });
    return;
  }

  // ── Open popup (called from page when overlay wants to open popup) ———————
  if (d.type === 'ZQLITE_OPEN_POPUP') {
    try { chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }, () => void chrome.runtime.lastError); } catch (_) {}
    return;
  }

  // ── Onboarding: check if first install ────────────────────────────────────
  if (d.type === 'ZQLITE_CHECK_ONBOARDED') {
    chrome.storage.local.get(['zqlite_onboarded'], (r) => {
      try { window.postMessage({ type: 'ZQLITE_ONBOARDED_RESPONSE', onboarded: !!(r ?? {}).zqlite_onboarded }, '*'); } catch (_) {}
    });
    return;
  }

  // ── Onboarding complete: mark done + store pending tab + open popup ────────
  if (d.type === 'ZQLITE_ONBOARDING_COMPLETE') {
    chrome.storage.local.set({ zqlite_onboarded: true, zqlite_pending_tab: 'security' }, () => {
      try { chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }, () => void chrome.runtime.lastError); } catch (_) {}
    });
    return;
  }

  // ── Log event → backend (via background LOG_EVENT handler) —————————————
  if (d.type === 'ZQLITE_LOG_EVENT') {
    const { eventType, data } = d;
    if (!eventType || typeof eventType !== 'string' || eventType.length > 64) return;
    chrome.runtime.sendMessage({
      type: 'LOG_EVENT',
      url: 'https://zendiq-backend.onrender.com/api/events',
      payload: { type: eventType, data: data ?? {}, ts: Date.now(), v: chrome.runtime.getManifest().version, ext_id: chrome.runtime.id },
    }, () => void chrome.runtime.lastError);
    return;
  }
});
// ── Popup → page: live settings push ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ZQLITE_PUSH_SETTINGS' && msg.settings && typeof msg.settings === 'object') {
    try { window.postMessage({ type: 'ZQLITE_SETTINGS_RESPONSE', settings: msg.settings }, '*'); } catch (_) {}
  }
});