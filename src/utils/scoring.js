/**
 * ZendIQ Lite — utils/scoring.js
 * Token risk scoring engine. Refactored from ZendIQ Pro's page-token-score.js.
 *
 * Changes from Pro version:
 *  - Removed window.__zq / namespace coupling entirely
 *  - Call initScoring({ rpcCall, jsonFetch }) before using fetchTokenScore()
 *  - Removed ns.renderWidgetPanel() callbacks (caller manages UI)
 *  - Removed ns.widgetCapturedTrade / ns.jupiterLiveQuote references
 *  - Cache is module-level (not attached to global namespace)
 *
 * Signals checked (15 active):
 *  1.  Mint authority (can devs print unlimited tokens?)
 *  2.  Freeze authority (can devs lock your tokens?)
 *  3.  Top-1 holder concentration
 *  4.  Top-5 holder concentration
 *  5.  RugCheck.xyz risk report (known rug flags, danger/warn items)
 *  6.  Speculative / memecoin market risk (pump.fun = guaranteed CRITICAL)
 *  7.  LP lock status
 *  8.  3-month price change (GeckoTerminal)
 *  9.  Long-term price change (GeckoTerminal, up to ~6M)
 * 10.  Volume trend / activity collapse (GeckoTerminal)
 * 11.  Token age (DexScreener pairCreatedAt)
 * 12.  24h price change (DexScreener)
 * 13.  Liquidity depth (DexScreener)
 * 14.  Market cap (DexScreener)
 * 15.  Serial deployer — how many tokens the creator wallet launched in last 30d
 *      (getRealDeployer + getDeployerTokenCount from extraction.js)
 *      +8 MEDIUM ≥2 tokens · +20 HIGH ≥4 tokens · +35 CRITICAL ≥10 tokens
 *
 * Score 0–100: LOW <25 | MEDIUM 25–49 | HIGH 50–74 | CRITICAL ≥75
 */

'use strict';

// ── Injected dependencies ────────────────────────────────────────────────────
let _rpcCall    = null;
let _jsonFetch  = null;

/**
 * Must be called once before fetchTokenScore().
 * @param {{ rpcCall: Function, jsonFetch: Function }} deps
 */
function initScoring(deps) {
  _rpcCall   = deps.rpcCall;
  _jsonFetch = deps.jsonFetch;
}

// ── Regulated stablecoins — always return LOW ────────────────────────────────
// Mint + freeze authorities are institutional compliance features on these,
// not rug risks. Running rug heuristics on them produces meaningless noise.
const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC  (Circle)
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT  (Tether)
  'EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o', // DAI   (MakerDAO bridged)
  '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E', // BTC   (Wormhole)
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH   (Wormhole)
  'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM',  // USDCet (Portal USDC)
]);

// ── Known speculative memecoins — base market-risk factor ───────────────────
const KNOWN_MEMECOINS = new Set([
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump', // Fartcoin
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', // POPCAT
  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',  // MEW
  'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',  // BOME
  'nQMSJCFepwLdRnGbQCuoTZvu3MiQR3OwLMpFBKqupQz',  // MYRO
  '8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGqgooGPo', // GECKO
  'GiG7Hr61RVm4CSUxJmgiCoySFQtdiwxtqf64MsRppump', // PNUT
  '5z3EqYQo9HiCEs3R84RCDMu2n7anpDMxRhdK31CR8zjt', // PEPE (SOL)
]);

// Name/symbol keywords — catch memecoins not in the hardcoded list
const MEMECOIN_KW = [
  'doge','shib','inu','pepe','frog','wif','bonk','cat','dog','moon',
  'elon','musk','chad','based','degen','floki','baby','meme','pump',
  'ape','wojak','cope','shill','wen','gm','ngmi','jeet','rekt',
  '420','69','wagmi','fart','poop','honk','nyan','smol','goat',
];

// ── Cache ─────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const _cache    = new Map(); // Map<mint, { result, fetchedAt }>
const _lastKnown = new Map(); // Map<mint, result>  — no TTL, persistent fallback

function _getCached(mint) {
  const entry = _cache.get(mint);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) { _cache.delete(mint); return null; }
  return entry.result;
}

function _getLastKnown(mint) {
  return _lastKnown.get(mint) ?? null;
}

