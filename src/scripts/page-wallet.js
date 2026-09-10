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
      // Ordered widest-first: window.solana is whichever adapter the DEX is currently
      // driving, so it wins over any specific vendor global that may also be present.
      for (const w of [window.solana, window.phantom?.solana, window.solflare,
                       window.backpack?.solana, window.braveSolana, window.jupiterWallet]) {
        const raw = w?.publicKey;
        if (!raw) continue;
        const str = typeof raw === 'string' ? raw : (raw?.toBase58?.() ?? raw?.toString?.() ?? '');
        if (str.length >= 32) { _savePubkey(str); return str; }
      }
      const pk = ns._wsAccount?.address ?? null;
      if (pk) _savePubkey(pk);
      return pk ?? ns.walletPubkey ?? null;
    } catch (_) { return ns.walletPubkey ?? null; }
  };

  // ── Legacy wallet hook (window.solana / Phantom adapter) ─────────────────
  function hookLegacyWallet() {
    const wallet = window.solana ?? window.phantom?.solana;
    if (!wallet) return;
    // Identity, not a boolean: switching wallet in the DEX replaces the adapter object,
    // and a boolean guard would keep us hooked to the wallet the user just left.
    if (ns.walletHooked && ns._hookedSolanaObj === wallet) return;
    ns.walletHooked     = true;
    ns._hookedSolanaObj = wallet;
    if (wallet.__zqlite_wrapped) return; // already wrapped by an earlier pass or the global sweep
    wallet.__zqlite_wrapped = true;
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
  // Adopt a wallet as the active one. Registry order is not the wallet the DEX is using —
  // with Phantom, Solflare and Jupiter all installed, first-wins picks the wrong one, so a
  // wallet whose account matches window.solana always takes precedence.
  function _adoptWsWallet(w) {
    if (!w) return;
    let pk = null;
    try { pk = window.solana?.publicKey?.toString?.() ?? null; } catch (_) {}
    const matchesActive = pk && w.accounts?.some(a => a?.address === pk);
    if (!ns._wsWallet || matchesActive) {
      ns._wsWallet  = w;
      ns._wsAccount = (pk && w.accounts?.find(a => a?.address === pk)) ?? w.accounts?.[0] ?? null;
    }
  }

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
        if (!accounts) return;
        if (accounts.length > 0) {
          // Connected or switched account — this is now the wallet in use.
          ns._wsWallet  = w;
          ns._wsAccount = accounts[0];
          if (accounts[0]?.address) _savePubkey(accounts[0].address);
        } else if (ns._wsWallet === w) {
          // Disconnected — clear so the next resolve picks up whichever wallet is now active.
          ns._wsWallet  = null;
          ns._wsAccount = null;
        }
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
          _adoptWsWallet(wallet);
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
            _adoptWsWallet(w);
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
          _adoptWsWallet(w);
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
            _adoptWsWallet(w);
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
              _adoptWsWallet(w);
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
              _adoptWsWallet(w);
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
        _adoptWsWallet(w);
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

  // ── Wallet switch watcher ───────────────────────────────────────
  // Switching wallet in the DEX replaces window.solana outright and fires no event we can
  // subscribe to, so the reference has to be polled. Without this the hook stays bound to
  // the wallet the user left and the risk gate silently stops running.
  function watchForWalletSwitch() {
    let last = window.solana;
    setInterval(() => {
      try {
        const cur = window.solana;
        if (!cur || cur === last) return;
        last = cur;
        hookLegacyWallet(); // identity guard lets this through for the new adapter

        const pk = cur?.publicKey?.toString?.();
        if (!pk) return;
        _savePubkey(pk);

        // Re-point the Wallet Standard side at whichever registered wallet owns the new key.
        const reg  = window.navigator?.wallets ?? window.__wallet_standard_wallets__;
        if (!reg) return;
        const list = typeof reg.get === 'function' ? reg.get() : (Array.isArray(reg) ? reg : []);
        const match = list.find(w =>
          (w?.features?.['solana:signAndSendTransaction'] || w?.features?.['solana:signTransaction'])
          && w?.accounts?.some(a => a?.address === pk));
        if (match) {
          ns._wsWallet  = match;
          ns._wsAccount = match.accounts.find(a => a?.address === pk) ?? match.accounts?.[0] ?? null;
          hookWsWallet(match, ns._wsAccount);
        }
      } catch (_) {}
    }, 1000);
  }

  tryHook();

  watchForWalletSwitch();

  // Subscribe to navigator.wallets registry — catches Jupiter Wallet and other
  // Wallet Standard wallets that register AFTER document_start via navigator.wallets.push().
  _subscribeWsRegistry();

  // Session end on page unload
  window.addEventListener('beforeunload', () => {
    try { window.postMessage({ type: 'ZQLITE_LOG_EVENT', category: 'session', eventType: 'end', data: { type: 'end', wallet: ns.walletAdapter ?? 'unknown', dex: 'jup.ag' } }, '*'); } catch (_) {}
  });
})();
