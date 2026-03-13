/**
 * ZendIQ Lite — popup-monitor.js
 * Monitor tab: shows monitoring status, current token scan, recent intercepts.
 */

function loadMonitor() {
  const panel = document.getElementById('panel-monitor');
  if (!panel) return;

  chrome.storage.local.get(['zqlite_settings', 'zqlite_swap_history'], (items) => {
    const s    = items.zqlite_settings ?? {};
    const hist = Array.isArray(items.zqlite_swap_history) ? items.zqlite_swap_history : [];

    const enabled = s.enabled !== false;
    const sites   = s.sites ?? { jupiter: true, raydium: true, pumpfun: true };

    const today = new Date().toDateString();
    const todayCount = hist.filter(h => h.ts && new Date(h.ts).toDateString() === today).length;

    panel.innerHTML = `
      <div class="monitor-status ${enabled ? '' : 'off'}">
        <div class="status-dot"></div>
        <div style="flex:1">
          <div class="status-txt">${enabled ? 'Protection Active' : 'Protection Disabled'}</div>
          <div class="site-chips">
            <span class="site-chip ${sites.jupiter ? '' : 'off'}">Jupiter</span>
            <span class="site-chip ${sites.raydium ? '' : 'off'}">Raydium</span>
            <span class="site-chip ${sites.pumpfun ? '' : 'off'}">Pump.fun</span>
          </div>
        </div>
        <div style="font-size:10px;color:var(--muted);text-align:right">
          <div style="font-size:18px;font-weight:900;font-family:'Space Mono',monospace;color:var(--text)">${todayCount}</div>
          <div>today</div>
        </div>
      </div>

      <div style="font-size:9px;color:var(--muted);margin-top:6px;line-height:1.5">
        ZendIQ Lite hooks into Jupiter, Raydium, and Pump.fun —
        when you click Swap, it scans the output token and warns you if risk is above your threshold.
      </div>
    `;
  });
}


