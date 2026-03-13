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
      // Raydium compute / swap endpoint
      if (/raydium\.io/.test(url) && /\/(compute|swap)/.test(url)) {
        const u = new URL(url, location.origin);
        const out = u.searchParams.get('outputMint') ?? u.searchParams.get('mintB');
        if (out) { ns.lastOutputMint = out; _probeScore(out); }
        // Also check response body (Raydium sometimes puts mints in the JSON response)
        resp.then(r => r.clone().json().then(d => {
          const m = d?.data?.outputMint ?? d?.outputMint;
          if (m && m !== ns.lastOutputMint) { ns.lastOutputMint = m; _probeScore(m); }
        }).catch(() => {})).catch(() => {});
      }
      // Pump.fun — mint is typically a path segment in trade/buy URLs
      if (/pump\.fun/.test(url) && /\/(trade|buy|swap)/.test(url)) {
        const segs = new URL(url, location.origin).pathname.split('/')
          .filter(p => p.length >= 32 && p.length <= 50 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(p));
        if (segs[0] && segs[0] !== ns.lastOutputMint) { ns.lastOutputMint = segs[0]; _probeScore(segs[0]); }
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
        } catch (_) {}
      }
    } catch (_) {}
    return resp;
  };

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
            const postEntry = post.find(e => e.mint === outputMint && e.owner === walletPubkey);
            const preEntry  = pre.find(e  => e.mint === outputMint && e.owner === walletPubkey);
            if (postEntry) {
              const diff = (postEntry.uiTokenAmount?.uiAmount ?? 0) - (preEntry?.uiTokenAmount?.uiAmount ?? 0);
              if (diff > 0) actualOut = diff;
            }
          }

          if (actualOut == null) {
            // Tx confirmed but couldn't parse output — no point retrying
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
      if (result) window.postMessage({ type: 'ZQLITE_SAVE_SCAN', scan: { mint, result, ts: Date.now(), site: location.hostname } }, '*');
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
    // Jupiter / Raydium: "Swap" or "Confirm Swap"
    const _isSwapBtn = /^(confirm\s+)?swap$/i.test(txt);
    // Pump.fun: "Buy [TokenName]", "Buy", or "Place Trade" — only when a mint is known
    // (guards against intercepting nav-only "Buy X" links on the homepage before a coin is selected)
    const _isPumpBuy = location.hostname.includes('pump.fun')
      && !!ns.lastOutputMint
      && /^(buy(\s+\S.*)?|place\s+trade)$/i.test(txt)
      && txt.length <= 40;
    if (!_isSwapBtn && !_isPumpBuy) return;

    e.stopImmediatePropagation();
    e.preventDefault();

    const mint = ns.lastOutputMint;
    const score = (mint && ns.lastTokenScore?.mint === mint && ns.lastTokenScore?.loaded)
      ? ns.lastTokenScore : null;

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
      _ensureScoring();
      if (typeof fetchTokenScore === 'function' && !_scoreInFlight.has(mint)) {
        fetchTokenScore(mint)
          .then(r => { if (r) { ns.lastTokenScore = r; window.postMessage({ type: 'ZQLITE_SAVE_SCAN', scan: { mint, result: r, ts: Date.now(), site: location.hostname } }, '*'); } })
          .catch(() => {});
      }
    }

    const threshold = SCORE_THRESHOLD[ns.settings.minRiskLevel ?? 'MEDIUM'] ?? 25;
    const isRisky   = score != null && score.score >= threshold;

    let decision;
    try {
      decision = await _showOverlay(score, _scorePromise, _fullPromise);
    } catch (_) {
      decision = 'proceed'; // fail open
    }

    const _finalScore = (mint && ns.lastTokenScore?.mint === mint) ? ns.lastTokenScore : score;
    _addToHistory({ ts: Date.now(), mint, symbol: _finalScore?.symbol ?? null, score: _finalScore?.score ?? null, level: _finalScore?.level ?? null, decision, site: location.hostname });

    if (decision === 'cancel') return; // do nothing — swap never continues

    // User confirmed — re-fire the click bypassing our interceptor
    window.__zqlite_swap_bypass = true;
    try { btn.click(); } finally { window.__zqlite_swap_bypass = false; }
  }, { capture: true });

  // ── SECONDARY GATE: wallet.signTransaction hook ───────────────────────────
  // Fallback for any signing path not caught by the click interceptor above.

  ns.handleTransaction = async function (tx, opts, originalFn, _method) {
    console.log('[ZendIQ Lite] handleTransaction called, method=', _method);
    if (!ns.settings.enabled) return originalFn(tx, opts);

    // Site-level toggle check — only bypass, never skip the overlay for enabled sites
    const host = location.hostname;
    if (host.includes('jup.ag')   && !ns.settings.sites.jupiter) return originalFn(tx, opts);
    if (host.includes('raydium')  && !ns.settings.sites.raydium)  return originalFn(tx, opts);
    if (host.includes('pump.fun') && !ns.settings.sites.pumpfun)  return originalFn(tx, opts);

    const mint = ns.lastOutputMint;

    // Use only the proactively-cached score — no blocking async fetch before showing overlay.
    // _probeScore() fires immediately when any /order request is intercepted, so by the
    // time the user can click Swap the score is normally already cached.
    const score = (mint && ns.lastTokenScore?.mint === mint && ns.lastTokenScore?.loaded)
      ? ns.lastTokenScore : null;

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
      _ensureScoring();
      if (typeof fetchTokenScore === 'function' && !_scoreInFlight.has(mint)) {
        fetchTokenScore(mint)
          .then(r => {
            if (r) {
              ns.lastTokenScore = r;
              window.postMessage({ type: 'ZQLITE_SAVE_SCAN', scan: { mint, result: r, ts: Date.now(), site: host } }, '*');
            }
          })
          .catch(() => {});
      }
    }

    const threshold = SCORE_THRESHOLD[ns.settings.minRiskLevel ?? 'MEDIUM'] ?? 25;
    const isRisky   = score != null && score.score >= threshold;

    // Overlay always requires manual confirmation — no auto-proceed.
    const decision = await _showOverlay(score, _scorePromise, _fullPromise);

    const _finalScore = (mint && ns.lastTokenScore?.mint === mint) ? ns.lastTokenScore : score;
    _addToHistory({
      ts: Date.now(), mint, symbol: _finalScore?.symbol ?? null,
      score: _finalScore?.score ?? null, level: _finalScore?.level ?? null, decision, site: host,
    });

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
.__zq_nt{text-align:center;font-size:9.5px;color:#3A3A5A;padding:0 18px 12px}
.__zq_ld{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;
  background:rgba(255,255,255,.03);font-size:10.5px;color:#6B6B8A}
.__zq_spin{width:10px;height:10px;border:1.5px solid rgba(255,255,255,.12);
  border-top-color:#9945FF;border-radius:50%;animation:__zq_spin .7s linear infinite;flex-shrink:0}
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

      const backdrop = document.createElement('div');
      backdrop.id = '__zqlite_bd';
      backdrop.innerHTML = `
        <div class="__zq_card">
          <div class="__zq_hd">
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
              <path d="M14 3L25 8.5V15C25 20.25 20.1 24.9 14 26.5C7.9 24.9 3 20.25 3 15V8.5L14 3Z"
                fill="rgba(153,69,255,.18)" stroke="#9945FF" stroke-width="1.4"/>
              <path d="M10 14L13 17L18 11" stroke="#14F195" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="__zq_ht">ZendIQ Lite · Token Risk Check</span>
          </div>
          <div class="__zq_body">
            ${_buildBotBanner(_botF)}
            <div class="__zq_sr" style="${_botF ? 'margin-top:10px' : ''}">
              <span class="__zq_sn" id="__zq_num" style="color:${col}">${num}</span>
              <span class="__zq_sp" id="__zq_badge" style="color:${col};border-color:${col}40">${label} · ${num}/100</span>
            </div>
            <div class="__zq_fl" id="__zq_fl0">${scanPending ? '<div class="__zq_ld"><div class="__zq_spin"></div><span>Fetching on-chain data…</span></div>' : _buildFactors(score)}</div>
          </div>
          <div class="__zq_ai" id="__zq_ai0">
            <button class="__zq_btn __zq_cancel" id="__zq_cancel">✕ Cancel Swap</button>
            ${!scanPending ? `<button class="__zq_btn __zq_proceed ${pCls}" id="__zq_proceed">${pLbl}</button>` : ''}
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
      if (!scanPending) backdrop.querySelector('#__zq_proceed')?.addEventListener('click', () => done('proceed'));
      document.body.appendChild(backdrop);
      _wireTips(backdrop);

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

          // Add Proceed only when this is the final result (fullPromise not pending)
          if (!fullPromise || !freshScore?._deployerPending) {
            const aiEl = backdrop.querySelector('#__zq_ai0');
            if (aiEl && !aiEl.querySelector('#__zq_proceed')) {
              const pCls2 = _proceedClass(freshScore);
              const pLbl2 = _proceedLabel(freshScore);
              const btn2 = document.createElement('button');
              btn2.className = `__zq_btn __zq_proceed ${pCls2}`;
              btn2.id = '__zq_proceed';
              btn2.textContent = pLbl2;
              btn2.onclick = () => done('proceed');
              aiEl.appendChild(btn2);
            }
          }
        }).catch(() => {
          // Timed out or failed — only add Proceed if fullPromise won’t
          if (!fullPromise) {
            if (!backdrop.isConnected) return;
            const aiEl = backdrop.querySelector('#__zq_ai0');
            if (aiEl && !aiEl.querySelector('#__zq_proceed')) {
              const btn2 = document.createElement('button');
              btn2.className = '__zq_btn __zq_proceed';
              btn2.id = '__zq_proceed';
              btn2.textContent = 'Proceed Anyway →';
              btn2.onclick = () => done('proceed');
              aiEl.appendChild(btn2);
            }
          }
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
          const aiElF = backdrop.querySelector('#__zq_ai0');
          if (aiElF && !aiElF.querySelector('#__zq_proceed')) {
            const pClsF = _proceedClass(finalScore);
            const pLblF = _proceedLabel(finalScore);
            const btnF  = document.createElement('button');
            btnF.className = `__zq_btn __zq_proceed ${pClsF}`;
            btnF.id = '__zq_proceed';
            btnF.textContent = pLblF;
            btnF.onclick = () => done('proceed');
            aiElF.appendChild(btnF);
          }
        }).catch(() => {
          // Deployer lookup failed — add fallback Proceed so user isn’t blocked
          if (!backdrop.isConnected) return;
          const aiElF = backdrop.querySelector('#__zq_ai0');
          if (aiElF && !aiElF.querySelector('#__zq_proceed')) {
            const btnF = document.createElement('button');
            btnF.className = '__zq_btn __zq_proceed';
            btnF.id = '__zq_proceed';
            btnF.textContent = 'Proceed Anyway →';
            btnF.onclick = () => done('proceed');
            aiElF.appendChild(btnF);
          }
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
})();
