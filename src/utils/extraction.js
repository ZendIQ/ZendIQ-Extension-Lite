/**
 * ZendIQ Lite – extraction.js
 * getCreatorFromMint(mint) → string | null
 *
 * Returns the mint authority address as a proxy for "deployer".
 * This is the account that originally created the token — NOT necessarily the
 * current authority (which may have been revoked). Shown as informational only.
 *
 * Routing: rpcCall() in rpc.js → background.js RPC_CALL → Solana RPC
 */

async function getCreatorFromMint(mint) {
  if (!mint || typeof mint !== 'string') return null;
  try {
    const resp = await rpcCall('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const info = resp?.result?.value?.data?.parsed?.info;
    if (!info) return null;
    // Return mint authority (present = still active; null = burned).
    // Either way it identifies who minted the token originally.
    return info.mintAuthority ?? null;
  } catch (_) {
    return null;
  }
}
