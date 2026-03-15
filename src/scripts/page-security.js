/**
 * ZendIQ Lite — page-security.js
 * Wallet Security Checker. Runs in MAIN world.
 * Identical logic to Pro version but adapted to window.__zqlite namespace.
 * No widget rendering — results are persisted via bridge.js for popup to display.
 */
(function () {
  'use strict';
  const ns = window.__zqlite;
  if (!ns) return;

  const KNOWN_DRAIN_CONTRACTS = new Set([
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
    'TokenkegDrainXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  ]);

  const UNLIMITED = 1_000_000_000_000_000;

  // ── detectWalletType ─────────────────────────────────────────────────────
  function detectWalletType() {
    try {
      if (window.phantom?.solana?.isPhantom || window.solana?.isPhantom)   return 'phantom';
      if (window.backpack?.solana || window.xnft?.solana)                  return 'backpack';
      if (window.solflare?.isSolflare || window.solana?.isSolflare)        return 'solflare';
      if (window.solana?.isGlow)                                            return 'glow';
      if (window.solana?.isBrave || window.braveSolana)                    return 'brave';
      if (window.solana?.isCoin98)                                          return 'coin98';
      if (window.jupiterWallet || window.solana?.isJupiter)                return 'jupiter';
      // Wallet Standard wallets (Jupiter, Coinbase, etc.) — detected via __zqlite._wsWallet
      const wsName = ns._wsWallet?.name ?? null;
      if (wsName) {
        const n = wsName.toLowerCase();
        if (n.includes('jupiter'))  return 'jupiter';
        if (n.includes('phantom'))  return 'phantom';
        if (n.includes('backpack')) return 'backpack';
        if (n.includes('solflare')) return 'solflare';
        if (n.includes('glow'))     return 'glow';
        if (n.includes('brave'))    return 'brave';
      }
      return 'unknown';
    } catch (_) { return 'unknown'; }
  }

  // ── runWalletSecurityCheck ───────────────────────────────────────────────
  async function runWalletSecurityCheck(pubkey) {
    const _pubkey = pubkey ?? ns.resolveWalletPubkey?.() ?? ns.walletPubkey;
    if (!_pubkey) {
      ns.walletSecurityResult = {
        score: null, error: 'Wallet not connected',
        findings: [{ severity: 'WARN', text: 'Connect your wallet to run a security check', detail: '' }],
        checkedAt: null, pubkey: null, unlimitedApprovals: [], badContracts: [], walletType: detectWalletType(),
      };
      return;
    }

    if (ns.walletSecurityChecking) return;
    ns.walletSecurityChecking = true;
    ns.walletSecurityResult = null;

    const findings = [];
    let score = 100, unlimitedList = [], knownBadList = [], totalAccounts = 0;

    try {
      const PROGRAMS = [
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      ];
      let allAccounts = [];
      for (const programId of PROGRAMS) {
        try {
          const resp  = await ns.rpcCall('getTokenAccountsByOwner', [_pubkey, { programId }, { encoding: 'jsonParsed' }]);
          allAccounts = allAccounts.concat(resp?.result?.value ?? []);
        } catch (_) {}
      }
      totalAccounts = allAccounts.length;

      for (const acct of allAccounts) {
        const info = acct?.account?.data?.parsed?.info;
        if (!info?.delegate) continue;
        const raw = Number(info.delegatedAmount?.amount ?? 0);
        if (raw < UNLIMITED) continue;
        const entry = { delegate: info.delegate, mint: info.mint ?? 'Unknown', delegatedRaw: raw };
        unlimitedList.push(entry);
        if (KNOWN_DRAIN_CONTRACTS.has(info.delegate)) knownBadList.push(entry);
      }

      const unknownUnlim = unlimitedList.length - knownBadList.length;
      score -= Math.min(knownBadList.length * 30, 60);
      score -= Math.min(unknownUnlim * 20, 40);
      score  = Math.max(0, score);

      if (knownBadList.length > 0) {
        findings.push({ severity: 'CRITICAL', text: `${knownBadList.length} known drainer contract${knownBadList.length > 1 ? 's' : ''} has token approval`, detail: 'Revoke immediately — these contracts are confirmed wallet drainers' });
      }
      if (unknownUnlim > 0) {
        findings.push({ severity: 'HIGH', text: `${unknownUnlim} unlimited token approval${unknownUnlim > 1 ? 's' : ''} active`, detail: "Review and revoke any you don't recognise at revoke.cash" });
      }

      const walletType = detectWalletType();
      const AUTO_APPROVE_WARNINGS = {
        phantom:  { text: 'Action required: check & disable Phantom auto-approve', detail: 'Disable auto-approve for all dApps — it lets sites sign transactions silently without a popup.', steps: 'Phantom → Settings → Security & Privacy → Trusted Apps → disable auto-approve', tooltip: 'RISK: Auto-approve lets malicious scripts sign transactions without showing you a confirmation popup.', reviewable: true },
        backpack: { text: 'Action required: check & disable Backpack transaction approvals', detail: 'Disable pre-approved dApps — they can sign transactions silently without a confirmation popup.', steps: 'Backpack → Settings → Security → Transaction Approval → remove pre-approved dApps', tooltip: 'RISK: Pre-approved dApps can sign transactions silently and drain your wallet.', reviewable: true },
        jupiter:  { text: 'Action required: check & disable Jupiter Wallet auto-approve', detail: 'Disable Auto Approve and Skip Review — these bypass confirmation popups and are a drain risk.', steps: 'Jupiter Wallet → ⋮ (top right) → Manage Settings → Preferences: Auto Approve = Disabled, Skip Review = Disabled → Security → Connected Apps → remove unrecognised sites.', tooltip: 'RISK: Jupiter Wallet\'s "Auto Approve" silently signs transactions without a popup. "Skip Review" skips the transaction review screen. Either can be exploited by a malicious connected site.', reviewable: true },
        solflare: { text: 'Action required: check & disable Solflare auto-sign sessions', detail: 'Disable active auto-sign sessions — they allow sites to submit transactions without your confirmation.', steps: 'Solflare → Settings → Security → Auto-sign → revoke any sessions', tooltip: 'RISK: Auto-sign sessions let connected sites submit signed transactions at any time.', reviewable: true },
        glow:     { text: 'Action required: check & disable Glow connected apps', detail: 'Disable signing rights for connected apps — they can submit transactions without a per-transaction popup.', steps: 'Glow → Settings → Connected Apps → remove signing rights', tooltip: 'RISK: Apps with signing rights can submit transactions without a per-transaction popup.', reviewable: true },
        brave:    { text: 'Action required: check & disable Brave Wallet dApp connections', detail: 'Disable authorised site connections — they can request transaction signatures at any time.', steps: 'Brave → Crypto Wallets → Sites with access → revoke authorised dApps', tooltip: 'RISK: Authorised sites can request transaction signatures at any time.', reviewable: true },
      };
      const autoWarn = AUTO_APPROVE_WARNINGS[walletType];
      let autoApproveDeduction = 0;
      if (autoWarn) { findings.push({ severity: 'WARN', ...autoWarn }); autoApproveDeduction = 20; }

      if (!findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH')) {
        findings.unshift({ severity: 'OK', text: `${totalAccounts} accounts scanned — no harmful approvals found`, detail: 'Approval scan complete' });
      }

      ns.walletSecurityResult = { score, autoApproveDeduction, checkedAt: Date.now(), pubkey: _pubkey, walletType, totalAccounts, unlimitedApprovals: unlimitedList, badContracts: knownBadList, findings };
    } catch (e) {
      ns.walletSecurityResult = { score: null, checkedAt: Date.now(), pubkey: _pubkey, walletType: detectWalletType(), totalAccounts, unlimitedApprovals: [], badContracts: [], findings: [{ severity: 'WARN', text: 'Security check failed', detail: e.message?.slice(0, 100) ?? 'Unknown error' }], error: e.message };
    } finally {
      ns.walletSecurityChecking = false;
      const r = ns.walletSecurityResult;
      if (r) {
        window.postMessage({ type: 'ZQLITE_SAVE_SEC_RESULT', result: r }, '*');
        const wt = r.walletType;
        if (wt && wt !== 'unknown') window.postMessage({ type: 'ZQLITE_GET_SEC_REVIEWED', walletType: wt }, '*');
      }
    }
  }

  ns.runWalletSecurityCheck = runWalletSecurityCheck;
  ns.detectWalletType       = detectWalletType;
  if (ns.walletSecurityResult      === undefined) ns.walletSecurityResult      = null;
  if (ns.walletSecurityChecking    === undefined) ns.walletSecurityChecking    = false;
  if (ns.walletReviewedAutoApprove === undefined) ns.walletReviewedAutoApprove = false;
})();
