/**
 * ZendIQ Lite — popup-history.js
 * History tab: lists intercepted swaps with risk level + decision.
 */

// Wire the shared floating tooltip (#float-tip) to all [data-tip] elements in a container.
function _wireFloatTip(container) {
  const tip = document.getElementById('float-tip');
  if (!tip) return;
  container.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('mouseenter', () => {
      tip.textContent = el.dataset.tip;
      tip.style.display = 'block';
    });
    el.addEventListener('mousemove', e => {
      const tipH = tip.offsetHeight;
      const tipW = tip.offsetWidth || 280;
      const x    = Math.min(e.clientX + 12, window.innerWidth - tipW - 8);
      const y    = (window.innerHeight - e.clientY) < (tipH + 24)
                   ? e.clientY - tipH - 8
                   : e.clientY + 16;
      tip.style.left = Math.max(4, x) + 'px';
      tip.style.top  = Math.max(4, y) + 'px';
    });
    el.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

// Relative time — mirrors Pro's _fmtAgo
function _fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60)  return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

// EU-style amount formatter — matches Pro's _fmtAmt exactly
// e.g. _fmtAmt(2180753.36, 'BONK') → "2.180.753,36 BONK"
function _fmtAmt(val, sym) {
  const safeSym = escHtml(sym || '');
  if (val == null) return '— ' + safeSym;
  const n = parseFloat(val);
  if (!isFinite(n)) return '— ' + safeSym;
  const abs  = Math.abs(n);
  const prec = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.001 ? 6 : 8;
  const [ip, dp] = n.toFixed(prec).split('.');
  const intFmt = ip.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (dp ? intFmt + ',' + dp : intFmt) + ' ' + safeSym;
}

function loadHistory() {
  const panel = document.getElementById('panel-history');
  if (!panel) return;

  chrome.storage.local.get(['zqlite_swap_history'], ({ zqlite_swap_history: hist = [] }) => {
    if (!Array.isArray(hist) || hist.length === 0) {
      panel.innerHTML = `
        <div class="empty-state">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect x="4" y="8" width="24" height="16" rx="3" stroke="#6B6B8A" stroke-width="1.5"/>
            <path d="M9 14H23M9 19H16" stroke="#6B6B8A" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <div>No intercepted swaps yet</div>
          <div style="font-size:var(--fs-base);margin-top:4px;color:var(--muted)">
            Open <a href="https://jup.ag" target="_blank" style="color:var(--purple)">jup.ag</a>
            and try a swap — ZendIQ Lite will log it here
          </div>
        </div>
      `;
      return;
    }

    const entries = hist.slice(0, 50).map(h => _histEntry(h)).join('');
    panel.innerHTML = `
      <div style="font-size:var(--fs-sm);color:var(--muted);margin-bottom:8px">
        ${hist.length} intercepted swap${hist.length !== 1 ? 's' : ''} · most recent first
      </div>
      <div style="max-height:340px;overflow-y:auto;padding-right:4px">${entries}</div>
      ${hist.length > 50 ? `<div style="font-size:var(--fs-sm);color:var(--muted);text-align:center;margin-top:4px">Showing 50 of ${hist.length}</div>` : ''}
    `;
    _wireFloatTip(panel);
  });
}

