/**
 * ZendIQ Lite — utils/rpc.js
 * Popup-context RPC + JSON fetch helpers.
 * In Lite the popup has direct chrome.runtime access — no postMessage bridge needed.
 * Both functions route through background.js which handles CORS.
 */

/**
 * Call a Solana JSON-RPC method via the background service worker.
 * @param {string} method  RPC method name (e.g. 'getAccountInfo')
 * @param {Array}  params  Method parameters
 * @returns {Promise<any>} Parsed JSON-RPC response data
 */
function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'RPC_CALL', method, params }, (res) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (res?.ok) resolve(res.data);
      else reject(new Error(res?.error ?? 'RPC failed'));
    });
  });
}

/**
 * Fetch a JSON endpoint via the background service worker (bypasses CORS).
 * @param {string} url      Full URL to fetch
 * @param {Object} headers  Optional headers (e.g. Accept for GeckoTerminal)
 * @returns {Promise<any>}  Parsed JSON response
 */
function jsonFetch(url, headers) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'FETCH_JSON', url, headers: headers || null }, (res) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (res?.ok) resolve(res.data);
      else reject(new Error(res?.error ?? 'Fetch failed'));
    });
  });
}
