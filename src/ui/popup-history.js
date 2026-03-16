/**
 * ZendIQ Lite — popup-history.js
 * History tab: lists intercepted swaps with risk level + decision.
 */

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
          <div style="font-size:9.5px;margin-top:4px;color:var(--muted)">
            Open <a href="https://jup.ag" target="_blank" style="color:var(--purple)">jup.ag</a>
            and try a swap — ZendIQ Lite will log it here
          </div>
        </div>
      `;
      return;
    }

    const entries = hist.slice(0, 50).map(h => _histEntry(h)).join('');
    panel.innerHTML = `
      <div style="font-size:9px;color:var(--muted);margin-bottom:8px">
        ${hist.length} intercepted swap${hist.length !== 1 ? 's' : ''} · most recent first
      </div>
      <div style="max-height:340px;overflow-y:auto;padding-right:4px">${entries}</div>
      ${hist.length > 50 ? `<div style="font-size:9px;color:var(--muted);text-align:center;margin-top:4px">Showing 50 of ${hist.length}</div>` : ''}
    `;
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
    ? `<span style="font-size:12px;font-weight:700;color:#14F195;font-family:'Space Mono',monospace;white-space:nowrap">+ ${_fmtAmt(h.amountOut, outSym)}</span>`
    : `<span style="font-size:12px;font-weight:700;color:${color};font-family:'Space Mono',monospace">${h.score != null ? h.score + '/100' : '—'}</span>`;

  // Row 2 right: - spent amount OR token symbol
  const row2Right = hasAmounts && h.amountIn != null
    ? `<span style="font-size:12px;font-weight:700;color:#E8E8F0;font-family:'Space Mono',monospace;white-space:nowrap">- ${_fmtAmt(h.amountIn, inSym ?? '?')}</span>`
    : `<span style="font-size:11px;font-weight:700;color:#E8E8F0">${outSym ? escHtml(outSym) : '—'}</span>`;

  // Quote Accuracy + Net vs Quote rows
  // quoteAccuracy: number 0–100 = real result, -1 = unavailable/exhausted, null = still polling
  const qAcc    = h.quoteAccuracy;
  const isFresh = (Date.now() - (h.ts ?? 0)) < 90_000; // only show pending… for ≤90s old entries
  const _qAccNum = qAcc != null ? Number(qAcc) : null;
  const accColor = _qAccNum != null && _qAccNum >= 99 ? '#14F195' : '#FFB547';

  // Net vs quote row — always shown when accuracy is available and we can compute the diff
  let netRow = '';
  if (_qAccNum != null && _qAccNum > 0) {
    const _qtdRaw = h.quotedOut ?? h.amountOut;
    const _qtd = _qtdRaw != null ? parseFloat(_qtdRaw) : null;
    if (_qtd != null && isFinite(_qtd) && _qtd > 0) {
      const _diff = h.actualOut != null
        ? parseFloat(h.actualOut) - _qtd          // precise: stored value
        : _qtd * (_qAccNum / 100 - 1);            // derived: accuracy × quoted
      if (isFinite(_diff)) {
        const _dc  = _diff > 0 ? '#14F195' : _diff < 0 ? '#FFB547' : '#9B9BAD';
        const _ds  = _diff > 0 ? '+' : _diff < 0 ? '\u2212' : '';
        netRow = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-size:9.5px;color:#9B9BAD" title="Difference between actual tokens received on-chain and the quoted amount.">Net vs quote</span>
          <span style="font-size:9.5px;font-weight:700;color:${_dc};white-space:nowrap">${_ds}${_fmtAmt(Math.abs(_diff), outSym ?? '')}</span>
        </div>`;
      }
    }
  }

  // Three states: real result (>0) | still polling (null, fresh, has sig) | unavailable/old → hide
  const accRow = (_qAccNum != null && _qAccNum > 0)
    ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:9.5px;color:#9B9BAD" title="Actual tokens received on-chain vs the quoted amount at swap time.">Quote Accuracy \u2713</span>
        <span style="font-size:9.5px;font-weight:700;color:${accColor}">${_qAccNum.toFixed(2)}%</span>
       </div>`
    : (qAcc == null && h.signature && isFresh
        ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:9.5px;color:#9B9BAD">Quote Accuracy</span>
            <span style="font-size:9.5px;color:var(--muted)">pending\u2026</span>
           </div>`
        : '');

  // Solscan row (only when signature captured)
  const solscanRow = h.signature
    ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">
        <a href="https://solscan.io/tx/${escAttr(h.signature)}" target="_blank"
           style="font-size:9.5px;color:#14F195;text-decoration:none">View on Solscan ↗</a>
        <span style="font-size:9.5px;color:var(--muted)">${ago}</span>
       </div>`
    : `<div style="display:flex;justify-content:flex-end;margin-top:4px">
        <span style="font-size:9.5px;color:var(--muted)">${ago}</span>
       </div>`;

  return `
    <div style="padding:9px 11px;border-radius:9px;border:1px solid ${border};background:${cardBg};margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
        <span style="font-size:11px;font-weight:700;color:#E8E8F0">Scanned
          <span style="font-size:9px;font-weight:700;background:${color}1A;border:1px solid ${color}40;color:${color};border-radius:10px;padding:1px 6px;vertical-align:middle;margin-left:3px">${escHtml(lvlLabel)}</span>
          <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;background:${decBg};color:${decColor};vertical-align:middle;margin-left:3px">${decLabel}</span>
        </span>
        ${row1Right}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:11px;color:#9B9BAD">${routeLabel}</span>
        ${row2Right}
      </div>
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