function _setCached(mint, result) {
  _cache.set(mint, { result, fetchedAt: Date.now() });
  _lastKnown.set(mint, result);
}

// ── On-chain: mint account info ───────────────────────────────────────────────
async function _fetchMintInfo(mint) {
  try {
    const resp = await _rpcCall('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const info = resp?.result?.value?.data?.parsed?.info;
    if (!info) return null;
    return {
      mintAuthority:   info.mintAuthority   ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      supply:          info.supply          ?? null,
      decimals:        info.decimals        ?? 9,
    };
  } catch (_) { return null; }
}

// ── On-chain: top holder distribution ────────────────────────────────────────
async function _fetchHolderData(mint) {
  try {
    const [largestResp, supplyResp] = await Promise.all([
      _rpcCall('getTokenLargestAccounts', [mint]).catch(() => null),
      _rpcCall('getTokenSupply',          [mint]).catch(() => null),
    ]);
    const holders     = largestResp?.result?.value ?? [];
    const totalSupply = parseFloat(supplyResp?.result?.value?.uiAmount ?? 0);
    if (!totalSupply || !holders.length) return null;

    const holderPcts = holders.map(h => ({
      address: h.address,
      pct:     totalSupply > 0 ? (parseFloat(h.uiAmount ?? 0) / totalSupply) * 100 : 0,
    }));
    const top1Pct = holderPcts[0]?.pct ?? 0;
    const top5Pct = holderPcts.slice(0, 5).reduce((s, h) => s + h.pct, 0);
    return { holderPcts, top1Pct, top5Pct, totalHolders: holders.length };
  } catch (_) { return null; }
}

// ── DexScreener: price action, liquidity, market cap, token age ──────────────
async function _fetchDexScreener(mint) {
  try {
    const url  = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const data = await _jsonFetch(url);
    if (!data?.pairs?.length) return null;
    const solPairs = data.pairs.filter(p => p.chainId === 'solana');
    if (!solPairs.length) return null;
    solPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const p = solPairs[0];
    return {
      symbol:         p.baseToken?.symbol  ?? null,
      name:           p.baseToken?.name    ?? null,
      priceChange24h: p.priceChange?.h24   ?? null,
      volume24h:      p.volume?.h24        ?? null,
      liquidityUsd:   p.liquidity?.usd     ?? null,
      marketCap:      p.marketCap          ?? p.fdv ?? null,
      pairCreatedAt:  p.pairCreatedAt      ?? null,
      dexId:          p.dexId              ?? null,
      pairUrl:        p.url                ?? null,
    };
  } catch (_) { return null; }
}

// ── GeckoTerminal: daily OHLCV for 3-month + 6-month price change ────────────
// Two-step free tier path:
//   Step 1: GET /networks/solana/tokens/{mint}/pools?limit=1  → top pool address
//   Step 2: GET /networks/solana/pools/{pool}/ohlcv/day?limit=181 → daily candles
// Free tier max: 181 daily candles (~6 months). Candles are newest-first.
// Requires Accept: application/json;version=20230302 header.
async function _fetchGeckoTerminal(mint) {
  try {
    const _gtHeaders = { Accept: 'application/json;version=20230302' };
    const poolsUrl   = `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?limit=1`;
    const poolsData  = await _jsonFetch(poolsUrl, _gtHeaders);
    const poolAddress = poolsData?.data?.[0]?.attributes?.address;
    if (!poolAddress) return null;

    const ohlcvUrl  = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/day?limit=181&currency=usd`;
    const ohlcvData = await _jsonFetch(ohlcvUrl, _gtHeaders);
    const ohlcv = ohlcvData?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(ohlcv) || ohlcv.length < 2) return null;

    const latestClose = parseFloat(ohlcv[0]?.[4]);
    if (!latestClose || !isFinite(latestClose)) return null;

    const daysOfData = ohlcv.length;

    let change3m = null;
    if (daysOfData >= 90) {
      const close3m = parseFloat(ohlcv[90]?.[4]);
      if (close3m && isFinite(close3m)) change3m = ((latestClose - close3m) / close3m) * 100;
    }

    let changeLong = null;
    if (daysOfData >= 30) {
      const closeLong = parseFloat(ohlcv[daysOfData - 1]?.[4]);
      if (closeLong && isFinite(closeLong)) changeLong = ((latestClose - closeLong) / closeLong) * 100;
    }

    let volTrend = null;
    if (daysOfData >= 37) {
      const _avg = (slice) => slice.reduce((s, c) => s + (parseFloat(c[5]) || 0), 0) / slice.length;
      const recent7  = _avg(ohlcv.slice(0, 7));
      const baseline = _avg(ohlcv.slice(7, Math.min(daysOfData, 97)));
      if (baseline > 1000 && isFinite(recent7) && isFinite(baseline)) {
        volTrend = { ratio: recent7 / baseline, recentAvg: recent7, baselineAvg: baseline };
      }
    }

    return { change3m, change1y: changeLong, daysOfData, weeksOfData: Math.floor(daysOfData / 7), latestClose, volTrend };
  } catch (_) { return null; }
}

// ── RugCheck API: comprehensive risk report ───────────────────────────────────
async function _fetchRugCheck(mint) {
  try {
    const url  = `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`;
    const data = await _jsonFetch(url);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch (_) { return null; }
}

// ── Score calculator ──────────────────────────────────────────────────────────
// RugCheck risk item names with near-zero signal on legitimate tokens — filtered out
const RUGCHECK_NOISE = [
  'mutable metadata',
  'metadata updatable',
  'metadata',
];

function _computeScore(mintInfo, holderData, rugCheck, dexData, geckoData, mint, deployerData) {
  let score = 0;
  const factors = [];

  // ── 1. Mint authority ─────────────────────────────────────────────────────
  let mintAuth;
  if (rugCheck?.token !== undefined && rugCheck.token !== null) {
    mintAuth = rugCheck.token.mintAuthority ?? null;
  } else if (mintInfo !== null) {
    mintAuth = mintInfo.mintAuthority ?? null;
  } else {
    mintAuth = undefined;
  }

  if (mintAuth === undefined) {
    score += 5;
    factors.push({ name: 'Mint authority: data unavailable', severity: 'LOW', detail: 'On-chain lookup failed — could not confirm whether new tokens can be minted.' });
  } else if (mintAuth === null || mintAuth === '') {
    factors.push({ name: 'Supply fixed (mint burned)', severity: 'LOW', detail: 'Mint authority revoked — devs cannot print more tokens' });
  } else {
    score += 35;
    factors.push({ name: 'Unlimited supply risk', severity: 'CRITICAL', detail: 'Mint authority is active — devs can create unlimited tokens at any time' });
  }

  // ── 2. Freeze authority ───────────────────────────────────────────────────
  let freezeAuth;
  if (rugCheck?.token !== undefined && rugCheck.token !== null) {
    freezeAuth = rugCheck.token.freezeAuthority ?? null;
  } else if (mintInfo !== null) {
    freezeAuth = mintInfo.freezeAuthority ?? null;
  } else {
    freezeAuth = undefined;
  }

  if (freezeAuth === undefined) {
    factors.push({ name: 'Freeze authority: data unavailable', severity: 'LOW', detail: 'On-chain lookup failed — could not confirm freeze authority status.' });
  } else if (freezeAuth === null || freezeAuth === '') {
    factors.push({ name: 'No freeze authority', severity: 'LOW', detail: 'Freeze authority revoked — your tokens cannot be frozen by the contract' });
  } else {
    score += 20;
    factors.push({ name: 'Freeze authority active', severity: 'HIGH', detail: 'Developer can freeze token transfers in your wallet at any time' });
  }

  // ── 3. Top holder concentration ───────────────────────────────────────────
  let top1Pct = null, top5Pct = null;
  if (rugCheck?.topHolders?.length) {
    const th = rugCheck.topHolders;
    top1Pct = parseFloat(th[0]?.pct ?? th[0]?.amount ?? 0);
    top5Pct = th.slice(0, 5).reduce((s, h) => s + parseFloat(h.pct ?? h.amount ?? 0), 0);
  } else if (holderData) {
    top1Pct = holderData.top1Pct;
    top5Pct = holderData.top5Pct;
  }

  if (top1Pct != null && isFinite(top1Pct)) {
    if (top1Pct > 50) {
      score += 30;
      factors.push({ name: `Whale risk: ${top1Pct.toFixed(1)}% in one wallet`, severity: 'CRITICAL', detail: 'A single wallet controls the majority of supply — a dump would decimate price' });
    } else if (top1Pct > 30) {
      score += 20;
      factors.push({ name: `Large holder: ${top1Pct.toFixed(1)}% in one wallet`, severity: 'HIGH', detail: 'Single wallet holds a large portion of supply — high dump risk' });
    } else if (top1Pct > 15) {
      score += 10;
      factors.push({ name: `Concentrated: ${top1Pct.toFixed(1)}% top holder`, severity: 'MEDIUM', detail: 'Notable concentration in a single wallet' });
    } else {
      factors.push({ name: `Top holder: ${top1Pct.toFixed(1)}%`, severity: 'LOW', detail: 'Supply appears reasonably distributed' });
    }
  }

  if (top5Pct != null && isFinite(top5Pct) && top5Pct > 0) {
    if (top5Pct > 70) {
      score += 15;
      factors.push({ name: `Insider supply: top 5 hold ${top5Pct.toFixed(1)}%`, severity: 'HIGH', detail: 'Supply heavily concentrated among 5 wallets — coordinated selling is possible' });
    } else if (top5Pct > 50) {
      score += 5;
      factors.push({ name: `Top 5 hold ${top5Pct.toFixed(1)}% of supply`, severity: 'MEDIUM', detail: 'Above-average supply concentration in top wallets' });
    } else {
      factors.push({ name: `Top 5 hold ${top5Pct.toFixed(1)}% of supply`, severity: 'LOW', detail: 'Supply distribution looks reasonable' });
    }
  }

  // ── 4. RugCheck risk flags ────────────────────────────────────────────────
  if (rugCheck?.rugged === true) {
    score = 100;
    factors.unshift({ name: 'PREVIOUSLY RUGGED', severity: 'CRITICAL', detail: 'RugCheck has flagged this token as a confirmed rug pull' });
  }
  if (Array.isArray(rugCheck?.risks)) {
    for (const r of rugCheck.risks) {
      const lvl      = r.level ?? '';
      const rName    = r.name ?? '';
      const rNameLow = rName.toLowerCase();
      if (RUGCHECK_NOISE.some(n => rNameLow.includes(n))) continue;
      if (lvl === 'danger') {
        score += 15;
        factors.push({ name: rName || 'Flagged risk', severity: 'HIGH', detail: r.description ?? '' });
      } else if (lvl === 'warn') {
        score += 5;
        factors.push({ name: rName || 'Warning', severity: 'MEDIUM', detail: r.description ?? '' });
      }
    }
  }

  // ── 5. Speculative / memecoin market risk ─────────────────────────────────
  {
    const isPumpFunSite = typeof location !== 'undefined' && location.hostname?.includes('pump.fun');
    const tName = (rugCheck?.tokenMeta?.name   ?? '').toLowerCase();
    const tSym  = (rugCheck?.tokenMeta?.symbol ?? '').toLowerCase();
    const isMeme = KNOWN_MEMECOINS.has(mint) ||
      MEMECOIN_KW.some(k => tName.includes(k) || tSym.includes(k));

    if (isPumpFunSite) {
      // Every token on pump.fun is a speculative meme launch — no fundamental value.
      // This overrides keyword detection: the site context is a stronger signal.
      score += 35;
      factors.push({
        name: 'Pump.fun launch — extreme speculative risk',
        severity: 'CRITICAL',
        detail: 'All tokens traded on pump.fun are speculative meme launches with no fundamental value floor. High probability of total loss.',
      });
    } else if (isMeme) {
      score += 25;
      factors.push({
        name: 'Speculative asset',
        severity: 'HIGH',
        detail: 'Memecoin — value is driven purely by sentiment with no fundamental floor. Expect high volatility and potential for total loss.',
      });
    }
  }

  // ── 6. LP lock status ─────────────────────────────────────────────────────
  if (Array.isArray(rugCheck?.markets) && rugCheck.markets.length) {
    const avgLpLockedPct = rugCheck.markets.reduce((s, m) => s + (m.lp?.lpLockedPct ?? 0), 0) / rugCheck.markets.length;
    if (avgLpLockedPct < 5) {
      score += 10;
      factors.push({ name: 'LP fully unlocked', severity: 'MEDIUM', detail: 'Liquidity pool is unlocked — liquidity can be withdrawn at any time, crashing the price.' });
    } else if (avgLpLockedPct < 30) {
      score += 5;
      factors.push({ name: `LP mostly unlocked (${avgLpLockedPct.toFixed(0)}% locked)`, severity: 'MEDIUM', detail: 'Most LP tokens are unlocked — partial liquidity withdrawal risk.' });
    } else {
      factors.push({ name: `LP locked (${avgLpLockedPct.toFixed(0)}%)`, severity: 'LOW', detail: 'Majority of liquidity is locked — reduced exit-rug risk.' });
    }
  }

  // ── 7. 3-month price change ───────────────────────────────────────────────
  if (geckoData?.change3m != null && geckoData.weeksOfData >= 13) {
    const chg = geckoData.change3m;
    if (chg <= -60) {
      score += 22;
      factors.push({ name: `3M price: −${Math.abs(chg).toFixed(0)}%`, severity: 'CRITICAL', detail: `Token has lost ${Math.abs(chg).toFixed(1)}% of its value over the last 3 months.` });
    } else if (chg <= -35) {
      score += 15;
      factors.push({ name: `3M price: −${Math.abs(chg).toFixed(0)}%`, severity: 'HIGH', detail: `Down ${Math.abs(chg).toFixed(1)}% over 3 months. Significant sustained selling pressure.` });
    } else if (chg <= -15) {
      score += 8;
      factors.push({ name: `3M price: −${Math.abs(chg).toFixed(0)}%`, severity: 'MEDIUM', detail: `Down ${Math.abs(chg).toFixed(1)}% over 3 months.` });
    } else {
      const sign = chg >= 0 ? '+' : '';
      factors.push({ name: `3M price: ${sign}${chg.toFixed(0)}%`, severity: 'LOW', detail: `No significant sustained decline.` });
    }
  } else if (geckoData != null) {
    const _d = geckoData.daysOfData ?? 0;
    const _dLabel = _d < 14 ? `${_d}d` : `${Math.floor(_d / 7)}w`;
    factors.push({ name: `3M history: only ${_dLabel} data`, severity: 'LOW', detail: `Only ${_dLabel} of price history — token age penalty already applied.` });
  }

  // ── 8. Long-term price change (up to ~6M) ────────────────────────────────
  if (geckoData?.change1y != null && geckoData.weeksOfData >= 25) {
    const chg   = geckoData.change1y;
    const months = Math.round((geckoData.daysOfData ?? (geckoData.weeksOfData * 7)) / 30);
    const label = months >= 11 ? '1Y' : `${months}M`;
    if (chg <= -70) {
      score += 22;
      factors.push({ name: `${label} price: −${Math.abs(chg).toFixed(0)}%`, severity: 'CRITICAL', detail: `Near-total collapse — structural long-term decline.` });
    } else if (chg <= -45) {
      score += 15;
      factors.push({ name: `${label} price: −${Math.abs(chg).toFixed(0)}%`, severity: 'HIGH', detail: `Down ${Math.abs(chg).toFixed(1)}% over ${label}. Severe long-term decline.` });
    } else if (chg <= -20) {
      score += 8;
      factors.push({ name: `${label} price: −${Math.abs(chg).toFixed(0)}%`, severity: 'MEDIUM', detail: `Down ${Math.abs(chg).toFixed(1)}% over ${label}.` });
    } else {
      const sign = chg >= 0 ? '+' : '';
      factors.push({ name: `${label} price: ${sign}${chg.toFixed(0)}%`, severity: 'LOW', detail: `No severe long-term decline detected.` });
    }
  } else if (geckoData != null) {
    const _d2 = geckoData.daysOfData ?? 0;
    const label2 = _d2 < 14 ? `${_d2}d` : `${Math.floor(_d2 / 7)}w`;
    factors.push({ name: `Long-term: only ${label2} data`, severity: 'LOW', detail: `Only ${label2} of price history available.` });
  }

  // ── 9. Volume trend ───────────────────────────────────────────────────────
  if (geckoData?.volTrend != null) {
    const { ratio, recentAvg, baselineAvg } = geckoData.volTrend;
    const dropPct = Math.round((1 - ratio) * 100);
    const _fmtV = (v) => v >= 1_000_000 ? `$${(v/1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v/1000).toFixed(0)}k` : `$${v.toFixed(0)}`;
    if (ratio < 0.05) {
      score += 22;
      factors.push({ name: `Volume collapsed: −${dropPct}%`, severity: 'CRITICAL', detail: `Recent 7d avg ${_fmtV(recentAvg)}/day vs ${_fmtV(baselineAvg)}/day historically. Trading has essentially stopped.` });
    } else if (ratio < 0.15) {
      score += 15;
      factors.push({ name: `Volume dying: −${dropPct}%`, severity: 'HIGH', detail: `Recent 7d avg ${_fmtV(recentAvg)}/day vs ${_fmtV(baselineAvg)}/day. Sharp decline in activity.` });
    } else if (ratio < 0.35) {
      score += 8;
      factors.push({ name: `Volume fading: −${dropPct}%`, severity: 'MEDIUM', detail: `Recent 7d avg ${_fmtV(recentAvg)}/day vs ${_fmtV(baselineAvg)}/day. Declining interest.` });
    } else {
      factors.push({ name: `Volume: active`, severity: 'LOW', detail: `Recent 7d avg ${_fmtV(recentAvg)}/day. No significant decline detected.` });
    }
  }

  // ── 10. Token age ─────────────────────────────────────────────────────────
  // Suppressed on pump.fun — every token there is <24h old by design;
  // the site-context CRITICAL factor (§5) already captures that risk fully.
  const _isPumpFunSite = typeof location !== 'undefined' && location.hostname?.includes('pump.fun');
  if (dexData?.pairCreatedAt && !_isPumpFunSite) {
    const ageMs   = Date.now() - dexData.pairCreatedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 1) {
      score += 25;
      factors.push({ name: 'New token: <24h old', severity: 'HIGH', detail: `Trading pair created ${(ageMs/3600000).toFixed(1)}h ago. Rug pulls most commonly occur in the first 24 hours.` });
    } else if (ageDays < 7) {
      score += 15;
      factors.push({ name: `New token: ${ageDays.toFixed(0)}d old`, severity: 'HIGH', detail: `Tokens under 7 days old carry elevated rug risk.` });
    } else if (ageDays < 30) {
      score += 5;
      factors.push({ name: `Recent token: ${ageDays.toFixed(0)}d old`, severity: 'MEDIUM', detail: `Under 30 days — some early-exit risk remains.` });
    } else {
      factors.push({ name: `Token age: ${Math.floor(ageDays)}d`, severity: 'LOW', detail: `Established enough that a sudden rug is less likely.` });
    }
  }

  // ── 11. 24h price change ──────────────────────────────────────────────────
  if (dexData?.priceChange24h != null) {
    const chg = parseFloat(dexData.priceChange24h);
    if (isFinite(chg)) {
      if (chg <= -50) {
        score += 12;
        factors.push({ name: `Price −${Math.abs(chg).toFixed(0)}% in 24h`, severity: 'CRITICAL', detail: `Dropped ${Math.abs(chg).toFixed(1)}% in 24h — possible rug pull or coordinated exit.` });
      } else if (chg <= -30) {
        score += 8;
        factors.push({ name: `Price −${Math.abs(chg).toFixed(0)}% in 24h`, severity: 'HIGH', detail: `Significant 24h drawdown of ${Math.abs(chg).toFixed(1)}%.` });
      } else if (chg <= -15) {
        score += 4;
        factors.push({ name: `Price −${Math.abs(chg).toFixed(0)}% in 24h`, severity: 'MEDIUM', detail: `Notable decline of ${Math.abs(chg).toFixed(1)}% in 24h.` });
      } else {
        const sign = chg >= 0 ? '+' : '';
        factors.push({ name: `24h price: ${sign}${chg.toFixed(1)}%`, severity: 'LOW', detail: `No significant downward movement.` });
      }
    }
  }

  // ── 12. Liquidity depth ───────────────────────────────────────────────────
  if (dexData?.liquidityUsd != null) {
    const liq = dexData.liquidityUsd;
    if (liq < 5_000) {
      score += 25;
      factors.push({ name: `Liquidity: $${liq < 1000 ? liq.toFixed(0) : (liq/1000).toFixed(1)+'k'}`, severity: 'CRITICAL', detail: `Only $${liq.toFixed(0)} in the pool. Any swap will cause extreme slippage.` });
    } else if (liq < 25_000) {
      score += 15;
      factors.push({ name: `Low liquidity: $${(liq/1000).toFixed(1)}k`, severity: 'HIGH', detail: `$${(liq/1000).toFixed(1)}k in the pool. Easy price manipulation.` });
    } else if (liq < 100_000) {
      score += 8;
      factors.push({ name: `Liquidity: $${(liq/1000).toFixed(0)}k`, severity: 'MEDIUM', detail: `Moderate depth — large trades may move the price.` });
    } else {
      const fmt = liq >= 1_000_000 ? `$${(liq/1_000_000).toFixed(1)}M` : `$${(liq/1000).toFixed(0)}k`;
      factors.push({ name: `Liquidity: ${fmt}`, severity: 'LOW', detail: `${fmt} in the pool. Sufficient depth for normal trading.` });
    }
  }

  // ── 13. Market cap ────────────────────────────────────────────────────────
  if (dexData?.marketCap != null) {
    const mc = dexData.marketCap;
    if (mc < 50_000) {
      score += 15;
      factors.push({ name: `Micro-cap: $${(mc/1000).toFixed(0)}k`, severity: 'HIGH', detail: `Extremely easy to pump-and-dump at this market cap.` });
    } else if (mc < 500_000) {
      score += 8;
      factors.push({ name: `Small-cap: $${(mc/1000).toFixed(0)}k`, severity: 'MEDIUM', detail: `Susceptible to coordinated price movements.` });
    } else if (mc < 10_000_000) {
      score += 3;
      factors.push({ name: `Market cap: $${(mc/1_000_000).toFixed(1)}M`, severity: 'LOW', detail: `Mid-range — moderate manipulation resistance.` });
    } else {
      const fmt = mc >= 1_000_000_000 ? `$${(mc/1_000_000_000).toFixed(1)}B` : `$${(mc/1_000_000).toFixed(0)}M`;
      factors.push({ name: `Market cap: ${fmt}`, severity: 'LOW', detail: `Large enough that single-actor manipulation is significantly harder.` });
    }
  }

  // ── 14. Serial deployer check ─────────────────────────────────────────────
  // deployerData: { address: string, tokenCount: number } | null
  // Tiers calibrated against real pump.fun bot behaviour:
  //   ≥50 = scripted factory (token every ~14h)
  //   ≥25 = near-automated (token every ~1.2d — physically implausible manually)
  //   ≥10 = systematic serial rugger (semi-manual with templates)
  //   ≥3  = repeat experimenter / early-stage bad actor
  if (deployerData?.address) {
    const tc = deployerData.tokenCount ?? 0;
    if (tc >= 50) {
      score += 35;
      factors.push({
        name: `Bot factory — ${tc} deploys in 30d`,
        severity: 'CRITICAL',
        detail: `Creator wallet launched ${tc} tokens in 30 days (~1 every 14h). This is a scripted bot factory. Near-certain rug.`,
      });
    } else if (tc >= 25) {
      score += 30;
      factors.push({
        name: `Bot-created token — ${tc} deploys in 30d`,
        severity: 'CRITICAL',
        detail: `Creator wallet launched ${tc} tokens in 30 days — physically implausible without automation. Automated rug pipeline.`,
      });
    } else if (tc >= 10) {
      score += 20;
      factors.push({
        name: `Serial launcher — ${tc} tokens in 30d`,
        severity: 'HIGH',
        detail: `Creator wallet has launched ${tc} tokens in 30 days. Systematic serial launches are a strong rug-pull indicator.`,
      });
    } else if (tc >= 3) {
      score += 8;
      factors.push({
        name: `Repeat creator — ${tc} tokens in 30d`,
        severity: 'MEDIUM',
        detail: `Creator has launched ${tc} tokens in the last 30 days. May be an experimenter or early-stage bad actor — monitor carefully.`,
      });
    } else {
      factors.push({
        name: `New creator wallet`,
        severity: 'LOW',
        detail: `No serial-launch pattern detected for this deployer wallet in the last 30 days.`,
      });
    }
  }

  // ── Fallback: no data available ───────────────────────────────────────────
  if (!mintInfo && !holderData && !rugCheck && !dexData && !geckoData) {
    score += 15;
    factors.push({ name: 'Token data unavailable', severity: 'MEDIUM', detail: 'Could not fetch on-chain, RugCheck, or DexScreener data — proceed with caution' });
  }

  const finalScore = Math.max(0, Math.min(100, score));
  const level      = finalScore >= 75 ? 'CRITICAL' : finalScore >= 50 ? 'HIGH' : finalScore >= 25 ? 'MEDIUM' : 'LOW';
  const dataSource = rugCheck ? 'rugcheck+onchain' : mintInfo ? 'onchain' : dexData ? 'dexscreener' : 'unknown';
  const symbol     = rugCheck?.tokenMeta?.symbol ?? dexData?.symbol ?? null;

  return { mint, symbol, score: finalScore, level, factors, loaded: true, error: null, dataSource,
    deployer: deployerData?.address ?? null, deployerTokenCount: deployerData?.tokenCount ?? null };
}

// ── Public: fetchTokenScore(mint, symbol?) ────────────────────────────────────
/**
 * Scores a Solana token mint for rug pull risk.
 * Returns a result object immediately (from cache or last-known if available),
 * and always returns the fresh result when fully loaded.
 *
 * @param {string} mint    Token mint address (base58)
 * @param {string} [symbol] Optional symbol used in stablecoin display name
 * @returns {Promise<TokenScoreResult>}
 *
 * Result shape:
 *   { mint, score, level, factors, loaded, error, dataSource }
 */
async function fetchTokenScore(mint, symbol) {
  if (!_rpcCall || !_jsonFetch) {
    throw new Error('ZendIQ Lite scoring: call initScoring({ rpcCall, jsonFetch }) first');
  }
  if (!mint || typeof mint !== 'string') {
    return { mint, score: 0, level: 'LOW', factors: [], loaded: false, error: 'No mint address', dataSource: 'unknown' };
  }

  // Regulated stablecoins — instant LOW, no API calls
  if (STABLECOIN_MINTS.has(mint)) {
    const sym    = symbol ?? mint.slice(0, 4) + '…';
    const result = {
      mint, score: 0, level: 'LOW',
      factors: [{ name: `Regulated stablecoin (${sym})`, severity: 'LOW', detail: 'Issued by a regulated institution. Mint and freeze authorities are compliance features, not rug risks.' }],
      loaded: true, error: null, dataSource: 'safe',
    };
    _setCached(mint, result);
    return result;
  }

  // Cache hit
  const cached = _getCached(mint);
  if (cached) return cached;

  try {
    const [mintInfo, holderData, rugCheck, dexData, geckoData] = await Promise.all([
      _fetchMintInfo(mint).catch(() => null),
      _fetchHolderData(mint).catch(() => null),
      _fetchRugCheck(mint).catch(() => null),
      _fetchDexScreener(mint).catch(() => null),
      _fetchGeckoTerminal(mint).catch(() => null),
    ]);

    // Deployer lookup — runs after mint data so we can use the real deployer address.
    // getRealDeployer + getDeployerTokenCount are defined in extraction.js (MAIN world)
    // or stubbed to null in popup context where extraction.js is not loaded.
    let deployerData = null;
    try {
      if (typeof getRealDeployer === 'function') {
        const address = await getRealDeployer(mint);
        if (address) {
          const tokenCount = typeof getDeployerTokenCount === 'function'
            ? await getDeployerTokenCount(address, 30)
            : 0;
          deployerData = { address, tokenCount };
        }
      }
    } catch (_) { /* deployer lookup is best-effort */ }

    const result = _computeScore(mintInfo, holderData, rugCheck, dexData, geckoData, mint, deployerData);
    _setCached(mint, result);
    return result;
  } catch (err) {
    const fallback = _getLastKnown(mint);
    if (fallback) return fallback;
    return {
      mint, score: 0, level: 'LOW',
      factors: [{ name: 'Scan failed', severity: 'LOW', detail: err?.message ?? 'Unknown error' }],
      loaded: false, error: err?.message ?? 'Scan failed', dataSource: 'unknown',
    };
  }
}