function _histEntry(h) {
  const lvl   = h.level ?? 'LOW';
  const COLOR = { LOW: '#14F195', MEDIUM: '#FFB547', HIGH: '#FF6B00', CRITICAL: '#FF4444' };
  const color = COLOR[lvl] ?? '#9B9BAD';
  const ago   = _fmtAgo(h.ts);
  const dec   = h.decision === 'cancel' ? 'cancel' : 'proceed';

  const lvlLabel = levelLabel(lvl);
  const decLabel = dec === 'cancel' ? '✕ Cancelled' : '✓ Proceeded';
  const decColor = dec === 'cancel' ? '#FF4444' : '#14F195';
  const decBg    = dec === 'cancel' ? 'rgba(255,68,68,0.1)' : 'rgba(20,241,149,0.1)';

  const border = { LOW: 'rgba(20,241,149,0.15)', MEDIUM: 'rgba(255,181,71,0.20)',
    HIGH: 'rgba(255,107,0,0.25)', CRITICAL: 'rgba(255,68,68,0.28)' }[lvl] ?? 'rgba(255,255,255,0.07)';
  const cardBg = dec === 'cancel' ? 'rgba(255,68,68,0.03)' : 'rgba(255,255,255,0.02)';

  // Exchange / route label
  const site = _shortSite(h.site ?? '');
  const routeLabel = escHtml(site + (h.swapType && h.swapType !== 'aggregator'
    ? ' · ' + h.swapType.charAt(0).toUpperCase() + h.swapType.slice(1).toLowerCase()
    : ''));

  const hasAmounts = h.amountOut != null || h.amountIn != null;
  const outSym = h.tokenOut ?? h.symbol ?? null;
  const inSym  = h.tokenIn ?? null;

  // Row 1 right: + received amount OR score (no amounts for old / non-Jupiter entries)
  const row1Right = hasAmounts && h.amountOut != null
    ? `<span style="font-size:var(--fs-sm);font-weight:700;color:#14F195;font-family:'Space Mono',monospace;white-space:nowrap">+ ${_fmtAmt(h.amountOut, outSym)}</span>`
    : `<span style="font-size:var(--fs-sm);font-weight:700;color:${color};font-family:'Space Mono',monospace">${h.score != null ? h.score + '/100' : '—'}</span>`;

  // Row 2 right: - spent amount OR token symbol
  const row2Right = hasAmounts && h.amountIn != null
    ? `<span style="font-size:var(--fs-sm);font-weight:700;color:#E8E8F0;font-family:'Space Mono',monospace;white-space:nowrap">- ${_fmtAmt(h.amountIn, inSym ?? '?')}</span>`
    : `<span style="font-size:var(--fs-xs);font-weight:700;color:#E8E8F0">${outSym ? escHtml(outSym) : '—'}</span>`;

  // ── Cancelled-swap extra rows ─────────────────────────────────────────────
  // "Avoided spending" — how much the user did NOT send
  let avoidedSpendRow = '';
  if (dec === 'cancel') {
    // Prefer USD value, then SOL amount (pump.fun), then token amount
    if (h.inUsdValue != null && h.inUsdValue > 0) {
      const _usd = Number(h.inUsdValue);
      const _fmt = _usd < 0.01 ? '< $0.01' : '$' + _usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      avoidedSpendRow = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:var(--fs-sm);color:#9B9BAD" title="Trade size that was not sent after you cancelled.">Avoided spending</span>
        <span style="font-size:var(--fs-sm);font-weight:700;color:#E8E8F0;white-space:nowrap">${escHtml(_fmt)}</span>
      </div>`;
    } else if (h.solAmountIn != null && h.solAmountIn > 0) {
      const _solFmt = Number(h.solAmountIn).toFixed(Number(h.solAmountIn) < 0.1 ? 4 : 2);
      avoidedSpendRow = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:var(--fs-sm);color:#9B9BAD" title="Trade size that was not sent after you cancelled.">Avoided spending</span>
        <span style="font-size:var(--fs-sm);font-weight:700;color:#E8E8F0;white-space:nowrap">${escHtml(_solFmt)} SOL</span>
      </div>`;
    } else if (hasAmounts && h.amountIn != null) {
      avoidedSpendRow = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:var(--fs-sm);color:#9B9BAD" title="Trade size that was not sent after you cancelled.">Avoided spending</span>
        <span style="font-size:var(--fs-sm);font-weight:700;color:#E8E8F0;white-space:nowrap">${_fmtAmt(h.amountIn, inSym ?? '?')}</span>
      </div>`;
    }
  }

  // "Risk avoided" — statistical loss estimate for HIGH/CRITICAL cancelled swaps
  // Uses probability of loss × trade size. Not shown for LOW/MEDIUM (noise) or when no trade size.
  let riskAvoidedRow = '';
  if (dec === 'cancel' && (lvl === 'HIGH' || lvl === 'CRITICAL')) {
    // Rug/loss probability by level: HIGH ~55%, CRITICAL ~80%
    // Average loss when it does happen: ~70% of trade value (typical pump-and-dump)
    const _rugProb  = lvl === 'CRITICAL' ? 0.80 : 0.55;
    const _lossFrac = 0.70;
    let _tradeUsd   = h.inUsdValue != null ? Number(h.inUsdValue) : null;
    if (_tradeUsd == null && h.solAmountIn != null) _tradeUsd = Number(h.solAmountIn) * 150; // ~SOL price proxy
    if (_tradeUsd != null && _tradeUsd > 0) {
      const _expLoss = _tradeUsd * _rugProb * _lossFrac;
      const _fmtLoss = _expLoss < 0.01 ? '< $0.01' : '~$' + _expLoss.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      riskAvoidedRow = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:var(--fs-sm);color:#9B9BAD;cursor:help" data-tip="Statistical expected savings from cancelling. ${lvl === 'CRITICAL' ? '~80%' : '~55%'} probability of losing ~70% of trade value on ${lvl === 'CRITICAL' ? 'Critical' : 'High'} risk tokens. Not a guarantee.">Est. savings</span>
        <span style="font-size:var(--fs-sm);font-weight:700;color:#14F195;white-space:nowrap">${escHtml(_fmtLoss)}</span>
      </div>`;
    }
  }

  // Quote Accuracy + Net vs Quote rows
  // quoteAccuracy: number 0–100 = real result, -1 = unavailable/exhausted, null = still polling
  const qAcc    = h.quoteAccuracy;
  const isFresh = (Date.now() - (h.ts ?? 0)) < 90_000; // only show pending… for ≤90s old entries
  const _qAccNum = qAcc != null ? Number(qAcc) : null;

  // When background stored -1 (no quotedRawOut at intercept time), try to derive from actualOut
  let derivedAcc = null;
  if (_qAccNum === -1 && h.actualOut != null) {
    const _qBase = parseFloat(h.quotedOut ?? h.amountOut ?? 0);
    if (_qBase > 0) derivedAcc = Math.min(100, (parseFloat(h.actualOut) / _qBase) * 100);
  }
  const _displayAcc = (_qAccNum != null && _qAccNum > 0) ? _qAccNum : derivedAcc;
  const accColor = _displayAcc != null && _displayAcc >= 99 ? '#14F195' : '#FFB547';

  // Net vs quote row — shown whenever we have a displayable accuracy
  let netRow = '';
  if (_displayAcc != null) {
    const _qtdRaw = h.quotedOut ?? h.amountOut;
    const _qtd = _qtdRaw != null ? parseFloat(_qtdRaw) : null;
    if (_qtd != null && isFinite(_qtd) && _qtd > 0) {
      const _diff = h.actualOut != null
        ? parseFloat(h.actualOut) - _qtd          // precise: stored value
        : _qtd * (_displayAcc / 100 - 1);         // derived: accuracy × quoted
      if (isFinite(_diff)) {
        const _dc  = _diff > 0 ? '#14F195' : _diff < 0 ? '#FFB547' : '#9B9BAD';
        const _ds  = _diff > 0 ? '+' : _diff < 0 ? '\u2212' : '';
        netRow = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-size:var(--fs-sm);color:#9B9BAD" title="Difference between actual tokens received on-chain and the quoted amount.">Net vs quote</span>
          <span style="font-size:var(--fs-sm);font-weight:700;color:${_dc};white-space:nowrap">${_ds}${_fmtAmt(Math.abs(_diff), outSym ?? '')}</span>
        </div>`;
      }
    }
  }

  // Four states: real/derived result | still polling (null, fresh, has sig) | truly unavailable (-1) | old/no data → hide
  const accRow = (_displayAcc != null)
    ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:var(--fs-sm);color:#9B9BAD" title="Actual tokens received on-chain vs the quoted amount at swap time.">Quote Accuracy \u2713</span>
        <span style="font-size:var(--fs-sm);font-weight:700;color:${accColor}">${_displayAcc.toFixed(2)}%</span>
       </div>`
    : (qAcc == null && h.signature && isFresh
        ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:var(--fs-sm);color:#9B9BAD">Quote Accuracy</span>
            <span style="font-size:var(--fs-sm);color:var(--muted)">pending\u2026</span>
           </div>`
        : (_qAccNum === -1
            ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                <span style="font-size:var(--fs-sm);color:#9B9BAD">Quote Accuracy</span>
                <span style="font-size:var(--fs-sm);color:var(--muted)">\u2014</span>
               </div>`
            : ''));

  // ── Risk factor tooltip (shown on hover over risk badge) ─────────────────
  let factorTip = '';
  if (Array.isArray(h.factors) && h.factors.length > 0) {
    const _SEV_ORD = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const _sorted  = h.factors.slice().sort((a, b) =>
      (_SEV_ORD[a.severity] ?? 9) - (_SEV_ORD[b.severity] ?? 9)
    );
    factorTip = `Risk score: ${h.score ?? '?'}/100 · ${lvlLabel}\n\n` +
      _sorted.map(f => `[${f.severity}] ${f.name}${f.detail ? ' — ' + f.detail : ''}`).join('\n');
  }

  // Solscan row (only when signature captured)
  const solscanRow = h.signature
    ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">
        <a href="https://solscan.io/tx/${escAttr(h.signature)}" target="_blank"
           style="font-size:var(--fs-sm);color:#14F195;text-decoration:none">View on Solscan ↗</a>
        <span style="font-size:var(--fs-sm);color:var(--muted)">${ago}</span>
       </div>`
    : `<div style="display:flex;justify-content:flex-end;margin-top:4px">
        <span style="font-size:var(--fs-sm);color:var(--muted)">${ago}</span>
       </div>`;

  return `
    <div style="padding:9px 11px;border-radius:9px;border:1px solid ${border};background:${cardBg};margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
        <span style="font-size:var(--fs-base);font-weight:700;color:#E8E8F0">Scanned
          <span style="font-size:var(--fs-xs);font-weight:700;background:${color}1A;border:1px solid ${color}40;color:${color};border-radius:10px;padding:1px 6px;vertical-align:middle;margin-left:3px${factorTip ? ';cursor:help' : ''}"${factorTip ? ` data-tip="${escAttr(factorTip)}"` : ''}>${escHtml(lvlLabel)}</span>
          <span style="font-size:var(--fs-xs);font-weight:700;padding:1px 6px;border-radius:8px;background:${decBg};color:${decColor};vertical-align:middle;margin-left:3px">${decLabel}</span>
        </span>
        ${row1Right}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:var(--fs-base);color:#9B9BAD">${routeLabel}</span>
        ${row2Right}
      </div>
      ${avoidedSpendRow}
      ${riskAvoidedRow}
      ${netRow}
      ${accRow}
      ${solscanRow}
    </div>
  `;
}

function _shortSite(host) {
  if (host.includes('jup.ag'))   return 'Jupiter';
  if (host.includes('raydium'))  return 'Raydium';
  if (host.includes('pump.fun')) return 'Pump.fun';
  return host.replace(/^www\./, '').split('.')[0] || host;
}
