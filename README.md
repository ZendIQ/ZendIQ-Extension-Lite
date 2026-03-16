# ZendIQ Lite

> **Free Solana swap guardian.** Analyses token risk and warns you before you sign — on Jupiter, Raydium, and Pump.fun.
>
> 🌐 [zendiq.ai](https://zendiq.ai) · Chrome Web Store *(coming soon)*

---

## What it does

ZendIQ Lite sits silently in your browser and activates the moment you click **Swap**. Before your wallet is asked to sign anything, a risk overlay appears with:

- A **0–100 Risk Score** for the output token
- A plain-English breakdown of every warning signal found
- **Proceed** or **Cancel** — you stay in control

It works on **Jupiter**, **Raydium**, and **Pump.fun** with no wallet connection and no account required.

### Risk levels

| Score | Level | What it means |
|-------|-------|---------------|
| 0–24 | 🟢 LOW | On-chain hygiene looks clean |
| 25–49 | 🟡 MEDIUM | Some risk signals present |
| 50–74 | 🟠 HIGH | Significant red flags — review carefully |
| 75–100 | 🔴 CRITICAL | Multiple severe warning signs |

### 15 scoring signals

| Signal | Source |
|--------|--------|
| Mint authority (can devs print tokens?) | Solana RPC |
| Freeze authority (can devs lock your wallet?) | Solana RPC |
| Top-1 holder concentration | Solana RPC |
| Top-5 holder concentration | Solana RPC |
| RugCheck risk flags (danger / warning items) | RugCheck API |
| Rug-pull flag | RugCheck API |
| LP lock status | RugCheck API |
| Speculative / memecoin keyword detection | Token metadata |
| 3-month price change | GeckoTerminal |
| Long-term price change (up to 6 months) | GeckoTerminal |
| Volume trend — 7-day vs 30–90-day baseline | GeckoTerminal |
| Token age (< 24 h / < 7 d / < 30 d) | DexScreener |
| 24 h price change | DexScreener |
| Liquidity depth | DexScreener |
| Market cap | DexScreener |

### Wallet Security tab

The popup's **Wallet Security** tab scans your connected wallet for:

- SPL Token and Token-2022 accounts with **unlimited delegations** — the most common attack vector used by drainer contracts
- Matches against a list of **known drainer contract addresses**
- Provides a **Security Score** (0–100) with per-finding detail and a direct link to [revoke.cash](https://revoke.cash) for any unlimited approvals

No transaction is required. The scan is read-only.

---

## Install

### From Chrome Web Store *(coming soon)*

### Manual / Developer install

1. Clone or download this repository
2. Open `chrome://extensions` (or `brave://extensions`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `extension/` folder inside `zendiq-lite/`

---

## Privacy & data collection

Transparency is a core commitment. Here is exactly what ZendIQ Lite sends to our server at `zendiq-backend.onrender.com`, and why.

### What IS sent

Every event shares this common envelope:

| Field | Value | Purpose |
|-------|-------|---------|
| `type` | event name (see below) | Categorise the event |
| `v` | extension version string | Understand adoption across versions |
| `ts` | Unix timestamp (ms) | Time-series aggregation |
| `ext_id` | `chrome.runtime.id` — a random ID assigned by Chrome to the extension install, **not tied to your wallet or identity** | Deduplicate daily-active counts |

The 9 event types currently logged:

| Event | When | Fields sent |
|-------|------|-------------|
| `extension_installed` | Once on install or update | `reason`, `prev_version`, `browser` |
| `daily_active` | At most once per UTC day | `day` (YYYY-MM-DD only) |
| `token_checked` | After every risk scan completes | `mint`, `score`, `level`, `site` |
| `high_risk_detected` | When score ≥ 50 | `mint`, `score`, `level`, `site` |
| `transaction_initiated` | When a swap is intercepted | `mint`, `score`, `level`, `site`, `path` |
| `transaction_completed` | User clicks Proceed on low/medium risk | `mint`, `score`, `level`, `trade_usd`*, `site` |
| `transaction_aborted` | User clicks Cancel on low/medium risk | `mint`, `score`, `level`, `trade_usd`*, `site` |
| `proceeded_high_risk` | User clicks Proceed on high/critical risk | `mint`, `score`, `level`, `trade_usd`*, `site` |
| `avoided_high_risk` | User clicks Cancel on high/critical risk | `mint`, `score`, `level`, `trade_usd`*, `site` |

\* `trade_usd` is sourced from Jupiter's own `/order` API response (the USD value Jupiter calculated for the swap). It is `null` when not available. It is **never** derived from your wallet balance.

**Why we collect this:** These aggregated counts let us measure how many high-risk tokens users encounter, how often users proceed vs cancel, and whether ZendIQ's risk scores correlate with real rug events. The data is never sold and never linked to an identity.

### What is NEVER sent

| Data | Where it stays |
|------|----------------|
| Wallet public key or address | `chrome.storage.local` only — never leaves your browser |
| Private keys or seed phrases | Never accessed — not technically possible from a content script |
| Transaction signatures | `chrome.storage.local` only |
| Full swap history (amounts, token pairs, quote accuracy) | `chrome.storage.local` only |
| Wallet security scan results (approvals, drainer matches) | `chrome.storage.local` only |
| Full risk factor breakdown (all 15 signal details) | Computed and displayed locally; never uploaded |
| RugCheck / DexScreener / GeckoTerminal API responses | Used locally for scoring; never forwarded |
| Deployer address or on-chain transaction history | Used locally for scoring; never forwarded |

### Server-side safeguards

The backend validates every inbound event before storage:

- **Rate limit:** 60 events per IP per minute
- **Type whitelist:** only the 9 event names above are accepted
- **Field constraints:** `mint` must be a valid base58 address, `score` must be 0–100, `trade_usd` capped at $50,000, `site` must be one of `jup.ag / raydium.io / pump.fun`
- **Payload size:** `data` field capped at 2 048 bytes
- No raw event rows are ever exposed via any public API endpoint — only aggregated statistics

---

## Permissions

The extension requests the following browser permissions:

| Permission | Reason |
|------------|--------|
| `storage` | Save swap history, security scan results, and settings locally |
| `activeTab` | Detect the currently open DEX tab |
| `scripting` | Inject the risk overlay and wallet hook into DEX pages |
| `tabs` | Query open tabs to find the active DEX |
| `*://jup.ag/*`, `*://raydium.io/*`, `*://pump.fun/*` | Intercept swap events on supported DEXes |
| `https://api.rugcheck.xyz/*` | Fetch RugCheck risk flags for the output token |
| `https://api.dexscreener.com/*` | Fetch token age, liquidity, 24 h price change |
| `https://api.geckoterminal.com/*` | Fetch price history and volume trend |
| `https://api.mainnet-beta.solana.com/*`, `https://solana.publicnode.com/*` | On-chain RPC calls (mint authority, holder data, wallet accounts) |

No payment APIs, social networks, or ad networks are contacted.

---

## Project structure

```
zendiq-lite/
├── extension/                   Unpacked MV3 extension
│   ├── manifest.json
│   └── src/
│       ├── background.js        Service worker — external fetches + analytics relay
│       ├── scripts/
│       │   ├── page-config.js   Shared namespace (window.__zqlite)
│       │   ├── page-interceptor.js  Fetch hook + swap overlay (MAIN world)
│       │   ├── page-wallet.js   Wallet sign hook (MAIN world)
│       │   ├── page-security.js Wallet account scanner (MAIN world)
│       │   └── bridge.js        postMessage relay MAIN ↔ service worker (ISOLATED)
│       ├── ui/
│       │   ├── popup.html       Extension popup (4 tabs)
│       │   ├── popup.js         Popup logic
│       │   ├── popup-monitor.js Monitor tab
│       │   ├── popup-history.js History tab
│       │   ├── popup-security.js Wallet Security tab
│       │   ├── popup-settings.js Settings tab
│       │   └── styles.css       Popup styles
│       └── utils/
│           ├── scoring.js       15-signal risk scoring engine
│           ├── extraction.js    On-chain deployer lookup
│           ├── rpc.js           Popup ↔ background message helpers
│           └── analytics.js     Fire-and-forget event logger
└── backend/                     Optional self-hosted backend
    ├── .env.example
    ├── package.json
    └── src/
        ├── server.js            Express entry point
        ├── api/routes.js        POST /api/events · GET /api/stats · GET /api/version
        └── db/schema.sql        SQLite schema
```

---

## Backend (self-hosted)

The extension works fully without a backend — all scoring is local. The optional backend enables:

- **Version checks** — update banner when a new version is published
- **Aggregated analytics** — anonymised event counts for the dashboard

### Run locally

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Then in the extension popup Settings, set the backend URL to `http://localhost:3000`.

---

## APIs used

All free, no API key required:

| API | Used for |
|---|---|
| [Solana RPC](https://solana.com/) (publicnode.com + mainnet-beta) | Mint authority, freeze authority, holder data |
| [RugCheck.xyz](https://rugcheck.xyz/) | Comprehensive risk report |
| [DexScreener](https://dexscreener.com/) | Price, liquidity, market cap, token age |
| [GeckoTerminal](https://www.geckoterminal.com/) | 3M + 6M price history, volume trend |

---

## ZendIQ Pro

Need **swap interception, MEV protection, and auto-optimised routing** on jup.ag? Check out [ZendIQ Pro](https://github.com/zendiq/zendiq-pro) — the full-featured swap guardian that saves you from bad routes and front-running bots.

---

## Licence

MIT
