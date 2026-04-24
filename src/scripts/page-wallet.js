/**
 * ZendIQ Lite — page-wallet.js
 * Hooks window.solana (legacy) and Wallet Standard wallets.
 * Calls ns.handleTransaction() to apply the risk gate.
 * Resolves wallet pubkey and saves it to storage via bridge.js.
 * Runs in MAIN world.
 */
(function () {
  'use strict';
  const ns = window.__zqlite;
  if (!ns) return;

  function _savePubkey(pubkey) {
    if (!pubkey || pubkey === ns.walletPubkey) return;
    ns.walletPubkey = pubkey;
    window.postMessage({ type: 'ZQLITE_SAVE_PUBKEY', pubkey }, '*');
  }

  // ── Resolve wallet pubkey ─────────────────────────────────────────────────
  ns.resolveWalletPubkey = function () {
    try {
      const pk = window.solana?.publicKey?.toBase58?.()
        ?? window.phantom?.solana?.publicKey?.toBase58?.()
        ?? ns._wsAccount?.address
        ?? null;
      if (pk) _savePubkey(pk);
      return pk ?? ns.walletPubkey ?? null;
    } catch (_) { return ns.walletPubkey ?? null; }
  };

  // ── Legacy wallet hook (window.solana / Phantom adapter) ─────────────────
  function hookLegacyWallet() {
    const wallet = window.solana ?? window.phantom?.solana;
    if (!wallet || ns.walletHooked) return;
    ns.walletHooked = true;
    const _wn = window.solana?.isPhantom  ? 'phantom'
              : window.solana?.isSolflare ? 'solflare'
              : window.solana?.isGlow     ? 'glow'
              : window.solana?.isBrave    ? 'brave'
              : 'unknown';
    ns.walletAdapter = _wn;
    try { window.postMessage({ type: 'ZQLITE_LOG_EVENT', category: 'session', eventType: 'start', data: { type: 'start', wallet: _wn, dex: 'jup.ag' } }, '*'); } catch (_) {}

    const realSign  = wallet.signTransaction?.bind(wallet);
    const realSAS   = wallet.signAndSendTransaction?.bind(wallet);
    const realSend  = wallet.sendTransaction?.bind(wallet);

    if (typeof realSign === 'function') {
      try {
        Object.defineProperty(wallet, 'signTransaction', {
          get() { return (...a) => ns.handleTransaction(a[0], a[1] ?? {}, realSign, 'signTransaction'); },
          configurable: true,
        });
      } catch (_) {}
    }

    if (typeof realSAS === 'function') {
      try {
        Object.defineProperty(wallet, 'signAndSendTransaction', {
          get() { return (...a) => ns.handleTransaction(a[0], a[1] ?? {}, realSAS, 'signAndSendTransaction'); },
          configurable: true,
        });
      } catch (_) {}
    }

    if (typeof realSend === 'function') {
      try { wallet.sendTransaction = (...a) => ns.handleTransaction(a[0], a[1] ?? {}, realSend, 'sendTransaction'); } catch (_) {}
    }

    // Resolve immediately + on connect/accountChanged events (Raydium uses autoConnect
    // which fires 2–8s after page load, well outside the original 400ms/2000ms window).
    const _onConnect = () => {
      setTimeout(ns.resolveWalletPubkey, 50);
      setTimeout(ns.resolveWalletPubkey, 500);
    };
    try { wallet.on?.('connect',        _onConnect); } catch (_) {}
    try { wallet.on?.('accountChanged', _onConnect); } catch (_) {}

    setTimeout(ns.resolveWalletPubkey, 400);
    setTimeout(ns.resolveWalletPubkey, 2000);
    setTimeout(ns.resolveWalletPubkey, 4500);
    setTimeout(ns.resolveWalletPubkey, 9000);
  }

  // ── Wallet Standard hook ──────────────────────────────────────────────────
  function hookWsWallet(w, account) {
    if (!w?.features) return;

    // Use Object.defineProperty + getter to match Pro's approach.
    // Direct property assignment (feat[method] = fn) fails silently when:
    //   a) the property is non-writable, or
    //   b) Jupiter's framework cached the original function reference before the hook ran.
    // A getter is evaluated on every property read, so it can't be bypassed by caching.

    try {
      const feat = w.features['solana:signAndSendTransaction'];
      if (feat?.signAndSendTransaction && !feat.__zqlite_hooked_sast) {
        const origFn = feat.signAndSendTransaction.bind(feat);
        feat.__zqlite_hooked_sast = true;
        Object.defineProperty(feat, 'signAndSendTransaction', {
          get() {
            return (...args) => {
              const callOrig = () => origFn(...args); // preserve all WS args
              return (ns.handleTransaction?.(args[0], {}, callOrig, 'signAndSendTransaction')
                ?? callOrig());
            };
          },
          configurable: true,
        });
      }
    } catch (_) {}

    try {
      const feat = w.features['solana:signTransaction'];
      if (feat?.signTransaction && !feat.__zqlite_hooked_st) {
        const origFn = feat.signTransaction.bind(feat);
        feat.__zqlite_hooked_st = true;
        Object.defineProperty(feat, 'signTransaction', {
          get() {
            return (...args) => {
              const callOrig = () => origFn(...args);
              return (ns.handleTransaction?.(args[0], {}, callOrig, 'signTransaction')
                ?? callOrig());
            };
          },
          configurable: true,
        });
      }
    } catch (_) {}

    if (account?.address) {
      _savePubkey(account.address);
      const _wname = w?.name ?? 'unknown';
      ns.walletAdapter = _wname;
      try { window.postMessage({ type: 'ZQLITE_LOG_EVENT', category: 'session', eventType: 'start', data: { type: 'start', wallet: _wname, dex: 'jup.ag' } }, '*'); } catch (_) {}
    }

    // Subscribe to account changes (wallet connect / switch) for Wallet Standard
    try {
      w.features?.['standard:events']?.on?.('change', ({ accounts }) => {
        const addr = accounts?.[0]?.address;
        if (addr) { _savePubkey(addr); ns._wsAccount = accounts[0]; }
      });
    } catch (_) {}
  }

  // ── Global scan fallback — sweep window.* for any wallet-like objects ────
  function scanAndWrapGlobalWallets() {
    try {
      for (const key of Object.keys(window)) {
        if (!key || key.startsWith('__')) continue;
        let obj;
        try { obj = window[key]; } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        if (!(typeof obj.signTransaction === 'function' || typeof obj.signAndSendTransaction === 'function')) continue;
        if (obj.__zqlite_wrapped) continue;
        obj.__zqlite_wrapped = true;
        try {
          const realSAS = obj.signAndSendTransaction;
          const realST  = obj.signTransaction;
          const realSend = obj.sendTransaction;
          if (typeof realSAS === 'function') {
            Object.defineProperty(obj, 'signAndSendTransaction', {
              get() { return (...a) => ns.handleTransaction(a[0], a[1] ?? {}, realSAS.bind(obj), 'signAndSendTransaction'); },
              configurable: true,
            });
          }
          if (typeof realST === 'function') {
            Object.defineProperty(obj, 'signTransaction', {
              get() { return (...a) => ns.handleTransaction(a[0], a[1] ?? {}, realST.bind(obj), 'signTransaction'); },
              configurable: true,
            });
          }
          if (typeof realSend === 'function') {
            try { obj.sendTransaction = (...a) => ns.handleTransaction(a[0], a[1] ?? {}, realSend.bind(obj), 'sendTransaction'); } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ── Wallet Standard CustomEvent patch ────────────────────────────────────
  try {
    const _Orig = window.CustomEvent;
    function _PatchedCE(type, opts) {
      if (type === 'wallet-standard:app-ready' && typeof opts?.detail?.register === 'function') {
        const origReg = opts.detail.register;
        opts.detail.register = function (wallet) {
          hookWsWallet(wallet, wallet?.accounts?.[0] ?? null);
          if (!ns._wsWallet) { ns._wsWallet = wallet; ns._wsAccount = wallet?.accounts?.[0] ?? null; }
          return origReg(wallet);
        };
      }
      return new _Orig(type, opts);
    }
    _PatchedCE.prototype = _Orig.prototype;
    Object.setPrototypeOf(_PatchedCE, _Orig);
    window.CustomEvent = _PatchedCE;
  } catch (_) {}

  // ── Wallet Standard registry probe (immediate) ───────────────────────────
  function probeWsRegistry() {
    let found = false;
    for (const reg of [window.navigator?.wallets, window.__wallet_standard_wallets__]) {
      if (!reg) continue;
      try {
        const list = typeof reg.get === 'function' ? reg.get() : (Array.isArray(reg) ? reg : []);
        for (const w of list) {
          if (w?.features?.['solana:signTransaction'] || w?.features?.['solana:signAndSendTransaction']) {
            if (!ns._wsWallet) { ns._wsWallet = w; ns._wsAccount = w.accounts?.[0] ?? null; }
            hookWsWallet(w, w.accounts?.[0] ?? null);
            found = true;
          }
        }
      } catch (_) {}
    }
    // Legacy app-ready dispatch
    try {
      const d = [];
      window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register(w) { d.push(w); } } }));
      for (const w of d) {
        if (w?.features?.['solana:signTransaction'] || w?.features?.['solana:signAndSendTransaction']) {
          if (!ns._wsWallet) { ns._wsWallet = w; ns._wsAccount = w.accounts?.[0] ?? null; }
          hookWsWallet(w, w.accounts?.[0] ?? null);
          found = true;
        }
      }
    } catch (_) {}
    return found;
  }

  // ── Subscribe to navigator.wallets registry (catches late-registering wallets) ──
  // Jupiter Wallet (and many modern wallets) register via navigator.wallets.push()
  // AFTER the page JS loads — this subscription catches them whenever they register.
  function _subscribeWsRegistry(attempts) {
    if (attempts === undefined) attempts = 0;
    const reg = window.navigator?.wallets ?? window.__wallet_standard_wallets__;
    if (reg) {
      // Hook any already-registered wallets we may have missed
      try {
        const list = typeof reg.get === 'function' ? reg.get() : (Array.isArray(reg) ? reg : []);
        for (const w of list) {
          if (w?.features?.['solana:signTransaction'] || w?.features?.['solana:signAndSendTransaction']) {
            if (!ns._wsWallet) { ns._wsWallet = w; ns._wsAccount = w.accounts?.[0] ?? null; }
            hookWsWallet(w, w.accounts?.[0] ?? null);
          }
        }
      } catch (_) {}
      // Subscribe to future push() registrations
      try {
        if (typeof reg.on === 'function') {
          reg.on('register', (...wallets) => {
            const list = wallets.flat();
            for (const w of list) {
              if (!w?.features) continue;
              if (!ns._wsWallet) { ns._wsWallet = w; ns._wsAccount = w.accounts?.[0] ?? null; }
              hookWsWallet(w, w.accounts?.[0] ?? null);
            }
          });
        }
      } catch (_) {}
      // Also intercept navigator.wallets.push directly
      try {
        if (typeof reg.push === 'function' && !reg.__zqlite_push_hooked) {
          reg.__zqlite_push_hooked = true;
          const origPush = reg.push.bind(reg);
          reg.push = function (...wallets) {
            for (const w of wallets) {
              if (!w?.features) continue;
              if (!ns._wsWallet) { ns._wsWallet = w; ns._wsAccount = w.accounts?.[0] ?? null; }
              hookWsWallet(w, w.accounts?.[0] ?? null);
            }
            return origPush(...wallets);
          };
        }
      } catch (_) {}
      return;
    }
    if (attempts < 60) setTimeout(() => _subscribeWsRegistry(attempts + 1), 250);
  }

  try {
    window.addEventListener('wallet-standard:register-wallet', (e) => {
      const w = e.detail?.wallet ?? e.wallet;
      if (w?.features?.['solana:signTransaction'] || w?.features?.['solana:signAndSendTransaction']) {
        if (!ns._wsWallet) { ns._wsWallet = w; ns._wsAccount = w.accounts?.[0] ?? null; }
        hookWsWallet(w, w.accounts?.[0] ?? null);
      }
    });
  } catch (_) {}

  // ── Retry loop ────────────────────────────────────────────────────────────
  function tryHook(attempt) {
    if (attempt === undefined) attempt = 0;
    if (window.solana) { hookLegacyWallet(); probeWsRegistry(); scanAndWrapGlobalWallets(); return; }
    if (probeWsRegistry()) { hookLegacyWallet(); scanAndWrapGlobalWallets(); return; }
    if (attempt < 40) setTimeout(() => tryHook(attempt + 1), 250);
    else scanAndWrapGlobalWallets();
  }

  tryHook();

  // Subscribe to navigator.wallets registry — catches Jupiter Wallet and other
  // Wallet Standard wallets that register AFTER document_start via navigator.wallets.push().
  _subscribeWsRegistry();

  // Session end on page unload
  window.addEventListener('beforeunload', () => {
    try { window.postMessage({ type: 'ZQLITE_LOG_EVENT', category: 'session', eventType: 'end', data: { type: 'end', wallet: ns.walletAdapter ?? 'unknown', dex: 'jup.ag' } }, '*'); } catch (_) {}
  });
})();
