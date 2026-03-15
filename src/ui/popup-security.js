/**
 * ZendIQ Lite — popup-security.js
 * Wallet Security Checker — popup panel.
 *
 * Mirrors the Pro implementation exactly: same rendering, scoring, tooltip system,
 * switch/slider toggle, revoke.cash link, tab-icon colouring.
 *
 * Differences from Pro:
 *   - Uses rpcCall() (from src/utils/rpc.js) instead of popupRpcCall()
 *   - Entry point is loadSecurity() (called by popup.js tab controller)
 *   - Wallet pubkey stored at 'zqlite_wallet_pubkey' storage key
 */

// ── Known drain / malicious delegate contracts ──────────────────────────────
const DRAIN_CONTRACTS = new Set([
  '3CCLniuEGnMBWbE3FQiRQEhDGSRUnfFBWX9eV8GiJgJ2',
  'BVVdBbGmtMqDhFNpRKCBMCDmqD6a8NNvjFE6czHGJT5E',
  'GcF8pREjdFbXr4h4sMXNNNyicP2A9QN6LWsPpKMVADep',
  '9DtmUXVZhEFPGq6CQRS4RBfMkNDqVwVumtBXo3HLPF7w',
  'FGbGTPJLsLEBJW4JnK8gNqUQRiDkdQAaTfqG6G5PkR7o',
  '5sJqX3GhmdmfJC4uqoT3ZGagKByVSYo9CqTvWuLK8aCj',
  '8W8XSFxXc4RAUXCq8AyjC2k7YZ7Q6zY3GAnG2RqAqbdB',
  'AXEfAFqk4uqzC6Gy6SzZCfEJz8RKf8HnHqE8uoXYPyNZ',
  'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsRUe9efou',
  '4xQwteRzMPKJM1FS1H4fxVcLaGJy8W8PvbVTEm3XXTXB',
  '6Y5ynC3v6F8i5PHN8SfJg9JbNrjxqBmKfQdqZ7dBDVy4',
]);

const UNLIMITED_THRESHOLD = 1_000_000_000_000_000; // effective unlimited

// ── State ────────────────────────────────────────────────────────────────────
let _secResult           = null;  // last scan result
let _secChecking         = false; // scan in progress
let _secWalletMissing    = false; // re-check attempted without jup.ag open
let _reviewedAutoApprove = false; // user confirmed they checked wallet auto-approve settings
let _lastKnownTabColor   = '';    // preserved across scans to avoid flash

