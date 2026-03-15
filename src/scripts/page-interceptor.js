/**
 * ZendIQ Lite — page-interceptor.js
 * Runs in MAIN world at document_start.
 *
 * 1. Hooks window.fetch to capture output token mints from DEX API calls
 * 2. Proactively fetches token risk scores in the background
 * 3. ns.handleTransaction() — gates wallet.signTransaction; shows overlay when risk >= threshold
 * 4. Risk overlay — inline DOM overlay (no iframe, no external CSS)
 * 5. Saves scan results and swap history via bridge.js
 */
(function () {
  'use strict';
  const ns = window.__zqlite;
  if (!ns) return;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. FETCH INTERCEPT — capture output mint from DEX API calls
  //    Runs immediately so we hook fetch before jup.ag / raydium JS loads.
  // ══════════════════════════════════════════════════════════════════════════
  // Well-known token decimals (anything not listed defaults to 6 — most SPL meme tokens)
  const _TOKEN_DEC = {
    'So11111111111111111111111111111111111111112':  9, // SOL/WSOL
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 9, // mSOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 9, // jitoSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1':  9, // bSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, // USDT
  };
  const _TOKEN_SYM = {
    'So11111111111111111111111111111111111111112': 'SOL',
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'jitoSOL',
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': 'bSOL',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': '$WIF',
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH',
    '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'WBTC',
  };

  // ── Pump.fun: extract mint from page URL immediately ──────────────────────
  // pump.fun/coin/<MINT_ADDRESS> pages have the token address in the path.
  // Capturing it here (before any API calls) lets proactive scoring start
  // as soon as the user opens the page — ~2–4s head-start before they click Buy.
  if (location.hostname.includes('pump.fun')) {
    const _pumpCoinMatch = location.pathname.match(/\/coin\/([1-9A-HJ-NP-Za-km-z]{32,50})/);
    if (_pumpCoinMatch) {
      ns.lastOutputMint = _pumpCoinMatch[1];
      // _probeScore is a function declaration — hoisted and safe to call here.
      // _ensureScoring() inside it initialises the scoring module lazily.
      Promise.resolve().then(() => _probeScore(_pumpCoinMatch[1]));
    }
  }

  // ── Raydium: extract mint from page URL immediately ───────────────────────
  // raydium.io/swap/?inputMint=sol&outputMint=<MINT> encodes both mints in the
  // query string.  Reading it here gives a ~1–3s head-start for proactive scoring
  // before the user can click Swap.  Raydium is a SPA — we also intercept
  // pushState/replaceState/popstate so pair changes are captured live.
  if (location.hostname.includes('raydium.io')) {
    const _SOL_MINT = 'So11111111111111111111111111111111111111112';
    const _rdmExtract = () => {
      try {
        const p  = new URLSearchParams(location.search);
        const raw = p.get('outputMint') ?? p.get('quoteMint') ?? p.get('mintB');
        if (!raw) return;
        const mint = raw.toLowerCase() === 'sol' ? _SOL_MINT : raw;
        if (!mint || mint === ns.lastOutputMint) return;
        ns.lastOutputMint = mint;
        Promise.resolve().then(() => _probeScore(mint));
      } catch (_) {}
    };
    _rdmExtract(); // fire immediately on page load
    // Patch history methods so SPA navigation (pair change) re-extracts the mint.
    (['pushState', 'replaceState']).forEach(m => {
      const _orig = history[m].bind(history);
      history[m] = function (...args) {
        const res = _orig(...args);
        _rdmExtract();
        return res;
      };
    });
    window.addEventListener('popstate', _rdmExtract, { passive: true });
  }

  const _origFetch = window.fetch.bind(window);
  window.fetch = function (resource, opts) {
    const url = resource instanceof Request ? resource.url : String(resource ?? '');
    const resp = _origFetch(resource, opts);
    try {
      // Sniff jup.ag’s own Solana RPC endpoint — it supports CORS from this domain
      // so we can reuse it for getTransaction without going through the bridge.
      if (!ns._jupRpcUrl && url && typeof url === 'string'
          && (opts?.method ?? 'GET').toUpperCase() === 'POST' && opts?.body
          && !url.includes('jup.ag') && !url.includes('pump.fun') && !url.includes('raydium.io')) {
        try {
          const b = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
          if (b?.jsonrpc === '2.0' && b?.method) ns._jupRpcUrl = url;
        } catch (_) {}
      }
      // Jupiter Ultra /order or /quote
      if (/jup\.ag.*\/(order|quote)\b/.test(url)) {
        const u = new URL(url, location.origin);
        const out = u.searchParams.get('outputMint');
        const inp = u.searchParams.get('inputMint');
        if (out) { ns.lastOutputMint = out; ns.lastInputMint = inp ?? null; _probeScore(out); }
        // Tap response to capture swap amounts for history cards
        resp.then(r => r.clone().json().then(d => {
          if (d && (d.inAmount != null || d.outAmount != null)) {
            ns.lastOrderDetails = {
              inAmount:   d.inAmount  != null ? String(d.inAmount)  : null,
              outAmount:  d.outAmount != null ? String(d.outAmount) : null,
              inUsdValue:  d.inUsdValue  ?? null,
              outUsdValue: d.outUsdValue ?? null,
              swapType:    d.swapType   ?? null,
              inputMint:   d.inputMint  ?? inp ?? null,
              outputMint:  d.outputMint ?? out ?? null,
            };
          }
        }).catch(() => {})).catch(() => {});
      }
      // Raydium compute / swap / quote API
      // Catches api-v3.raydium.io, transaction.raydium.io, etc.
      // Path patterns: /main/route-compute, /swap, /batch-compute, /quote …
      // Also catches any URL with a mint query param regardless of path shape.
      if (/raydium\.io/.test(url) && (
        /\/(compute|swap|quote|route|order|batch)/.test(url)
        || /[?&](inputMint|outputMint|mintA|mintB|quoteMint|baseMint)=/.test(url)
      )) {
        const u = new URL(url, location.origin);
        const out = u.searchParams.get('outputMint') ?? u.searchParams.get('quoteMint') ?? u.searchParams.get('mintB');
        if (out) { ns.lastOutputMint = out; _probeScore(out); }
        // For POST requests, also parse request body for mints
        if (!out && (opts?.method ?? 'GET').toUpperCase() === 'POST' && opts?.body) {
          try {
            const _rb = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
            const _bodyMint = _rb?.outputMint ?? _rb?.quoteMint ?? _rb?.mintB ?? null;
            if (_bodyMint) { ns.lastOutputMint = _bodyMint; _probeScore(_bodyMint); }
          } catch (_) {}
        }
        // Also check response body for mints + amounts (fetch-based callers)
        resp.then(r => r.clone().json().then(d => { _tapRaydiumResponse(url, d); }).catch(() => {})).catch(() => {});
      }
      // Pump.fun — mint is typically a path segment in trade/buy URLs
      if (/pump\.fun/.test(url) && /\/(trade|buy|swap)/.test(url)) {
        const segs = new URL(url, location.origin).pathname.split('/')
          .filter(p => p.length >= 32 && p.length <= 50 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(p));
        if (segs[0] && segs[0] !== ns.lastOutputMint) { ns.lastOutputMint = segs[0]; _probeScore(segs[0]); }
        // Capture the SOL amount from the POST body so we can report trade_sol in event payloads.
        // pump.fun sends { amount: 0.5, denominatedInSol: "true" } or { amount: 500, denominatedInSol: "false" }
        // (false case = token quantity — we can't trivially convert that to SOL, so we skip it)
        if ((opts?.method ?? 'GET').toUpperCase() === 'POST' && opts?.body) {
          try {
            const _b = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
            if (_b && typeof _b.amount === 'number' && _b.amount > 0) {
              const _inSol = _b.denominatedInSol == null
                || _b.denominatedInSol === true
                || String(_b.denominatedInSol).toLowerCase() === 'true';
              if (_inSol) ns.lastPumpSolAmount = _b.amount;
            }
          } catch (_) {}
        }
      }

      // ── Capture transaction signature from execute / RPC response ──────────
      // Jupiter Ultra /execute — response: { signature: '<base58>', status: 'Success' }
      if (/\/execute($|\?)/.test(url) && (opts?.method ?? 'GET').toUpperCase() === 'POST') {
        resp.then(r => r.clone().json().then(data => {
          const sig = data?.signature ?? null;
          if (sig && typeof sig === 'string' && sig.length >= 40
              && data?.status !== 'Failed' && !data?.error) {
            window.postMessage({ type: 'ZQLITE_HISTORY_PATCH', signature: sig }, '*');
            // Capture state NOW (before async polling starts)
            const od = ns.lastOrderDetails;
            _fetchAccuracy(
              sig,
              od?.outputMint ?? ns.lastOutputMint ?? null,
              typeof ns.resolveWalletPubkey === 'function' ? ns.resolveWalletPubkey() : null,
              od?.outAmount != null ? Number(od.outAmount) : null,
              od?.outputMint ? (_TOKEN_DEC[od.outputMint] ?? 6) : 6
            );
          }
        }).catch(() => {})).catch(() => {});
      }
      // Solana RPC sendTransaction (Raydium, Pump.fun, etc.) — response: { result: '<base58>' }
      if ((opts?.method ?? 'GET').toUpperCase() === 'POST' && opts?.body) {
        try {
          const b = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
          if (b?.method === 'sendTransaction' || b?.method === 'send_raw_transaction') {
            resp.then(r => r.clone().json().then(data => {
              const sig = data?.result ?? null;
              if (sig && typeof sig === 'string' && sig.length >= 40) {
                window.postMessage({ type: 'ZQLITE_HISTORY_PATCH', signature: sig }, '*');
                // Capture state NOW (before async polling starts)
                const od = ns.lastOrderDetails;
                // Guard: only use stored quote amounts when the mint matches the current swap
                // (prevents stale Jupiter data from bleeding into a Raydium/pump.fun tx)
                const _rdmMint  = od?.outputMint ?? ns.lastOutputMint ?? null;
                const _mintOk   = od?.outputMint != null && od.outputMint === (ns.lastOutputMint ?? od.outputMint);
                const _quotedOut = _mintOk && od?.outAmount != null ? Number(od.outAmount) : null;
                _fetchAccuracy(
                  sig,
                  _rdmMint,
                  typeof ns.resolveWalletPubkey === 'function' ? ns.resolveWalletPubkey() : null,
                  _quotedOut,
                  _rdmMint ? (_TOKEN_DEC[_rdmMint] ?? 6) : 6
                );
              }
            }).catch(() => {})).catch(() => {});
          }
        } catch (_) {}
      }
    } catch (_) {}
    // Attach a silent no-op catch so the browser doesn't flag a brief
    // "unhandled rejection" window before the original caller's .catch() runs.
    // We still return the original `resp` so callers receive the real rejection.
    resp.catch(() => {});
    return resp;
  };

  // ── Shared: parse a Raydium compute/swap JSON response and update ns state ─
  // Called from both window.fetch override (above) and the XHR hook (below)
  // because Raydium's React bundle uses XHR for swap-base-in, not fetch.
  function _tapRaydiumResponse(url, d) {
    if (!/raydium\.io/.test(url)) return;
    if (!/\/(compute|swap|quote|route|order|batch)/.test(url)
        && !/[?&](inputMint|outputMint|mintA|mintB|quoteMint|baseMint)=/.test(url)) return;
    const _SOL_MINT = 'So11111111111111111111111111111111111111112';
    const _normMint = v => (v && v.toLowerCase() === 'sol') ? _SOL_MINT : (v ?? null);
    const m = _normMint(d?.data?.outputMint ?? d?.outputMint ?? d?.data?.quoteMint ?? d?.data?.mintB);
    if (m && m !== ns.lastOutputMint) { ns.lastOutputMint = m; _probeScore(m); }
    const rawOut = d?.data?.outputAmount ?? d?.data?.amountOut ?? d?.data?.outAmount
                   ?? d?.outputAmount ?? d?.amountOut ?? null;
    const rawIn  = d?.data?.inputAmount  ?? d?.data?.amountIn  ?? d?.data?.inAmount
                   ?? d?.inputAmount  ?? d?.amountIn  ?? null;
    const outMint = m ?? ns.lastOutputMint ?? null;
    if (rawOut != null && outMint) {
      ns.lastOrderDetails = {
        outAmount:   String(rawOut),
        inAmount:    rawIn != null ? String(rawIn) : null,
        outputMint:  outMint,
        inputMint:   _normMint(d?.data?.inputMint ?? d?.inputMint ?? ns.lastInputMint),
        inUsdValue:  null,
        outUsdValue: null,
        swapType:    d?.data?.swapType ?? null,
      };
    }
  }

  // ── XHR interception — Raydium uses XMLHttpRequest for swap-base-in ───────
  // window.fetch only intercepts fetch() calls; Raydium's React bundle makes its
  // route-compute calls via XHR (visible as type:xhr in DevTools Network tab).
  (function () {
    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__zq_url = String(url ?? ''); } catch (_) {}
      return _xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const _xurl = this.__zq_url ?? '';
      if (/raydium\.io/.test(_xurl)) {
        this.addEventListener('load', function () {
          try { _tapRaydiumResponse(_xurl, JSON.parse(this.responseText)); } catch (_) {}
        }, { passive: true });
      }
      return _xhrSend.apply(this, arguments);
    };
  })();

  // ══════════════════════════════════════════════════════════════════════════
  // 1b. POST-CONFIRM ACCURACY FETCH
  // walletPubkey is resolved lazily inside the loop — the wallet hook fires at ~400ms/2s
  // after page load so the hint captured at call time may be null. Don't bail early.
  // ══════════════════════════════════════════════════════════════════════════
  function _fetchAccuracy(signature, outputMint, walletPubkeyHint, quotedRawOut, outputDecimals) {
    if (!signature || !outputMint) return;
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const isSOL = outputMint === SOL_MINT;


    (async () => {
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          // Re-resolve on every attempt — wallet pubkey becomes available asynchronously
          const walletPubkey = walletPubkeyHint
            ?? (typeof ns.resolveWalletPubkey === 'function' ? ns.resolveWalletPubkey() : null)
            ?? ns.walletPubkey ?? null;
          if (!walletPubkey) continue; // wallet not yet initialized — retry

          const res = await ns.rpcCall('getTransaction', [
            signature,
            { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
          ]);
          const tx = res?.result;
          if (!tx?.meta) continue; // not confirmed yet — retry

          const meta = tx.meta;
          let actualOut = null;

          // Parse token amount robustly: uiAmount is deprecated and may be null
          // on some RPC providers; prefer uiAmountString, then raw amount/decimals.
          const _parseAmt = (e) => {
            const t = e?.uiTokenAmount;
            if (!t) return 0;
            if (t.uiAmountString != null && t.uiAmountString !== '') return parseFloat(t.uiAmountString) || 0;
            if (t.uiAmount       != null) return t.uiAmount;
            if (t.amount != null && t.decimals != null) return Number(t.amount) / Math.pow(10, t.decimals);
            return 0;
          };

          if (isSOL) {
            // Find wallet's index in the account-key list
            const msg  = tx.transaction?.message ?? {};
            const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
            const idx  = keys.findIndex(k => (typeof k === 'string' ? k : k.pubkey) === walletPubkey);
            if (idx >= 0) {
              // Add fee back: wallet paid fee from balance, we want received SOL not net change
              const receivedLamports = (meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0) + (meta.fee ?? 0);
              if (receivedLamports > 0) actualOut = receivedLamports / 1e9;
            }
          } else {
            // SPL token — match by mint + owner in token balance snapshots
            const post = meta.postTokenBalances ?? [];
            const pre  = meta.preTokenBalances  ?? [];

            // Primary: owner field match (present on most RPCs)
            let postEntry = post.find(e => e.mint === outputMint && e.owner === walletPubkey);
            let preEntry  = pre.find( e => e.mint === outputMint && e.owner === walletPubkey);

            // Fallback: owner field absent or mismatched — take the output-mint entry
            // with the largest positive delta (DEX pool accounts show negative diffs).
            if (!postEntry) {
              const candidates = post.filter(e => e.mint === outputMint);
              let bestDiff = 0;
              for (const pe of candidates) {
                const _pre = pre.find(e => e.mint === outputMint && e.accountIndex === pe.accountIndex);
                const diff = _parseAmt(pe) - _parseAmt(_pre);
                if (diff > bestDiff) { bestDiff = diff; postEntry = pe; preEntry = _pre; }
              }
            }

            if (postEntry) {
              const diff = _parseAmt(postEntry) - _parseAmt(preEntry);
              if (diff > 0) actualOut = diff;
            }
          }

          if (actualOut == null) {
            // Tx confirmed but balance lookup failed — could be a transient RPC
            // issue or an ALT-only account not yet resolved. Retry up to 3 times
            // with increasing delay before giving up.
            if (attempt < 3) continue;
            window.postMessage({ type: 'ZQLITE_HISTORY_PATCH', signature, quoteAccuracy: -1 }, '*');
            return;
          }

          // Quote accuracy: actual received vs quoted amount
          let quoteAccuracy = null;
          if (quotedRawOut != null && quotedRawOut > 0 && outputDecimals != null) {
            const quotedOut = Number(quotedRawOut) / Math.pow(10, outputDecimals);
            if (quotedOut > 0) quoteAccuracy = Math.min(100, (actualOut / quotedOut) * 100);
          }

          window.postMessage({ type: 'ZQLITE_HISTORY_PATCH', signature, quoteAccuracy: quoteAccuracy ?? -1 }, '*');
          return;
        } catch (_) { /* retry */ }
      }
      // All retries exhausted
      window.postMessage({ type: 'ZQLITE_HISTORY_PATCH', signature, quoteAccuracy: -1 }, '*');
    })();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. PROACTIVE SCORE FETCH
  // ══════════════════════════════════════════════════════════════════════════
  let _probedMint = null;
  // Track the in-flight tokenScore promise per mint so the click/sign handlers
  // can reuse it rather than starting a competing new fetch.
  const _scoreInFlight = new Map(); // mint → Promise<fullResult>
  const _baseInFlight  = new Map(); // mint → Promise<partialResult> (resolves after 5 APIs, before deployer)

  function _probeScore(mint) {
    if (!mint || mint === _probedMint) return;
    _probedMint = mint;
    _ensureScoring();
    if (typeof fetchTokenScore !== 'function') return;
    let _resolveBase;
    const baseP = new Promise(res => { _resolveBase = res; });
    _baseInFlight.set(mint, baseP);
    const p = fetchTokenScore(mint, undefined, { onBase: _resolveBase }).then(result => {
      ns.lastTokenScore = result;
      _scoreInFlight.delete(mint);
      _baseInFlight.delete(mint);
      _resolveBase(result); // fallback — ensures baseP resolves even if onBase wasn't called
      if (result) {
        window.postMessage({ type: 'ZQLITE_SAVE_SCAN', scan: { mint, result, ts: Date.now(), site: location.hostname } }, '*');
        window.postMessage({ type: 'ZQLITE_LOG_EVENT', eventType: 'token_checked', data: { mint, score: result.score, level: result.level, site: location.hostname } }, '*');
        // high_risk_detected — score >= 50 (HIGH threshold)
        if (result.score >= 50) {
          window.postMessage({ type: 'ZQLITE_LOG_EVENT', eventType: 'high_risk_detected', data: { mint, score: result.score, level: result.level, site: location.hostname } }, '*');
        }
      }
      return result;
    }).catch(() => {
      _scoreInFlight.delete(mint);
      _baseInFlight.delete(mint);
      _resolveBase(null);
      return null;
    });
    _scoreInFlight.set(mint, p);
  }

  function _ensureScoring() {
    if (ns._scoringReady) return;
    if (typeof initScoring === 'function') {
      initScoring({ rpcCall: ns.rpcCall, jsonFetch: ns.pageJsonFetch });
      ns._scoringReady = true;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 3. TRANSACTION GATE
  // ══════════════════════════════════════════════════════════════════════════
  const SCORE_THRESHOLD = { ALL: 0, MEDIUM: 25, HIGH: 50, CRITICAL: 75 };

  // ── PRIMARY INTERCEPT: Swap button click (capture phase) ─────────────────
  // Fires synchronously BEFORE React's handler — stopImmediatePropagation()
  // prevents React from ever seeing the click. After the user confirms in the
  // overlay we re-fire btn.click() with the bypass flag set so it passes through.
  window.__zqlite_swap_bypass = false;
  document.addEventListener('click', async (e) => {
    if (window.__zqlite_swap_bypass) return;
    const btn = e.target?.closest?.('button, [role="button"]');
    if (!btn) return;
    const txt = (btn.textContent ?? '').trim().replace(/\s+/g, ' ');
    // Jupiter / Raydium: "Swap", "Confirm Swap", "Swap Now", "Confirm Swap"
    const _isSwapBtn = /^(confirm\s+)?(swap|swap now|swap confirm)$/i.test(txt)
      || (location.hostname.includes('raydium') && /^(swap|confirm)/i.test(txt) && txt.length <= 20);
    // Pump.fun: "Buy [TokenName]" or "Place Trade" — only when a mint is known.
    // Requires a token name after "Buy" so the Buy/Sell toggle tab (bare "Buy") doesn't trigger.
    const _isPumpBuy = location.hostname.includes('pump.fun')
      && !!ns.lastOutputMint
      && /^(buy\s+\S.*|place\s+trade)$/i.test(txt)
      && txt.length <= 40;
    if (!_isSwapBtn && !_isPumpBuy) return;

    e.stopImmediatePropagation();
    e.preventDefault();

    const mint = ns.lastOutputMint;
    // Validate cached score — reject results with unrecognised level or no factors
    // (can happen after extension reload mid-session; forces a fresh fetch via overlay)
    const _KNOWN_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
    const _cachedOk = mint && ns.lastTokenScore?.mint === mint
      && ns.lastTokenScore?.loaded
      && _KNOWN_LEVELS.has(ns.lastTokenScore?.level)
      && (ns.lastTokenScore?.factors?.length ?? 0) > 0;
    const score = _cachedOk ? ns.lastTokenScore : null;

    // If score not yet cached: reuse the proactive in-flight promise if available,
    // otherwise start a fresh fetch. An 18s safety timeout prevents the overlay
    // hanging if all bridge calls fail.
    let _scorePromise = null;
    let _fullPromise  = null;
    if (!score && mint) {
      _ensureScoring();
      if (_baseInFlight.has(mint)) {
        // Two-phase: partial factors appear fast (~1s), deployer row added when full result arrives
        _scorePromise = Promise.race([_baseInFlight.get(mint),  new Promise(r => setTimeout(() => r(null), 8000))]);
        _fullPromise  = Promise.race([_scoreInFlight.get(mint), new Promise(r => setTimeout(() => r(null), 18000))]);
      } else if (_scoreInFlight.has(mint)) {
        // Already past base phase — reuse full promise directly
        _scorePromise = Promise.race([
          _scoreInFlight.get(mint),
          new Promise(r => setTimeout(() => r(null), 18000)),
        ]);
      } else if (typeof fetchTokenScore === 'function') {
        _scorePromise = Promise.race([
          fetchTokenScore(mint).then(r => {
            if (r) {
              ns.lastTokenScore = r;
              window.postMessage({ type: 'ZQLITE_SAVE_SCAN', scan: { mint, result: r, ts: Date.now(), site: location.hostname } }, '*');
            }
            return r ?? null;
          }).catch(() => null),
          new Promise(r => setTimeout(() => r(null), 18000)),
        ]);
      }
    } else if (mint) {
      // Score exists — start a silent background refresh so the overlay can update
      // if the cached result is shown but a newer score arrives (e.g. stale data).
      _ensureScoring();
      if (typeof fetchTokenScore === 'function' && !_scoreInFlight.has(mint)) {
        _scorePromise = Promise.race([
          fetchTokenScore(mint).then(r => {
            if (r) { ns.lastTokenScore = r; window.postMessage({ type: 'ZQLITE_SAVE_SCAN', scan: { mint, result: r, ts: Date.now(), site: location.hostname } }, '*'); }
            return r ?? null;
          }).catch(() => null),
          new Promise(r => setTimeout(() => r(null), 14000)),
        ]);
      }
    }

    const threshold = SCORE_THRESHOLD[ns.settings.minRiskLevel ?? 'MEDIUM'] ?? 25;
    const isRisky   = score != null && score.score >= threshold;

    window.postMessage({ type: 'ZQLITE_LOG_EVENT', eventType: 'transaction_initiated', data: { mint, score: score?.score ?? null, level: score?.level ?? null, site: location.hostname, path: 'click' } }, '*');

    let decision;
    try {
      decision = await _showOverlay(score, _scorePromise, _fullPromise);
    } catch (_) {
      decision = 'proceed'; // fail open
    }

    const _finalScore = (mint && ns.lastTokenScore?.mint === mint) ? ns.lastTokenScore : score;
    _addToHistory({ ts: Date.now(), mint, symbol: _finalScore?.symbol ?? null, score: _finalScore?.score ?? null, level: _finalScore?.level ?? null, decision, site: location.hostname });

    const _od = ns.lastOrderDetails;
    const _tradeUsd = _od?.inUsdValue ?? null;

    // For pump.fun buys: the fetch intercept fires AFTER we re-fire the click, so it can't
    // populate ns.lastPumpSolAmount in time for this event.  Instead, read the SOL amount
    // directly from the visible input field while we still have access to the clicked button.
    if (_isPumpBuy && _tradeUsd == null) {
      let _c = btn.parentElement;
      for (let _i = 0; _i < 8 && _c; _i++, _c = _c.parentElement) {
        const _inp = _c.querySelector('input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"]');
        if (_inp && _inp.value) {
          const _v = parseFloat(_inp.value);
          if (_v > 0 && _v < 10000) { ns.lastPumpSolAmount = _v; break; }
        }
      }
    }
    const _tradeSol = _tradeUsd == null ? (ns.lastPumpSolAmount ?? null) : null;

    const _isHighRisk = (_finalScore?.score ?? 0) >= 50;
    const _evtName = decision === 'cancel'
      ? (_isHighRisk ? 'avoided_high_risk' : 'transaction_aborted')
      : (_isHighRisk ? 'proceeded_high_risk' : 'transaction_completed');
    window.postMessage({ type: 'ZQLITE_LOG_EVENT', eventType: _evtName, data: { mint, score: _finalScore?.score ?? null, level: _finalScore?.level ?? null, trade_usd: _tradeUsd, trade_sol: _tradeSol, site: location.hostname } }, '*');

    if (decision === 'cancel') return; // do nothing — swap never continues

    // User confirmed — re-fire the click bypassing our interceptor
    window.__zqlite_swap_bypass = true;
    try { btn.click(); } finally { window.__zqlite_swap_bypass = false; }
  }, { capture: true });

  // ── SECONDARY GATE: wallet.signTransaction hook ───────────────────────────
  // Fallback for any signing path not caught by the click interceptor above.

  ns.handleTransaction = async function (tx, opts, originalFn, _method) {
    if (!ns.settings.enabled) return originalFn(tx, opts);

    // Site-level toggle check — only bypass, never skip the overlay for enabled sites
    const host = location.hostname;
    if (host.includes('jup.ag')   && !ns.settings.sites.jupiter) return originalFn(tx, opts);
    if (host.includes('raydium')  && !ns.settings.sites.raydium)  return originalFn(tx, opts);
    if (host.includes('pump.fun') && !ns.settings.sites.pumpfun)  return originalFn(tx, opts);

    const mint = ns.lastOutputMint;

    // Validate cached score — reject stale results with unknown level or empty factors.
    const _KL2 = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
    const _cachedOk2 = mint && ns.lastTokenScore?.mint === mint
      && ns.lastTokenScore?.loaded
      && _KL2.has(ns.lastTokenScore?.level)
      && (ns.lastTokenScore?.factors?.length ?? 0) > 0;
    const score = _cachedOk2 ? ns.lastTokenScore : null;

    // If score not yet cached: reuse the proactive in-flight promise if available,
    // otherwise start a fresh fetch. 18s safety timeout.
    let _scorePromise = null;
    let _fullPromise  = null;
    if (!score && mint) {
      _ensureScoring();
      if (_baseInFlight.has(mint)) {
        // Two-phase: partial factors appear fast (~1s), deployer row added when full result arrives
        _scorePromise = Promise.race([_baseInFlight.get(mint),  new Promise(r => setTimeout(() => r(null), 8000))]);
        _fullPromise  = Promise.race([_scoreInFlight.get(mint), new Promise(r => setTimeout(() => r(null), 18000))]);
      } else if (_scoreInFlight.has(mint)) {
        _scorePromise = Promise.race([
          _scoreInFlight.get(mint),
          new Promise(r => setTimeout(() => r(null), 18000)),
        ]);
      } else if (typeof fetchTokenScore === 'function') {
        _scorePromise = Promise.race([
          fetchTokenScore(mint).then(r => {
            if (r) {
              ns.lastTokenScore = r;
              window.postMessage({ type: 'ZQLITE_SAVE_SCAN', scan: { mint, result: r, ts: Date.now(), site: host } }, '*');
            }
            return r ?? null;
          }).catch(() => null),
          new Promise(r => setTimeout(() => r(null), 18000)),
        ]);
      }
    } else if (mint) {
      // Score exists — start a silent background refresh so the overlay can update
      // if stale data or a newer score arrives.
      _ensureScoring();
      if (typeof fetchTokenScore === 'function' && !_scoreInFlight.has(mint)) {
        _scorePromise = Promise.race([
          fetchTokenScore(mint).then(r => {
            if (r) {
              ns.lastTokenScore = r;
              window.postMessage({ type: 'ZQLITE_SAVE_SCAN', scan: { mint, result: r, ts: Date.now(), site: host } }, '*');
            }
            return r ?? null;
          }).catch(() => null),
          new Promise(r => setTimeout(() => r(null), 14000)),
        ]);
      }
    }

    const threshold = SCORE_THRESHOLD[ns.settings.minRiskLevel ?? 'MEDIUM'] ?? 25;
    const isRisky   = score != null && score.score >= threshold;

    window.postMessage({ type: 'ZQLITE_LOG_EVENT', eventType: 'transaction_initiated', data: { mint, score: score?.score ?? null, level: score?.level ?? null, site: host, path: 'wallet' } }, '*');

    // Overlay always requires manual confirmation — no auto-proceed.
    const decision = await _showOverlay(score, _scorePromise, _fullPromise);

    const _finalScore = (mint && ns.lastTokenScore?.mint === mint) ? ns.lastTokenScore : score;
    _addToHistory({
      ts: Date.now(), mint, symbol: _finalScore?.symbol ?? null,
      score: _finalScore?.score ?? null, level: _finalScore?.level ?? null, decision, site: host,
    });

    const _od2 = ns.lastOrderDetails;
    const _tradeUsd2 = _od2?.inUsdValue ?? null;
    // On the wallet-hook path the fetch intercept fires before wallet.signTransaction,
    // so ns.lastPumpSolAmount is already populated from the pump.fun API POST body.
    const _tradeSol2 = _tradeUsd2 == null ? (ns.lastPumpSolAmount ?? null) : null;
    const _isHighRisk2 = (_finalScore?.score ?? 0) >= 50;
    const _evtName2 = decision === 'cancel'
      ? (_isHighRisk2 ? 'avoided_high_risk' : 'transaction_aborted')
      : (_isHighRisk2 ? 'proceeded_high_risk' : 'transaction_completed');
    window.postMessage({ type: 'ZQLITE_LOG_EVENT', eventType: _evtName2, data: { mint, score: _finalScore?.score ?? null, level: _finalScore?.level ?? null, trade_usd: _tradeUsd2, trade_sol: _tradeSol2, site: host } }, '*');

    if (decision === 'cancel') throw new Error('ZendIQ Lite: swap cancelled by user (token risk)');
    return originalFn(tx, opts);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 4. OVERLAY
  // ══════════════════════════════════════════════════════════════════════════
  const LEVEL_COLOR = {
    LOW:      '#14F195',
    MEDIUM:   '#FFB547',
    HIGH:     '#FF6B00',
    CRITICAL: '#FF4444',
  };
  const LEVEL_LABEL = {
    LOW: 'Low Risk', MEDIUM: 'Moderate Risk', HIGH: 'High Risk', CRITICAL: 'Critical Risk',
  };
  const SEV_COLOR = { LOW: '#14F195', MEDIUM: '#FFB547', HIGH: '#FF6B00', CRITICAL: '#FF4444' };

  const _CSS = `
#__zqlite_bd{position:fixed;inset:0;background:rgba(0,0,0,.78);backdrop-filter:blur(5px);
  z-index:2147483646;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;animation:__zq_fade .18s ease}
@keyframes __zq_fade{from{opacity:0}to{opacity:1}}
.__zq_card{background:#0F0F1B;border:1px solid rgba(255,255,255,.12);border-radius:16px;
  width:420px;max-width:calc(100vw - 24px);max-height:92vh;display:flex;flex-direction:column;
  box-shadow:0 28px 60px rgba(0,0,0,.92)}
.__zq_hd{display:flex;align-items:center;gap:10px;padding:15px 18px 13px;
  border-bottom:1px solid rgba(255,255,255,.07);flex-shrink:0}
.__zq_ht{flex:1;font-size:13px;font-weight:700;color:#E8E8F0;letter-spacing:.15px}
.__zq_body{padding:14px 18px 8px;flex:1;overflow-y:auto;
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent}
.__zq_body::-webkit-scrollbar{width:4px}
.__zq_body::-webkit-scrollbar-track{background:transparent}
.__zq_body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:4px}
.__zq_sr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.__zq_sn{font-size:44px;font-weight:900;font-family:'Space Mono',monospace;line-height:1}
.__zq_sp{padding:5px 12px;border-radius:20px;font-size:11px;font-weight:700;
  background:rgba(255,255,255,.06);border:1px solid transparent}
.__zq_fl{display:flex;flex-direction:column;gap:4px}
.__zq_fi{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;
  background:rgba(255,255,255,.03);font-size:10.5px;color:#E8E8F0;
  cursor:help;transition:background .12s}.__zq_fi:hover{background:rgba(255,255,255,.07)}
.__zq_ai{display:flex;gap:10px;padding:12px 18px 11px;border-top:1px solid rgba(255,255,255,.07);flex-shrink:0}
.__zq_btn{flex:1;padding:11px 14px;border-radius:10px;border:none;font-size:12px;font-weight:700;
  cursor:pointer;transition:filter .15s;white-space:nowrap}.__zq_btn:hover{filter:brightness(1.15)}
.__zq_cancel{background:rgba(255,255,255,.08);color:#E8E8F0}
.__zq_proceed{background:#14F195;color:#0F0F1B}.__zq_proceed.amber{background:#FFB547;color:#0F0F1B}.__zq_proceed.orange{background:#FF6B00;color:#fff}.__zq_proceed.red{background:#FF4444;color:#fff}
.__zq_proceed.__zq_pld{background:rgba(153,69,255,.25);color:#E8E8F0;cursor:pointer;position:relative;overflow:hidden;border:1px solid rgba(153,69,255,.5)}
.__zq_proceed.__zq_pld::after{content:'';position:absolute;top:0;left:-100%;width:55%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(153,69,255,.25),transparent);
  animation:__zq_shimmer 1.5s ease-in-out infinite}
@keyframes __zq_shimmer{to{left:160%}}
.__zq_nt{text-align:center;font-size:9.5px;color:#3A3A5A;padding:0 18px 12px}
.__zq_prog{height:2px;background:rgba(255,255,255,.04);flex-shrink:0}
.__zq_prog_bar{height:100%;background:linear-gradient(90deg,#9945FF,#14F195);animation:__zq_pb 1.8s ease-in-out infinite alternate}
@keyframes __zq_pb{from{width:10%;margin-left:0}to{width:55%;margin-left:35%}}
.__zq_ld{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;
  background:rgba(153,69,255,.08);border:1px solid rgba(153,69,255,.2);font-size:10.5px;color:#B8A8E0}
.__zq_ld_sub{font-size:9.5px;color:#6B5A8A;margin-top:2px}
.__zq_spin{width:14px;height:14px;border:2px solid rgba(153,69,255,.2);
  border-top-color:#9945FF;border-radius:50%;animation:__zq_spin .75s linear infinite;flex-shrink:0}
@keyframes __zq_spin{to{transform:rotate(360deg)}}
.__zq_bot{display:flex;align-items:center;gap:10px;padding:11px 14px;border-radius:10px;
  background:rgba(255,68,68,.13);border:1px solid rgba(255,68,68,.45);
  animation:__zq_pulse 1.6s ease-in-out infinite;cursor:help}
@keyframes __zq_pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,68,68,.0)}50%{box-shadow:0 0 0 5px rgba(255,68,68,.18)}}
.__zq_bot_icon{font-size:22px;flex-shrink:0;line-height:1}
.__zq_bot_text{flex:1;display:flex;flex-direction:column;gap:2px}
.__zq_bot_title{font-size:11px;font-weight:900;color:#FF4444;letter-spacing:.6px}
.__zq_bot_sub{font-size:10px;color:#E8E8F0;opacity:.8}
.__zq_bot_pill{font-size:9px;font-weight:800;color:#FF4444;border:1px solid rgba(255,68,68,.5);border-radius:4px;padding:2px 6px;flex-shrink:0;letter-spacing:.4px}
#__zq_tip{position:fixed;z-index:2147483648;pointer-events:none;
  background:#1A1A2E;border:1px solid rgba(255,255,255,.15);border-radius:8px;
  padding:8px 11px;max-width:260px;font-size:11px;line-height:1.5;color:#C8C8E0;
  box-shadow:0 8px 24px rgba(0,0,0,.7);opacity:0;transition:opacity .12s;
  white-space:pre-wrap;word-break:break-word}`;

  function _esc(s) { const d = document.createElement('span'); d.textContent = String(s ?? ''); return d.innerHTML; }
  function _escA(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

  function _injectCSS() {
    if (document.getElementById('__zqlite_css')) return;
    const st = document.createElement('style');
    st.id = '__zqlite_css';
    st.textContent = _CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // Always requires manual confirmation — no auto-proceed.
  // scorePromise: optional live fetch; overlay updates its DOM when it resolves.
  function _showOverlay(score, scorePromise, fullPromise) {
    return new Promise((resolve) => {
      _injectCSS();

      function _proceedClass(sc) {
        const n = sc?.score ?? null;
        const l = sc?.level ?? null;
        if (l === 'CRITICAL' || n >= 75) return 'red';
        if (l === 'HIGH'     || n >= 50) return 'orange';
        if (l === 'MEDIUM'   || n >= 25) return 'amber';
        return ''; // LOW — green default
      }

      function _proceedLabel(sc) {
        const l = sc?.level ?? null;
        if (l === 'CRITICAL') return '⛔ Proceed Anyway';
        if (l === 'HIGH')     return '⚠ Proceed Anyway';
        return '✓ Looks Good — Proceed';
      }

      let _tipTexts = [];
      const SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, LOADING: 10 };
      const SEV_PILL  = { LOW: 'LOW', MEDIUM: 'MOD', HIGH: 'HIGH', CRITICAL: 'CRIT' };

      // Returns the bot-creator factor if present in the score, else null.
      function _botFactor(sc) {
        return (sc?.factors ?? []).find(f => f.name && /bot(-created token|factory)/i.test(f.name)) ?? null;
      }

      function _buildBotBanner(f) {
        if (!f) return '';
        return `<div class="__zq_bot" id="__zq_bot0" title="${_escA(f.detail)}">
          <span class="__zq_bot_icon">🤖</span>
          <div class="__zq_bot_text">
            <span class="__zq_bot_title">BOT-CREATED TOKEN</span>
            <span class="__zq_bot_sub">${_esc(f.name.replace(/^bot(-created token|factory)\s*—?\s*/i, ''))}</span>
          </div>
          <span class="__zq_bot_pill">CRIT</span>
        </div>`;
      }

      function _buildFactors(sc) {
        const botF = _botFactor(sc);
        // Sort CRIT→HIGH→MEDIUM→LOW→LOADING; exclude bot factor (shown in banner)
        const sorted = (sc?.factors ?? [])
          .filter(f => f !== botF)
          .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))
          .slice(0, 10);
        _tipTexts = sorted.map(f => {
          if (f.severity === 'LOADING') return null;
          const sevLabel = f.severity === 'LOW' ? 'Low risk' : f.severity === 'MEDIUM' ? 'Moderate risk' : f.severity === 'HIGH' ? 'High risk' : 'Critical risk';
          return `${sevLabel}\n${f.detail ?? f.name}`;
        });
        return sorted.map((f, i) => {
          if (f.severity === 'LOADING') {
            return `<div class="__zq_ld"><div class="__zq_spin"></div><span style="flex:1">${_esc(f.name)}</span></div>`;
          }
          const fc   = SEV_COLOR[f.severity] ?? '#E8E8F0';
          const icon = f.severity === 'LOW' ? '✓' : '⚠';
          const pill = SEV_PILL[f.severity] ?? f.severity;
          return `<div class="__zq_fi" data-fi="${i}">
            <span style="color:${fc};flex-shrink:0;width:14px">${icon}</span>
            <span style="flex:1">${_esc(f.name)}</span>
            <span style="font-size:9px;font-weight:700;color:${fc};opacity:.85;flex-shrink:0;letter-spacing:.4px">${pill}</span>
          </div>`;
        }).join('') || '<div class="__zq_fi" style="color:#6B6B8A">No scan data available</div>';
      }

      const scanPending = !score && !!scorePromise;
      const lvl   = score?.level ?? 'UNKNOWN';
      const col   = LEVEL_COLOR[lvl] ?? '#6B6B8A';
      const label = LEVEL_LABEL[lvl] ?? (scanPending ? 'Scanning…' : 'Unknown');
      const num   = score?.score != null ? score.score : '?';
      const pCls  = _proceedClass(score);
      const pLbl  = _proceedLabel(score);
      const _botF = _botFactor(score);
      // Loading scan rows — shown in place of factor list while data is in flight
      const _scanRows = `
        <div class="__zq_ld">
          <div style="display:flex;flex-direction:column;gap:2px;flex:1">
            <span style="font-weight:700">Downloading token data…</span>
            <span class="__zq_ld_sub">Checking on-chain supply · RugCheck · DexScreener</span>
          </div>
          <div class="__zq_spin"></div>
        </div>`;

      const backdrop = document.createElement('div');
      backdrop.id = '__zqlite_bd';
      backdrop.innerHTML = `
        <div class="__zq_card">
          <div class="__zq_hd">
            <!-- logo svg --><svg width="33" height="33" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="__zqlg_r" x1="20%" y1="0%" x2="80%" y2="100%">
                  <stop offset="0%" stop-color="#00e5ff"/>
                  <stop offset="35%" stop-color="#5566ff"/>
                  <stop offset="65%" stop-color="#9922ff"/>
                  <stop offset="100%" stop-color="#cc44ff"/>
                </linearGradient>
                <linearGradient id="__zqlg_i" x1="0%" y1="0%" x2="40%" y2="100%">
                  <stop offset="0%" stop-color="#aa44ff"/>
                  <stop offset="100%" stop-color="#cc22ff"/>
                </linearGradient>
              </defs>
              <path d="M 64 14 C 92 13, 114 34, 115 62 C 116 91, 95 113, 66 114 C 37 115, 14 93, 13 64 C 12 38, 30 17, 55 14" fill="none" stroke="#7722ff" stroke-width="14" stroke-linecap="round" opacity="0.2"/>
              <path d="M 64 15 C 91 14, 113 35, 113 63 C 113 90, 93 112, 65 113 C 37 114, 15 93, 15 65 C 15 39, 33 18, 57 15" fill="none" stroke="url(#__zqlg_r)" stroke-width="9" stroke-linecap="round"/>
              <path d="M 64 15 C 72 14, 80 15, 87 18" fill="none" stroke="url(#__zqlg_r)" stroke-width="12" stroke-linecap="round" opacity="0.9"/>
              <path d="M 44 23 C 49 19, 53 16, 58 15" fill="none" stroke="#00e5ff" stroke-width="4" stroke-linecap="round" opacity="0.55"/>
              <text x="65" y="70" font-family="'Arial Black','Helvetica Neue',Arial,sans-serif" font-weight="900" font-size="48" fill="url(#__zqlg_i)" text-anchor="middle" dominant-baseline="middle" letter-spacing="-2">IQ</text>
            </svg>
            <span class="__zq_ht">ZendIQ Lite · Token Risk Check</span>
          </div>
          ${scanPending ? '<div class="__zq_prog" id="__zq_prog"><div class="__zq_prog_bar"></div></div>' : ''}
          <div class="__zq_body">
            ${_buildBotBanner(_botF)}
            <div class="__zq_sr" style="${_botF ? 'margin-top:10px' : ''}">
              <span class="__zq_sn" id="__zq_num" style="color:${col}">${num}</span>
              <span class="__zq_sp" id="__zq_badge" style="color:${col};border-color:${col}40">${label} · ${num}/100</span>
            </div>
            <div class="__zq_fl" id="__zq_fl0">${scanPending ? _scanRows : _buildFactors(score)}</div>
          </div>
          <div class="__zq_ai" id="__zq_ai0">
            <button class="__zq_btn __zq_cancel" id="__zq_cancel">✕ Cancel Swap</button>
            <button class="__zq_btn __zq_proceed ${scanPending ? '__zq_pld' : pCls}" id="__zq_proceed">${scanPending ? '✓ Proceed — Checking risk…' : pLbl}</button>
          </div>
          <div class="__zq_nt">Not financial advice · use at own risk</div>
        </div>`;

      // ── Floating tooltip ──────────────────────────────────────────────────
      const _tipEl = document.createElement('div');
      _tipEl.id = '__zq_tip';
      document.body.appendChild(_tipEl);

      function _tipMove(mx, my) {
        const tw = _tipEl.offsetWidth  || 200;
        const th = _tipEl.offsetHeight || 60;
        const margin = 14;
        let x = mx + margin;
        let y = my + margin;
        if (x + tw + margin > window.innerWidth)  x = mx - tw - margin;
        if (y + th + margin > window.innerHeight) y = my - th - margin;
        _tipEl.style.left = x + 'px';
        _tipEl.style.top  = y + 'px';
      }
      function _tipShow(text, mx, my) { _tipEl.textContent = text; _tipMove(mx, my); _tipEl.style.opacity = '1'; }
      function _tipHide() { _tipEl.style.opacity = '0'; }

      function _wireTips(container) {
        container.querySelectorAll('[data-fi]').forEach(el => {
          const txt = _tipTexts[Number(el.dataset.fi)];
          if (!txt) return;
          el.addEventListener('mouseenter', ev => _tipShow(txt, ev.clientX, ev.clientY));
          el.addEventListener('mousemove',  ev => _tipMove(ev.clientX, ev.clientY));
          el.addEventListener('mouseleave', _tipHide);
        });
      }

      function done(dec) {
        _tipHide(); _tipEl.remove();
        document.getElementById('__zqlite_bd')?.remove();
        resolve(dec);
      }

      backdrop.querySelector('#__zq_cancel').onclick = () => done('cancel');
      // Proceed is always clickable — even during the background scan
      backdrop.querySelector('#__zq_proceed').onclick = () => done('proceed');
      document.body.appendChild(backdrop);
      _wireTips(backdrop);

      // Enable the Proceed button in-place (was rendered in loading state initially)
      function _activateProceed(sc) {
        const btn = backdrop.querySelector('#__zq_proceed');
        if (!btn) return;
        btn.removeAttribute('data-loading');
        btn.classList.remove('__zq_pld');
        const cls2 = _proceedClass(sc);
        if (cls2) btn.classList.add(cls2);
        btn.textContent = _proceedLabel(sc);
        btn.onclick = () => done('proceed');
        backdrop.querySelector('#__zq_prog')?.remove();
      }

      if (scorePromise) {
        // Scan in flight — update card when result arrives, then add Proceed button
        scorePromise.then(freshScore => {
          if (!backdrop.isConnected) return;

          const lvl2   = freshScore?.level ?? 'UNKNOWN';
          const col2   = LEVEL_COLOR[lvl2] ?? '#6B6B8A';
          const label2 = LEVEL_LABEL[lvl2] ?? 'Unknown';
          const num2   = freshScore?.score != null ? freshScore.score : '?';

          // Update score + badge
          const snEl = backdrop.querySelector('#__zq_num');
          const spEl = backdrop.querySelector('#__zq_badge');
          if (snEl) { snEl.textContent = num2; snEl.style.color = col2; }
          if (spEl) { spEl.textContent = `${label2} · ${num2}/100`; spEl.style.color = col2; spEl.style.borderColor = col2 + '40'; }

          // Rebuild bot banner + factors with live tooltips
          const newBot = _botFactor(freshScore ?? null);
          const botEl  = backdrop.querySelector('#__zq_bot0');
          const bodyEl = backdrop.querySelector('.__zq_body');
          if (newBot && !botEl && bodyEl) {
            bodyEl.insertAdjacentHTML('afterbegin', _buildBotBanner(newBot));
          }
          const flEl = backdrop.querySelector('#__zq_fl0');
          if (flEl) { flEl.innerHTML = _buildFactors(freshScore ?? null); _wireTips(flEl); }

          // Activate Proceed when this is the final result (fullPromise not pending)
          if (!fullPromise || !freshScore?._deployerPending) {
            _activateProceed(freshScore);
          }
        }).catch(() => {
          if (!backdrop.isConnected) return;
          if (!fullPromise) _activateProceed(null);
        });
      }

      // Phase 2: deployer result arrives — replace spinner, update score, add Proceed
      if (fullPromise) {
        fullPromise.then(finalScore => {
          if (!backdrop.isConnected) return;
          const lvlF  = finalScore?.level ?? 'UNKNOWN';
          const colF  = LEVEL_COLOR[lvlF] ?? '#6B6B8A';
          const lblF  = LEVEL_LABEL[lvlF] ?? 'Unknown';
          const numF  = finalScore?.score != null ? finalScore.score : '?';
          const snEl2 = backdrop.querySelector('#__zq_num');
          const spEl2 = backdrop.querySelector('#__zq_badge');
          if (snEl2) { snEl2.textContent = numF; snEl2.style.color = colF; }
          if (spEl2) { spEl2.textContent = lblF + ' · ' + numF + '/100'; spEl2.style.color = colF; spEl2.style.borderColor = colF + '40'; }
          const newBotF = _botFactor(finalScore ?? null);
          const botElF  = backdrop.querySelector('#__zq_bot0');
          const bodyElF = backdrop.querySelector('.__zq_body');
          if (newBotF && !botElF && bodyElF) {
            bodyElF.insertAdjacentHTML('afterbegin', _buildBotBanner(newBotF));
          }
          const flElF = backdrop.querySelector('#__zq_fl0');
          if (flElF) { flElF.innerHTML = _buildFactors(finalScore ?? null); _wireTips(flElF); }
          _activateProceed(finalScore);
        }).catch(() => {
          if (!backdrop.isConnected) return;
          _activateProceed(null);
        });
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. HISTORY
  // ══════════════════════════════════════════════════════════════════════════
  function _rawToDecimal(raw, mint) {
    if (raw == null) return null;
    const n = Number(raw);
    if (!isFinite(n)) return null;
    return n / Math.pow(10, _TOKEN_DEC[mint] ?? 6);
  }

  function _addToHistory(entry) {
    const od       = ns.lastOrderDetails;
    const inMint   = od?.inputMint  ?? ns.lastInputMint  ?? null;
    const outMint  = od?.outputMint ?? ns.lastOutputMint ?? entry.mint ?? null;
    const outSym   = entry.symbol ?? _TOKEN_SYM[outMint] ?? null;
    const inSym    = _TOKEN_SYM[inMint] ?? null;
    const enriched = {
      ...entry,
      tokenIn:    inSym,
      tokenOut:   outSym,
      inputMint:  inMint,
      outputMint: outMint,
      amountIn:   od ? _rawToDecimal(od.inAmount,  inMint)  : null,
      amountOut:  od ? _rawToDecimal(od.outAmount, outMint) : null,
      inUsdValue:  od?.inUsdValue  ?? null,
      outUsdValue: od?.outUsdValue ?? null,
      swapType:    od?.swapType ?? null,
    };
    ns.recentSwaps.unshift(enriched);
    if (ns.recentSwaps.length > 50) ns.recentSwaps.pop();
    window.postMessage({ type: 'ZQLITE_HISTORY_UPDATE', entry: enriched }, '*');
  }

  // Run repeated scanAndWrapGlobalWallets sweeps for 5s after load —
  // catches any wallet object that registers late (mirrors Pro's pattern).
  const _scanInt = setInterval(() => {
    if (typeof ns.scanAndWrapGlobalWallets === 'function') ns.scanAndWrapGlobalWallets();
  }, 250);
  setTimeout(() => clearInterval(_scanInt), 5000);

  // ══════════════════════════════════════════════════════════════════════════
  // 6. ONBOARDING OVERLAY (first install only)
  // ══════════════════════════════════════════════════════════════════════════
  const _OB_CSS = `
#__zqlite_ob{position:fixed;inset:0;background:rgba(0,0,0,.82);backdrop-filter:blur(6px);
  z-index:2147483646;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;animation:__zq_fade .22s ease}
.__zq_ob_card{background:#0F0F1B;border:1px solid rgba(153,69,255,.4);border-radius:18px;
  width:440px;max-width:calc(100vw - 24px);max-height:90vh;display:flex;flex-direction:column;
  box-shadow:0 28px 60px rgba(0,0,0,.92),inset 0 1px 0 rgba(255,255,255,.04)}
.__zq_ob_hd{padding:18px 20px 14px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:12px;flex-shrink:0}
.__zq_ob_logo{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,rgba(153,69,255,.2),rgba(20,241,149,.08));border:1px solid rgba(153,69,255,.35);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.__zq_ob_htx{flex:1}
.__zq_ob_h1{font-size:15px;font-weight:900;background:linear-gradient(90deg,#00e5ff 0%,#9945FF 55%,#14F195 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1px}
.__zq_ob_sub{font-size:10px;color:#6B6B8A}
.__zq_ob_body{padding:14px 18px 6px;overflow-y:auto;flex:1}
.__zq_ob_steps{display:flex;flex-direction:column;gap:7px;margin-bottom:12px}
.__zq_ob_step{display:flex;align-items:flex-start;gap:11px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;padding:11px 13px}
.__zq_ob_num{flex-shrink:0;width:24px;height:24px;border-radius:50%;background:rgba(153,69,255,.15);border:1px solid rgba(153,69,255,.4);color:#9945FF;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center}
.__zq_ob_stxt{flex:1}
.__zq_ob_stitle{font-size:11.5px;font-weight:700;color:#E8E8F0;margin-bottom:2px}
.__zq_ob_sdesc{font-size:10px;color:#6B6B8A;line-height:1.55}
.__zq_ob_chips{display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin-bottom:14px}
.__zq_ob_chip{font-size:10px;font-weight:700;padding:4px 13px;border-radius:20px;background:rgba(20,241,149,.07);color:#14F195;border:1px solid rgba(20,241,149,.22)}
.__zq_ob_foot{padding:10px 18px 16px;border-top:1px solid rgba(255,255,255,.07);flex-shrink:0}
.__zq_ob_btn{width:100%;padding:13px;background:linear-gradient(135deg,#9945FF,#14F195);border:none;border-radius:12px;color:#000;font-size:13px;font-weight:800;cursor:pointer;transition:opacity .15s;letter-spacing:.2px}
.__zq_ob_btn:hover{opacity:.85}
.__zq_ob_note{text-align:center;font-size:9px;color:#3A3A5A;margin-top:8px;line-height:1.6}
`;

  function _showOnboardingOverlay() {
    if (document.getElementById('__zqlite_ob')) return;
    const styleEl = document.createElement('style');
    styleEl.textContent = _OB_CSS;
    document.head.appendChild(styleEl);

    const el = document.createElement('div');
    el.id = '__zqlite_ob';
    el.innerHTML = `
      <div class="__zq_ob_card">
        <div class="__zq_ob_hd">
          <div class="__zq_ob_logo">
            <svg width="28" height="28" viewBox="0 0 128 128" fill="none">
              <defs>
                <linearGradient id="__zqob_r" x1="20%" y1="0%" x2="80%" y2="100%">
                  <stop offset="0%" stop-color="#00e5ff"/>
                  <stop offset="50%" stop-color="#9922ff"/>
                  <stop offset="100%" stop-color="#cc44ff"/>
                </linearGradient>
                <linearGradient id="__zqob_i" x1="0%" y1="0%" x2="40%" y2="100%">
                  <stop offset="0%" stop-color="#aa44ff"/>
                  <stop offset="100%" stop-color="#cc22ff"/>
                </linearGradient>
              </defs>
              <path d="M 64 15 C 91 14, 113 35, 113 63 C 113 90, 93 112, 65 113 C 37 114, 15 93, 15 65 C 15 39, 33 18, 57 15" fill="none" stroke="url(#__zqob_r)" stroke-width="9" stroke-linecap="round"/>
              <text x="65" y="70" font-family="'Arial Black',Arial,sans-serif" font-weight="900" font-size="48" fill="url(#__zqob_i)" text-anchor="middle" dominant-baseline="middle" letter-spacing="-2">IQ</text>
            </svg>
          </div>
          <div class="__zq_ob_htx">
            <div class="__zq_ob_h1">Welcome to ZendIQ Lite</div>
            <div class="__zq_ob_sub">Your free Solana swap guardian — here's how to get started</div>
          </div>
        </div>
        <div class="__zq_ob_body">
          <div class="__zq_ob_steps">
            <div class="__zq_ob_step">
              <div class="__zq_ob_num">1</div>
              <div class="__zq_ob_stxt">
                <div class="__zq_ob_stitle">Run your wallet security check</div>
                <div class="__zq_ob_sdesc">Click <strong style="color:#E8E8F0">Get Started</strong> below to open the ZendIQ popup. Head to the <strong style="color:#E8E8F0">Wallet</strong> tab and scan for dangerous token approvals and auto-sign settings.</div>
              </div>
            </div>
            <div class="__zq_ob_step">
              <div class="__zq_ob_num">2</div>
              <div class="__zq_ob_stxt">
                <div class="__zq_ob_stitle">Trade as normal</div>
                <div class="__zq_ob_sdesc">Stay on Jupiter, Raydium, or Pump.fun and start a swap as you always have. ZendIQ works silently in the background.</div>
              </div>
            </div>
            <div class="__zq_ob_step">
              <div class="__zq_ob_num">3</div>
              <div class="__zq_ob_stxt">
                <div class="__zq_ob_stitle">ZendIQ scans the token</div>
                <div class="__zq_ob_sdesc">Before you sign, we check 15 on-chain signals — mint authority, holder concentration, rug flags, LP lock, deployer history, and more.</div>
              </div>
            </div>
            <div class="__zq_ob_step">
              <div class="__zq_ob_num">4</div>
              <div class="__zq_ob_stxt">
                <div class="__zq_ob_stitle">You decide with full context</div>
                <div class="__zq_ob_sdesc">A risk overlay shows the score and key factors. Cancel if it looks risky, or proceed knowing the real picture.</div>
              </div>
            </div>
          </div>
          <div class="__zq_ob_chips">
            <span class="__zq_ob_chip">Jupiter</span>
            <span class="__zq_ob_chip">Raydium</span>
            <span class="__zq_ob_chip">Pump.fun</span>
          </div>
        </div>
        <div class="__zq_ob_foot">
          <button class="__zq_ob_btn" id="__zq_ob_start">Get Started &rarr;</button>
          <div class="__zq_ob_note">Free forever &nbsp;&middot;&nbsp; No wallet address stored &nbsp;&middot;&nbsp; Open source</div>
        </div>
      </div>`;

    document.body.appendChild(el);

    el.querySelector('#__zq_ob_start').onclick = () => {
      el.remove();
      styleEl.remove();
      window.postMessage({ type: 'ZQLITE_ONBOARDING_COMPLETE' }, '*');
    };
  }

  // Check onboarded state via bridge and show overlay if first install
  window.postMessage({ type: 'ZQLITE_CHECK_ONBOARDED' }, '*');
  window.addEventListener('message', function _onbHandler(e) {
    if (!e.data || e.data.type !== 'ZQLITE_ONBOARDED_RESPONSE') return;
    window.removeEventListener('message', _onbHandler);
    if (!e.data.onboarded) {
      if (document.body) {
        _showOnboardingOverlay();
      } else {
        document.addEventListener('DOMContentLoaded', _showOnboardingOverlay, { once: true });
      }
    }
  });
})();
