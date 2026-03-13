/**
 * ZendIQ Lite — popup.js
 * Tab controller + shared popup utilities.
 */

// Sync footer version from manifest so it is never out of date
document.getElementById('footer-version').textContent =
  'v' + chrome.runtime.getManifest().version;

// ── Shared utilities (global so tab modules can use them) ────────────────────
function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function levelLabel(l) {
  return { LOW: 'Low Risk', MEDIUM: 'Moderate Risk', HIGH: 'High Risk', CRITICAL: 'Critical Risk' }[l] ?? (l || '—');
}

function fmtTs(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// Wallet pubkey read from storage (set by page-wallet.js → bridge → storage)
let walletPubkey = null;

// ── Main ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  'use strict';

  // Initialise scoring engine (for popup-side token scans in the Security tab)
  initScoring({ rpcCall, jsonFetch });

  // Read wallet pubkey, then seed security badge colour + auto-trigger scan
  chrome.storage.local.get(['zqlite_wallet_pubkey'], ({ zqlite_wallet_pubkey }) => {
    walletPubkey = zqlite_wallet_pubkey ?? null;
    initSecurityBadge(); // colours the Wallet tab icon; triggers scan if wallet detected
  });

  // ── Tab switching ─────────────────────────────────────────────────────────
  const tabBtns  = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');
  let _activeTab = 'monitor';

  function showTab(name) {
    _activeTab = name;
    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    tabPanels.forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    // Lazy-load each tab on first open
    if (name === 'monitor')  loadMonitor();
    if (name === 'security') loadSecurity();
    if (name === 'history')  loadHistory();
    if (name === 'settings') loadSettings();
  }

  tabBtns.forEach(btn => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

  // ── Initial load ──────────────────────────────────────────────────────────
  showTab('monitor');

  // ── Live storage updates (e.g. new scan from content script) ─────────────
  chrome.storage.onChanged.addListener((changes) => {
    if (_activeTab === 'monitor'  && (changes.zqlite_current_scan || changes.zqlite_settings)) loadMonitor();
    if (_activeTab === 'history'  && changes.zqlite_swap_history) loadHistory();
    // Wallet pubkey saved by page-wallet.js — trigger security scan if wallet tab is open
    if (changes.zqlite_wallet_pubkey?.newValue) {
      walletPubkey = changes.zqlite_wallet_pubkey.newValue;
      if (_activeTab === 'security') loadSecurity();
    }
    // Use refreshSecurityDisplay (display-only, no re-scan) to avoid the scan→save→onChanged loop
    if (changes.secLastResult && changes.secLastResult.newValue) {
      refreshSecurityDisplay(changes.secLastResult.newValue);
    } else if (_activeTab === 'security' && Object.keys(changes).some(k => k.startsWith('secReviewed_'))) {
      loadSecurity();
    }
  });
});
