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
 * getDeployerTokenCount(deployerAddress, windowDays?) → number
 *   Returns how many distinct mint addresses the deployer has funded in the
 *   last `windowDays` days (default 30). A high count is the primary serial-
 *   rugger signal.
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
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
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
 * Counts how many tokens the deployer has launched in the last `windowDays` days.
 * Scans up to 200 recent transactions of the deployer wallet and counts those
 * that include a SPL Token or Token-2022 program instruction (InitializeMint).
 * Returns 0 on any failure so callers can safely use the result in comparisons.
 */
async function getDeployerTokenCount(deployerAddress, windowDays = 30) {
  if (!deployerAddress || typeof deployerAddress !== 'string') return 0;
  try {
    const cutoff = Math.floor((Date.now() - windowDays * 24 * 3600 * 1000) / 1000);
    const resp = await rpcCall('getSignaturesForAddress', [
      deployerAddress,
      { limit: 200 },
    ]);
    const sigs = resp?.result ?? [];

    // Filter to within the time window
    const recent = sigs.filter(s => (s.blockTime ?? 0) >= cutoff);
    if (!recent.length) return 0;

    // Fetch all recent txns in parallel (capped at 50 to avoid RPC hammering)
    const toCheck = recent.slice(0, 50);
    const txResps = await Promise.all(
      toCheck.map(s =>
        rpcCall('getTransaction', [
          s.signature,
          { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
        ]).catch(() => null)
      )
    );

    // Count txns that reference a SPL Token program (strongly implies mint creation)
    // We look for the token program in the static account keys — cheap, no instruction decoding needed.
    let count = 0;
    const seen = new Set();
    for (const r of txResps) {
      if (!r?.result) continue;
      const keys = r.result.transaction?.message?.staticAccountKeys
                ?? r.result.transaction?.message?.accountKeys
                ?? [];
      const keyStrs = keys.map(k => typeof k === 'string' ? k : k?.pubkey ?? '');
      if (keyStrs.includes(_SPL_TOKEN) || keyStrs.includes(_SPL_TOKEN_22)) {
        // Use the first non-deployer account key as a proxy mint address to deduplicate
        const mintProxy = keyStrs.find(k => k && k !== deployerAddress) ?? s?.signature;
        if (mintProxy && !seen.has(mintProxy)) {
          seen.add(mintProxy);
          count++;
        }
      }
    }
    return count;
  } catch (_) {
    return 0;
  }
}