// ── Tab colour badge ─────────────────────────────────────────────────────────
// Colours only the SVG icon — not the "Wallet" text label.
// During a rescan we keep the last known colour so the icon does not flash amber.
function _updateSecurityTabColor() {
  const btn = document.getElementById('tab-security');
  if (!btn) return;
  let color = 'var(--orange)'; // amber default — no scan yet
  if (_secChecking) {
    color = _lastKnownTabColor || 'var(--orange)';
  } else if (_secResult) {
    const { score: rawScore, autoApproveDeduction = 0 } = _secResult;
    const ds = rawScore == null ? null
      : Math.max(0, rawScore - (_reviewedAutoApprove ? 0 : autoApproveDeduction));
    if      (ds == null) color = '';
    else if (ds === 100) color = 'var(--green)';
    else if (ds >= 80)   color = 'var(--orange)';
    else if (ds >= 60)   color = '#FF6B00';
    else                 color = 'var(--danger)';
    _lastKnownTabColor = color;
  }
  const svg = btn.querySelector('svg');
  if (svg) svg.style.color = color;
  btn.style.color = '';
  btn.style.borderBottomColor = btn.classList.contains('active') ? color : '';
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderSecurityPanel() {
  _updateSecurityTabColor();

  const panel = document.getElementById('panel-security');
  if (!panel) return;

  const esc     = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = s => esc(s).replace(/"/g, '&quot;');

  // ── State 1: scanning with no prior result ─────────────────────────────────
  if (_secChecking && !_secResult) {
    panel.innerHTML = `
      <div class="section" style="text-align:center;padding:28px 16px">
        <div style="font-size:12px;color:var(--muted);animation:secPulse 1.2s ease-in-out infinite;margin-bottom:6px">Scanning on-chain approvals…</div>
        <div style="font-size:10px;color:var(--muted)">Checking SPL Token &amp; Token-2022 programs</div>
      </div>`;
    return;
  }

  // ── State 2: no result yet ─────────────────────────────────────────────────
  if (!_secResult) {
    panel.innerHTML = `
      <div class="section">
        <div class="section-title">Wallet Security Check</div>
        ${walletPubkey ? `
        <p style="font-size:11px;color:var(--muted);line-height:1.65;margin-bottom:14px">
          ZendIQ scans your wallet for <strong style="color:var(--text)">unlimited token approvals</strong>,
          known drain contracts, and wallet-specific risks.<br><br>
          All checks are read-only queries against your <strong style="color:var(--text)">public wallet address</strong>.
          ZendIQ never has access to your <strong style="color:var(--green)">private key</strong> or seed phrase.
        </p>
        <button id="sec-run-btn" class="btn-q">🔒 Run Security Check</button>` : ''}
        ${!walletPubkey ? `
        <div style="margin-top:12px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);font-size:10.5px;color:var(--muted);line-height:1.7">
          <div style="font-weight:700;color:var(--text);margin-bottom:5px">How to enable the wallet scan:</div>
          <div style="margin-bottom:4px">1. Open <a href="https://jup.ag" target="_blank" rel="noopener" style="color:var(--purple);font-weight:700;text-decoration:none">jup.ag</a>, <a href="https://raydium.io" target="_blank" rel="noopener" style="color:var(--purple);font-weight:700;text-decoration:none">raydium.io</a>, or pump.fun and connect your wallet.</div>
          <div style="margin-bottom:4px">2. ZendIQ reads your <strong style="color:var(--text)">public address</strong> from the page — no wallet added to ZendIQ.</div>
          <div>3. Return here and click <strong style="color:var(--text)">Run Security Check</strong>.</div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);font-size:10px;color:var(--text)">
            <span style="color:var(--green)">✓</span> <strong>Your private key and seed phrase are never read or stored by ZendIQ.</strong>
          </div>
        </div>` : ''}
      </div>`;
    document.getElementById('sec-run-btn')?.addEventListener('click', runCheck);
    return;
  }

  // ── State 3: result available ──────────────────────────────────────────────
  const {
    score: rawScore, autoApproveDeduction = 0, checkedAt,
    unlimitedApprovals = [], badContracts = [], findings = [],
    totalAccounts, walletType, pubkey: resultPubkey,
  } = _secResult;

  const displayScore = rawScore == null ? null
    : Math.max(0, rawScore - (_reviewedAutoApprove ? 0 : autoApproveDeduction));

  const scoreColor = displayScore == null ? 'var(--muted)'
    : displayScore === 100 ? 'var(--green)'
    : displayScore >= 80   ? 'var(--orange)'
    : displayScore >= 60   ? '#FF6B00'
    : 'var(--danger)';
  const scoreLabel = displayScore == null ? 'Unknown'
    : displayScore === 100 ? 'Secure'
    : displayScore >= 80   ? 'Review'
    : displayScore >= 60   ? 'At Risk'
    : 'Critical';

  const _s    = checkedAt ? Math.round((Date.now() - checkedAt) / 1000) : null;
  const timeAgo = _s == null ? '' : _s < 60 ? `${_s}s ago` : _s < 3600 ? `${Math.round(_s / 60)}m ago` : `${Math.round(_s / 3600)}h ago`;

  const sevColor = { CRITICAL: 'var(--danger)', HIGH: '#FF6B00', WARN: 'var(--orange)', OK: 'var(--green)' };
  const sevIcon  = { CRITICAL: '⛔', HIGH: '⚠', WARN: '⚠', OK: '✓' };

  const revokeLink = unlimitedApprovals.length > 0
    ? `<a href="https://revoke.cash" target="_blank" rel="noopener" class="sec-revoke-link">
        🔗 Review &amp; revoke at revoke.cash →
       </a>`
    : '';

  const pubkey = resultPubkey ?? walletPubkey ?? '';
  const walletTypeFmt = walletType && walletType !== 'unknown'
    ? walletType.charAt(0).toUpperCase() + walletType.slice(1)
    : null;

  // Wallet address bar — "hooked wallet" UI
  const walletBar = pubkey ? `
    <div class="wallet-bar">
      ${walletTypeFmt ? `<span class="wallet-type-badge">${esc(walletTypeFmt)}</span>` : ''}
      <span class="wallet-addr">${esc(pubkey.slice(0, 6))}…${esc(pubkey.slice(-4))}</span>
      <a href="https://solscan.io/account/${encodeURIComponent(pubkey)}" target="_blank" rel="noopener" class="wallet-link" title="View on Solscan">↗</a>
    </div>` : '';

  // Split findings: reviewable (auto-approve warning) near top, rest below
  const reviewableFinding  = findings.find(f => f.reviewable);
  const otherFindings      = findings.filter(f => !f.reviewable);

  const renderFinding = (f) => {
    const isReviewed = f.reviewable && _reviewedAutoApprove;
    const textColor  = f.reviewable
      ? (_reviewedAutoApprove ? 'var(--green)' : 'var(--orange)')
      : (sevColor[f.severity] ?? 'var(--text)');

    const reviewToggle = f.reviewable
      ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;padding:6px 10px;border-radius:7px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06)">
          <span style="font-size:10px;font-weight:600;color:${_reviewedAutoApprove ? 'var(--green)' : 'var(--orange)'}">I've disabled unsafe wallet settings</span>
          <label class="switch" title="${_reviewedAutoApprove ? 'Click to un-mark' : 'Check this once you have disabled auto-approve and removed unrecognised connected apps'}" style="flex-shrink:0">
            <input type="checkbox" id="sec-reviewed-toggle" ${_reviewedAutoApprove ? 'checked' : ''}>
            <span class="slider slider-amber"></span>
          </label>
        </div>`
      : '';

    // When reviewed: collapse to a single toggle row
    if (isReviewed) {
      const tipAttrR = f.tooltip ? ` data-tip="${escAttr(f.tooltip)}" style="cursor:help"` : '';
      return `
    <div class="sec-finding"${tipAttrR}>
      <span class="sec-finding-icon" style="color:var(--green)">✓</span>
      <div style="flex:1">${reviewToggle}</div>
    </div>`;
    }

    const stepsHtml = f.steps
      ? `<div style="margin-top:6px;padding:7px 10px;border-radius:6px;background:rgba(153,69,255,0.07);border:1px solid rgba(153,69,255,0.18)">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:0.7px;color:var(--purple);font-weight:700;margin-bottom:4px">Steps inside your wallet</div>
          <div style="font-size:10.5px;color:var(--text);line-height:1.55">${esc(f.steps)}</div>
        </div>`
      : '';

    const tipAttr   = f.tooltip ? ` data-tip="${escAttr(f.tooltip)}"` : '';
    const tipCursor = f.tooltip ? ' style="cursor:help"' : '';

    return `
    <div class="sec-finding"${tipAttr}${tipCursor}>
      <span class="sec-finding-icon" style="color:${sevColor[f.severity] ?? 'var(--muted)'}">${sevIcon[f.severity] ?? '·'}</span>
      <div style="flex:1">
        <div style="font-size:11px;font-weight:600;color:${textColor}">${esc(f.text)}</div>
        ${f.detail ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">${esc(f.detail)}</div>` : ''}
        ${stepsHtml}
        ${reviewToggle}
      </div>
    </div>`;
  };

  const reviewableHtml    = reviewableFinding ? renderFinding(reviewableFinding) : '';
  const otherFindingsHtml = otherFindings.map(renderFinding).join('');

  panel.innerHTML = `
    ${walletBar}
    ${_secWalletMissing ? `
    <div style="margin:0 0 10px;padding:8px 12px;border-radius:7px;background:rgba(255,181,71,0.08);border:1px solid rgba(255,181,71,0.25);font-size:10.5px;color:var(--orange);line-height:1.6">
      ⚠ Open <a href="https://jup.ag" target="_blank" rel="noopener" style="color:var(--orange);font-weight:700;text-decoration:underline">jup.ag</a>, <a href="https://raydium.io" target="_blank" rel="noopener" style="color:var(--orange);font-weight:700;text-decoration:underline">raydium.io</a>, or pump.fun and connect your wallet, then click Re-check.
    </div>` : ''}
    <div class="section">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px">
        <div>
          <div class="section-title" title="Score = 100 minus deductions: −30 per known drainer (max −60), −20 per unlimited approval (max −40), −20 if wallet auto-approve not reviewed." style="cursor:help">Wallet Security Score</div>
          <div style="cursor:help" data-tip="Score starts at 100. Deductions: −30 per known drainer (max −60), −20 per unlimited approval (max −40), −20 if wallet settings unreviewed. 100 = Secure · 80–99 = Review · 60–79 = At Risk · below 60 = Critical.">
            <div style="display:flex;align-items:baseline;gap:5px">
              <span style="font-size:32px;font-weight:900;color:${scoreColor};font-family:'Space Mono',monospace;line-height:1">${displayScore ?? '—'}</span>
              <span style="font-size:13px;font-weight:700;color:${scoreColor}">${scoreLabel}</span>
            </div>
            ${timeAgo ? `<div style="font-size:9px;color:var(--muted);margin-top:2px">Scanned ${esc(timeAgo)}</div>` : ''}
          </div>
        </div>
        <button id="sec-run-btn" class="btn-q" title="Re-scan all token accounts on-chain for active unlimited approvals and known drainer contracts" style="width:auto;padding:7px 12px;margin:0;font-size:10px;flex-shrink:0" ${_secChecking ? 'disabled' : ''}>
          ${_secChecking ? 'Scanning…' : '↺ Re-check'}
        </button>
      </div>
      ${reviewableHtml}
    </div>

    <div class="section" style="border-bottom:none">
      <div class="section-title" title="Each finding describes a specific risk detected in your wallet. Hover over individual findings for a full explanation." style="cursor:help">Other Findings</div>
      ${otherFindingsHtml}
      ${revokeLink}
      <div style="margin-top:10px;font-size:10px;color:var(--muted);line-height:1.7">
        <span style="color:var(--green)">✓</span> ZendIQ never reads or stores your private key or seed phrase. &nbsp;
        <a href="https://revoke.cash" target="_blank" rel="noopener" style="color:var(--purple);text-decoration:none">revoke.cash</a> is a trusted third-party tool.
      </div>
    </div>
    <div id="sec-float-tip" style="display:none;position:fixed;z-index:9999;max-width:240px;padding:9px 12px;border-radius:8px;background:#13131F;border:1px solid rgba(255,255,255,0.13);font-size:10.5px;color:#C8C8D8;line-height:1.65;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,0.6)"></div>`;

  // ── Wire up all interactive elements after innerHTML ───────────────────────
  document.getElementById('sec-run-btn')?.addEventListener('click', () => {
    if (!_secChecking) runCheck();
  });

  document.getElementById('sec-reviewed-toggle')?.addEventListener('change', (e) => {
    const walletTyp = _secResult?.walletType ?? 'unknown';
    _reviewedAutoApprove = e.target.checked;
    const key = `secReviewed_${walletTyp}`;
    if (_reviewedAutoApprove) chrome.storage.local.set({ [key]: true });
    else chrome.storage.local.remove(key);
    renderSecurityPanel();
  });

  // Floating tooltip — follows mouse on any [data-tip] element
  const floatTip = panel.querySelector('#sec-float-tip');
  if (floatTip) {
    panel.querySelectorAll('[data-tip]').forEach(el => {
      el.addEventListener('mouseenter', () => {
        floatTip.textContent = el.dataset.tip;
        floatTip.style.display = 'block';
      });
      el.addEventListener('mousemove', e => {
        const tipH = floatTip.offsetHeight;
        const tipW = floatTip.offsetWidth || 244;
        const x    = Math.min(e.clientX + 12, window.innerWidth - tipW - 8);
        const y    = (window.innerHeight - e.clientY) < (tipH + 24)
                     ? e.clientY - tipH - 8
                     : e.clientY + 16;
        floatTip.style.left = Math.max(4, x) + 'px';
        floatTip.style.top  = Math.max(4, y) + 'px';
      });
      el.addEventListener('mouseleave', () => { floatTip.style.display = 'none'; });
    });
  }
}

// ── Run scan ──────────────────────────────────────────────────────────────────
async function runCheck() {
  if (_secChecking) return;

  // Refresh pubkey fresh from storage before each scan
  const latest = await new Promise(res => chrome.storage.local.get(['zqlite_wallet_pubkey'], res));
  walletPubkey = latest.zqlite_wallet_pubkey ?? walletPubkey ?? null;

  // If not in storage yet, inject directly into the active jup.ag tab to detect it
  // (same approach as Pro version — reliable even before content script saves pubkey)
  if (!walletPubkey) {
    try {
      const jTabs = await new Promise(res =>
        chrome.tabs.query({ url: [
          '*://jup.ag/*', '*://*.jup.ag/*',
          '*://raydium.io/*', '*://*.raydium.io/*',
          '*://pump.fun/*', '*://*.pump.fun/*',
        ] }, ts => res(ts ?? []))
      );
      if (jTabs.length) {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: jTabs[0].id },
          world: 'MAIN',
          func: () => {
            try {
              const getPk = w => {
                const pk = w?.publicKey;
                if (!pk) return null;
                const s = typeof pk === 'string' ? pk : (pk?.toBase58?.() ?? pk?.toString?.());
                return (s && s.length >= 32) ? s : null;
              };
              for (const w of [
                window.phantom?.solana, window.solflare, window.backpack?.solana,
                window.jupiterWallet, window.jupiter?.solana, window.solana,
              ].filter(Boolean)) {
                const s = getPk(w);
                if (s) return s;
              }
              // Wallet Standard probe
              const found = [];
              window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
                detail: { register(w) { found.push(w); } },
              }));
              for (const w of found) {
                for (const acc of (w?.accounts ?? [])) {
                  const a = acc?.address ?? acc?.publicKey?.toString?.();
                  if (a && a.length >= 32) return String(a);
                }
              }
            } catch (_) {}
            return null;
          },
        });
        const detected = r?.result;
        if (detected) {
          walletPubkey = detected;
          chrome.storage.local.set({ zqlite_wallet_pubkey: detected });
        }
      }
    } catch (_) {}
  }

  const pubkey = walletPubkey;

  if (!pubkey) {
    if (_secResult && _secResult.score != null) {
      _secWalletMissing = true;
      renderSecurityPanel();
      return;
    }
    _secResult = {
      score: null, checkedAt: Date.now(), pubkey: null, walletType: 'unknown',
      totalAccounts: 0, unlimitedApprovals: [], badContracts: [], autoApproveDeduction: 0,
      findings: [{ severity: 'WARN', text: 'No wallet detected', detail: 'Connect your wallet on Jupiter, Raydium, or Pump.fun — ZendIQ will detect the public address automatically.' }],
    };
    renderSecurityPanel();
    return;
  }

  _secWalletMissing = false;
  _secChecking = true;
  renderSecurityPanel();

  const findings      = [];
  let   unlimitedList = [];
  let   knownBadList  = [];
  let   totalAccounts = 0;

  try {
    const PROGRAMS = [
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    ];
    let allAccounts = [];
    for (const programId of PROGRAMS) {
      try {
        const resp  = await rpcCall('getTokenAccountsByOwner', [pubkey, { programId }, { encoding: 'jsonParsed' }]);
        const value = resp?.result?.value ?? [];
        allAccounts = allAccounts.concat(value);
      } catch (_) { /* one program failing is OK */ }
    }
    totalAccounts = allAccounts.length;

    for (const acct of allAccounts) {
      const info = acct?.account?.data?.parsed?.info;
      if (!info) continue;
      const { delegate, delegatedAmount, mint } = info;
      if (!delegate) continue;
      const delegatedRaw = Number(delegatedAmount?.amount ?? 0);
      if (delegatedRaw < UNLIMITED_THRESHOLD) continue;
      const entry = { delegate, mint: mint ?? 'Unknown', delegatedRaw };
      unlimitedList.push(entry);
      if (DRAIN_CONTRACTS.has(delegate)) knownBadList.push(entry);
    }

    const unknownUnlimited = unlimitedList.length - knownBadList.length;
    let rawScore = 100;
    rawScore -= Math.min(knownBadList.length * 30, 60);
    rawScore -= Math.min(unknownUnlimited    * 20, 40);
    rawScore  = Math.max(0, rawScore);
    const score = rawScore;

    if (knownBadList.length > 0) {
      findings.push({
        severity: 'CRITICAL',
        text:     `${knownBadList.length} known drainer contract${knownBadList.length > 1 ? 's' : ''} has token approval`,
        detail:   'Revoke immediately — these contracts are confirmed wallet drainers',
        tooltip:  'CRITICAL RISK: These contract addresses are in ZendIQ\'s known-drainer database. A wallet drainer is a smart contract deliberately designed to steal funds. It already has unlimited permission to move your tokens. Go to revoke.cash NOW and revoke all approvals to these addresses.',
      });
    }
    if (unknownUnlimited > 0) {
      findings.push({
        severity: 'HIGH',
        text:     `${unknownUnlimited} unlimited token approval${unknownUnlimited > 1 ? 's' : ''} active`,
        detail:   "Review and revoke any you don't recognise at revoke.cash",
        tooltip:  'HIGH RISK: You have given at least one contract unlimited permission to transfer your tokens. Even if legitimate today, this permission is retained forever unless revoked. Visit revoke.cash to review and revoke approvals you no longer need.',
      });
    }

    // Wallet-type-specific auto-approve warnings (per-wallet guidance)
    const AUTO_APPROVE_WARNINGS = {
      phantom: {
        text:    'Action required: check & disable Phantom auto-approve',
        detail:  'Disable auto-approve for all dApps — it lets sites sign transactions silently without a popup.',
        steps:   'Inside Phantom → click the ⚙️ Settings tab → Security & Privacy → Trusted Apps → review each entry and disable auto-approve.',
        tooltip: 'RISK: If Phantom auto-approve is enabled for a dApp, any malicious script on that site can silently sign transactions WITHOUT a confirmation popup. Go to Phantom → Settings → Security & Privacy → Trusted Apps, and remove or disable auto-approve for any entry you do not recognise.',
      },
      backpack: {
        text:    'Action required: check & disable Backpack transaction approvals',
        detail:  'Disable pre-approved dApps — they can sign transactions silently without a confirmation popup.',
        steps:   'Inside Backpack → Settings → Security → Transaction Approval → remove pre-approved dApps you no longer use.',
        tooltip: 'RISK: Backpack pre-approved dApps can sign transactions silently. A malicious or compromised site with pre-approval can drain your entire wallet without triggering a confirmation prompt. Regularly audit Settings → Security → Transaction Approval.',
      },
      solflare: {
        text:    'Action required: check & disable Solflare auto-sign sessions',
        detail:  'Disable active auto-sign sessions — they allow sites to submit transactions without your confirmation.',
        steps:   'Inside Solflare → Settings → Security → Auto-sign → revoke any sessions you do not actively need.',
        tooltip: 'RISK: Solflare auto-sign sessions allow a connected site to submit signed transactions at any time. A malicious site with an auto-sign session can drain your wallet silently. Revoke all sessions you do not actively need.',
      },
      glow: {
        text:    'Action required: check & disable Glow connected apps',
        detail:  'Disable signing rights for connected apps — they can submit transactions without a per-transaction popup.',
        steps:   'Inside Glow → Settings → Connected Apps → remove any apps with signing rights you no longer use.',
        tooltip: 'RISK: Connected apps in Glow that have signing rights can submit transactions without a per-transaction popup. If any connected app is malicious or compromised, it can drain your wallet.',
      },
      brave: {
        text:    'Action required: check & disable Brave Wallet dApp connections',
        detail:  'Disable authorised site connections — they can request transaction signatures at any time.',
        steps:   'Inside Brave → Crypto Wallets icon → Sites with access → revoke authorised dApps you no longer use.',
        tooltip: 'RISK: Sites with Brave Wallet access can request transaction signatures at any time. If an authorised site runs malicious code, it can drain your wallet. Remove access for any site you do not actively use.',
      },
      jupiter: {
        text:    'Action required: check & disable Jupiter Wallet auto-approve',
        detail:  'Disable Auto Approve and Skip Review — these bypass confirmation popups and are a drain risk.',
        steps:   'Inside Jupiter Wallet → click ⋮ (top right) → Manage Settings → Preferences: ensure Auto Approve = Disabled and Skip Review = Disabled → Security → Connected Apps → remove sites you no longer use.',
        tooltip: 'RISK: Jupiter Wallet has two bypass settings. "Auto Approve" silently signs transactions without a popup. "Skip Review" skips the transaction review screen. Either can be exploited by a malicious connected site to drain your wallet.',
      },
    };

    // Detect wallet type via page probe (scripting permission required)
    let detectedType = _secResult?.walletType ?? 'unknown';
    try {
      const tabs = await new Promise(res => chrome.tabs.query({ url: [
        '*://jup.ag/*', '*://*.jup.ag/*',
        '*://raydium.io/*', '*://*.raydium.io/*',
        '*://pump.fun/*', '*://*.pump.fun/*',
      ] }, ts => res(ts ?? [])));
      const [tab] = tabs;
      if (tab) {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (connectedPubkey) => {
            const nameToType = (name = '') => {
              name = name.toLowerCase();
              if (name.includes('jupiter'))  return 'jupiter';
              if (name.includes('backpack')) return 'backpack';
              if (name.includes('solflare')) return 'solflare';
              if (name.includes('glow'))     return 'glow';
              if (name.includes('phantom'))  return 'phantom';
              if (name.includes('coin98'))   return 'coin98';
              if (name.includes('brave'))    return 'brave';
              return null;
            };
            try {
              const found = [];
              window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
                detail: { register(w) { found.push(w); } },
              }));
              if (connectedPubkey) {
                for (const w of found) {
                  for (const acc of (w?.accounts ?? [])) {
                    const addr = acc?.address ?? acc?.publicKey?.toString?.();
                    if (addr === connectedPubkey) return nameToType(w.name) ?? 'unknown';
                  }
                }
              }
              for (const w of found) { const t = nameToType(w.name); if (t && t !== 'brave') return t; }
              for (const w of found) { const t = nameToType(w.name); if (t) return t; }
            } catch (_) {}
            if (window.phantom?.solana?.isPhantom)              return 'phantom';
            if (window.backpack?.solana || window.xnft?.solana) return 'backpack';
            if (window.solflare?.isSolflare)                    return 'solflare';
            if (window.solana?.isGlow)                          return 'glow';
            if (window.solana?.isBrave || window.braveSolana)   return 'brave';
            if (window.jupiterWallet || window.solana?.isJupiter) return 'jupiter';
            return 'unknown';
          },
          args: [pubkey],
        });
        detectedType = result?.result ?? detectedType;
      }
    } catch (_) { /* tab not found or scripting failed */ }

    const autoWarn = AUTO_APPROVE_WARNINGS[detectedType];
    if (autoWarn) findings.push({ severity: 'WARN', ...autoWarn, reviewable: true });

    // Load whether user already reviewed auto-approve for this wallet type
    _reviewedAutoApprove = false;
    try {
      const reviewedKey = `secReviewed_${detectedType}`;
      const storedReview = await new Promise(res => chrome.storage.local.get([reviewedKey], res));
      _reviewedAutoApprove = !!storedReview[reviewedKey];
    } catch (_) {}

    const autoApproveDeduction = autoWarn ? 20 : 0;

    if (!findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH')) {
      findings.unshift({
        severity: 'OK',
        text:     unlimitedList.length === 0
          ? '0 harmful accounts found'
          : `${unlimitedList.length} approval${unlimitedList.length > 1 ? 's' : ''} found — none match known drainers`,
        detail:   'Approval scan complete',
        tooltip:  'All SPL Token and Token-2022 program accounts were checked for active delegate approvals. None with unlimited amounts were found — no third-party contract currently has blanket permission to transfer your tokens. Continue practising good hygiene: revoke approvals after every interaction and review regularly.',
      });
    }

    _secResult = {
      score, rawScore, autoApproveDeduction,
      checkedAt: Date.now(), pubkey, walletType: detectedType,
      totalAccounts, unlimitedApprovals: unlimitedList,
      badContracts: knownBadList, findings,
    };
    chrome.storage.local.set({ secLastResult: _secResult });

  } catch (e) {
    _secResult = {
      score: null, checkedAt: Date.now(), pubkey, walletType: 'unknown',
      totalAccounts, unlimitedApprovals: [], badContracts: [], autoApproveDeduction: 0,
      findings: [{ severity: 'WARN', text: 'Security check failed', detail: e.message?.slice(0, 100) ?? 'Unknown error' }],
    };
  } finally {
    _secChecking = false;
    renderSecurityPanel();
  }
}

// ── Public: update display from stored result without triggering a scan ───────
// Called by popup.js storage-change handler so widget scans update popup instantly
// without triggering the re-scan loop.
function refreshSecurityDisplay(newResult) {
  if (!newResult || typeof newResult !== 'object') return;
  if (_secChecking) return;
  _secResult = newResult;
  const key = `secReviewed_${_secResult.walletType ?? 'unknown'}`;
  chrome.storage.local.get([key], (data) => {
    _reviewedAutoApprove = !!data[key];
    _updateSecurityTabColor();
    renderSecurityPanel();
  });
}

// ── Public: restore tab badge colour on every popup open ──────────────────────
function initSecurityBadge() {
  chrome.storage.local.get(['secLastResult'], ({ secLastResult }) => {
    if (secLastResult) {
      _secResult = secLastResult;
      const key = `secReviewed_${_secResult.walletType ?? 'unknown'}`;
      chrome.storage.local.get([key], (data) => {
        _reviewedAutoApprove = !!data[key];
        _updateSecurityTabColor(); // seeds _lastKnownTabColor before scan starts
        if (!_secChecking) runCheck(); // always try — runCheck() will detect pubkey via page injection
      });
    } else {
      if (!_secChecking) runCheck(); // always try — runCheck() will detect pubkey via page injection
    }
  });
}

// ── Public: called by popup.js when the Security (Wallet) tab is opened ───────
function loadSecurity() {  // Auto-trigger scan when tab is opened and no result exists yet
  if (!_secResult && !_secChecking) {
    runCheck();
    return;
  }  if (_secResult?.walletType && _secResult.walletType !== 'unknown') {
    chrome.storage.local.get([`secReviewed_${_secResult.walletType}`], (data) => {
      _reviewedAutoApprove = !!data[`secReviewed_${_secResult.walletType}`];
      renderSecurityPanel();
    });
  } else {
    renderSecurityPanel();
  }
}
