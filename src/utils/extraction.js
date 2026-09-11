/**
 * ZendIQ Lite – extraction.js
 *
 * getCreatorFromMint(mint) → string | null
 *   Returns the current mint authority as a quick deployer proxy.
 *   Fast (1 RPC call), but returns null when authority has been burned.
 *
 * getRealDeployer(mint) → string | null
 *   Returns the actual wallet that paid to create the mint — the real deployer.
 *   Works even after mint authority is burned.
 *   Method: fetch the oldest transaction for the mint address; the fee-payer
 *   (accountKeys[0]) of that tx is always the deployer.
 *   Cost: up to 2 RPC calls (getSignaturesForAddress + getTransaction).
 *
 * getDeployerTokenCount(deployerAddress, windowDays?) → number | null
 *   Returns how many distinct mint addresses the deployer has funded in the
 *   last `windowDays` days (default 30). A high count is the primary serial-
 *   rugger signal. null means the lookup failed — it does not mean zero.
 *   Method: getSignaturesForAddress on the deployer wallet, scan recent txns
 *   for InitializeMint instructions (programId = TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss624VQ5SDWKn
 *   or Token-2022). Caps at 200 signatures to stay within free RPC limits.
 *   Cost: 1–2 RPC calls.
 *
 * Routing: rpcCall() in rpc.js → background.js RPC_CALL → Solana RPC
 */

// SPL Token program IDs — used to identify InitializeMint transactions
const _SPL_TOKEN    = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss624VQ5SDWKn';
const _SPL_TOKEN_22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Must be >= the highest tx version mainnet can produce, or the RPC rejects the
// ENTIRE getTransaction call with -32015 — not just the versioned tx.
// v1 (SIMD-0296) activates at epoch 1035, 2026-09-15.
const MAX_TX_VERSION = 1;

// rpcCall is provided by page-config.js via window.__zqlite.rpcCall
function rpcCall(method, params) {
  return window.__zqlite.rpcCall(method, params);
}

async function getCreatorFromMint(mint) {
  if (!mint || typeof mint !== 'string') return null;
  try {
    const resp = await rpcCall('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const info = resp?.result?.value?.data?.parsed?.info;
    if (!info) return null;
    // Return mint authority (present = still active; null = burned).
    return info.mintAuthority ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * Returns the real deployer wallet — the fee-payer of the mint's oldest tx.
 * Falls back to getCreatorFromMint if signature history is unavailable.
 */
async function getRealDeployer(mint) {
  if (!mint || typeof mint !== 'string') return null;
  try {
    // Fetch oldest signature for this mint address (limit=1000, walk to the end)
    // Most mints have few signatures in their early life; we just need the last page.
    let before = undefined;
    let oldest = null;
    // Walk backwards until we run out of pages (max 3 pages × 1000 = 3000 sigs)
    for (let page = 0; page < 3; page++) {
      const params = [mint, { limit: 1000, ...(before ? { before } : {}) }];
      const resp = await rpcCall('getSignaturesForAddress', params);
      const sigs = resp?.result ?? [];
      if (!sigs.length) break;
      oldest = sigs[sigs.length - 1].signature;
      if (sigs.length < 1000) break; // reached the beginning
      before = oldest;
    }
    if (!oldest) return await getCreatorFromMint(mint);

    // Fetch that oldest transaction — fee-payer is accountKeys[0]
    const txResp = await rpcCall('getTransaction', [
      oldest,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: MAX_TX_VERSION },
    ]);
    const keys = txResp?.result?.transaction?.message?.staticAccountKeys
               ?? txResp?.result?.transaction?.message?.accountKeys
               ?? [];
    const deployer = typeof keys[0] === 'string' ? keys[0] : keys[0]?.pubkey ?? null;
    return deployer ?? await getCreatorFromMint(mint);
  } catch (_) {
    return await getCreatorFromMint(mint);
  }
}

/**
 * Returns the distinct mint addresses deployed by this wallet in the last `windowDays` days,
 * plus the total count. Uses jsonParsed encoding to extract `initializeMint` instructions
 * directly — avoids the imprecise proxy-key heuristic used previously.
 *
 * Returns { tokenCount: number|null, mints: string[], complete: boolean }.
 *   tokenCount === null → the lookup failed. This is NOT the same as zero, and callers
 *                         must not render it as "no previous tokens".
 *   complete === false  → some transactions could not be read, so the count is a lower bound.
 */
async function getDeployerTokenData(deployerAddress, windowDays = 30) {
  if (!deployerAddress || typeof deployerAddress !== 'string') {
    return { tokenCount: null, mints: [], complete: false };
  }
  try {
    const cutoff = Math.floor((Date.now() - windowDays * 24 * 3600 * 1000) / 1000);
    const resp = await rpcCall('getSignaturesForAddress', [deployerAddress, { limit: 200 }]);
    const recent = (resp?.result ?? []).filter(s => (s.blockTime ?? 0) >= cutoff);
    if (!recent.length) return { tokenCount: 0, mints: [], complete: true };

    // Fetch up to 50 txns with jsonParsed so we can read initializeMint instruction info.
    // Batches of 5: 50 simultaneous calls to a free public endpoint reliably rate-limit,
    // and every throttled call silently removes a mint from the count.
    const toCheck = recent.slice(0, 50);
    const txResps = [];
    for (let i = 0; i < toCheck.length; i += 5) {
      const batch = await Promise.all(
        toCheck.slice(i, i + 5).map(s =>
          rpcCall('getTransaction', [
            s.signature,
            { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: MAX_TX_VERSION },
          ]).catch(() => ({ _failed: true }))
        )
      );
      txResps.push(...batch);
    }

    const mints = [];
    const seen  = new Set();

    // Scan both outer and inner instructions for initializeMint calls.
    function _scanIxs(instructions) {
      for (const ix of (instructions ?? [])) {
        const pid = ix.programId ?? '';
        if (pid !== _SPL_TOKEN && pid !== _SPL_TOKEN_22) continue;
        const t = ix.parsed?.type ?? '';
        if (t === 'initializeMint' || t === 'initializeMint2') {
          const m = ix.parsed?.info?.mint;
          if (m && !seen.has(m)) { seen.add(m); mints.push(m); }
        }
      }
    }

    for (const r of txResps) {
      if (!r?.result) continue;
      _scanIxs(r.result.transaction?.message?.instructions);
      for (const inner of (r.result.meta?.innerInstructions ?? [])) {
        _scanIxs(inner.instructions);
      }
    }

    // A transport failure means we could not scan that tx at all. A `result: null`
    // (tx pruned from the endpoint's ledger) is an inherent limit of the method and
    // is present in healthy scans too, so it does not mark the result incomplete.
    const failed = txResps.filter(r => r?._failed).length;
    return { tokenCount: mints.length, mints, complete: failed === 0 };
  } catch (_) {
    return { tokenCount: null, mints: [], complete: false };
  }
}

/**
 * Counts how many tokens the deployer has launched in the last `windowDays` days.
 * Thin wrapper over getDeployerTokenData for backwards compatibility.
 * Returns null when the lookup failed — callers must not treat that as zero.
 */
async function getDeployerTokenCount(deployerAddress, windowDays = 30) {
  const { tokenCount } = await getDeployerTokenData(deployerAddress, windowDays);
  return tokenCount;
}
