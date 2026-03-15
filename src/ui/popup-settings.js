/**
 * ZendIQ Lite — popup-settings.js
 * Settings tab: enable/disable monitoring, risk threshold, per-site toggles.
 */

function loadSettings() {
  const panel = document.getElementById('panel-settings');
  if (!panel) return;

  chrome.storage.local.get(['zqlite_settings'], ({ zqlite_settings: s = {} }) => {
    const enabled  = s.enabled      !== false;
    const level    = s.minRiskLevel ?? 'MEDIUM';
    const sites    = s.sites        ?? { jupiter: true, raydium: true, pumpfun: true };

    panel.innerHTML = `
      <!-- Master toggle -->
      <div class="setting-group">
        <div class="setting-row">
          <div>
            <div class="setting-label">Protection Enabled</div>
            <div class="setting-sub">Intercept swaps and show risk overlay</div>
          </div>
          <label class="toggle" title="Enable or disable swap interception on all sites">
            <input type="checkbox" id="s-enabled" ${enabled ? 'checked' : ''}>
            <div class="toggle-track"></div>
          </label>
        </div>
      </div>

      <!-- Risk threshold -->
      <div class="setting-group">
        <div class="setting-group-label">Minimum Risk Level to Warn</div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Show overlay when risk is at least</div>
            <div class="setting-sub">Tokens below this threshold pass through silently</div>
          </div>
          <div class="rsel" id="s-level-wrap">
            <input type="hidden" id="s-level" value="${level}">
            <div class="rsel-trigger" id="s-level-trigger">
              <span class="rsel-trigger-label" id="s-level-label"></span>
              <svg class="rsel-arrow" width="10" height="6" viewBox="0 0 10 6" fill="none">
                <path d="M1 1l4 4 4-4" stroke="#6B6B8A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="rsel-menu" id="s-level-menu" style="display:none">
              <div class="rsel-opt ${level === 'ALL' ? 'selected' : ''}" data-value="ALL">
                <span class="rsel-dot" data-level="ALL"></span>
                <div><div class="rsel-opt-label">All tokens</div><div class="rsel-opt-sub">Warn on every swap</div></div>
              </div>
              <div class="rsel-opt ${level === 'MEDIUM' ? 'selected' : ''}" data-value="MEDIUM">
                <span class="rsel-dot" data-level="MEDIUM"></span>
                <div><div class="rsel-opt-label">Medium+</div><div class="rsel-opt-sub">Risk score ≥ 25 / 100</div></div>
              </div>
              <div class="rsel-opt ${level === 'HIGH' ? 'selected' : ''}" data-value="HIGH">
                <span class="rsel-dot" data-level="HIGH"></span>
                <div><div class="rsel-opt-label">High+</div><div class="rsel-opt-sub">Risk score ≥ 50 / 100</div></div>
              </div>
              <div class="rsel-opt ${level === 'CRITICAL' ? 'selected' : ''}" data-value="CRITICAL">
                <span class="rsel-dot" data-level="CRITICAL"></span>
                <div><div class="rsel-opt-label">Critical only</div><div class="rsel-opt-sub">Risk score ≥ 75 / 100</div></div>
              </div>
            </div>
          </div>
        </div>
        <div class="setting-row" style="padding-top:0;padding-bottom:12px">
          <div style="font-size:9.5px;color:var(--muted);line-height:1.6">
            Score guide: LOW &lt;25 · MEDIUM 25–49 · HIGH 50–74 · CRITICAL ≥75
          </div>
        </div>
      </div>

      <!-- Per-site toggles -->
      <div class="setting-group">
        <div class="setting-group-label">Monitor on Sites</div>
        <div class="setting-row">
          <div class="setting-label">Jupiter (jup.ag)</div>
          <label class="toggle">
            <input type="checkbox" id="s-jupiter" ${sites.jupiter !== false ? 'checked' : ''}>
            <div class="toggle-track"></div>
          </label>
        </div>
        <div class="setting-row">
          <div class="setting-label">Raydium (raydium.io)</div>
          <label class="toggle">
            <input type="checkbox" id="s-raydium" ${sites.raydium !== false ? 'checked' : ''}>
            <div class="toggle-track"></div>
          </label>
        </div>
        <div class="setting-row">
          <div class="setting-label">Pump.fun</div>
          <label class="toggle">
            <input type="checkbox" id="s-pumpfun" ${sites.pumpfun !== false ? 'checked' : ''}>
            <div class="toggle-track"></div>
          </label>
        </div>
      </div>

      <div style="font-size:9px;color:var(--muted);line-height:1.6;margin-top:2px">
        Changes take effect immediately on open tabs.
      </div>
    `;

    // Wire up toggle / checkbox change handlers
    ['s-enabled', 's-jupiter', 's-raydium', 's-pumpfun'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', _saveSettings);
    });

    // Custom risk-level dropdown
    const _LEVEL_LABELS = { ALL: 'All tokens', MEDIUM: 'Medium+', HIGH: 'High+', CRITICAL: 'Critical only' };
    const rselTrigger   = document.getElementById('s-level-trigger');
    const rselMenu      = document.getElementById('s-level-menu');
    const rselInput     = document.getElementById('s-level');
    const rselLabel     = document.getElementById('s-level-label');

    // Seed label from initial level
    if (rselLabel) rselLabel.textContent = _LEVEL_LABELS[level] ?? level;

    // Toggle open/close — position using fixed coords to escape overflow:hidden
    rselTrigger?.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = rselMenu.style.display !== 'none';
      if (!isOpen) {
        const r = rselTrigger.getBoundingClientRect();
        rselMenu.style.top  = (r.bottom + 5) + 'px';
        rselMenu.style.left = r.left + 'px';
      }
      rselMenu.style.display = isOpen ? 'none' : 'block';
      rselTrigger.classList.toggle('open', !isOpen);
    });

    // Close when clicking outside
    const _closeRsel = () => {
      if (rselMenu) rselMenu.style.display = 'none';
      rselTrigger?.classList.remove('open');
    };
    document.addEventListener('click', _closeRsel);
    // Prevent clicks inside the dropdown from bubbling to doc
    document.getElementById('s-level-wrap')?.addEventListener('click', e => e.stopPropagation());

    // Option selection
    rselMenu?.querySelectorAll('.rsel-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        const val = opt.dataset.value;
        rselInput.value       = val;
        rselLabel.textContent = _LEVEL_LABELS[val] ?? val;
        rselMenu.querySelectorAll('.rsel-opt').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        rselMenu.style.display = 'none';
        rselTrigger.classList.remove('open');
        _saveSettings();
      });
    });
  });
}

function _saveSettings() {
  const enabled  = document.getElementById('s-enabled')?.checked  !== false;
  const level    = document.getElementById('s-level')?.value       ?? 'MEDIUM';
  const jupiter  = !!document.getElementById('s-jupiter')?.checked;
  const raydium  = !!document.getElementById('s-raydium')?.checked;
  const pumpfun  = !!document.getElementById('s-pumpfun')?.checked;

  const settings = { enabled, minRiskLevel: level, sites: { jupiter, raydium, pumpfun } };
  chrome.storage.local.set({ zqlite_settings: settings }, () => {
    // Push updated settings to any active DEX tabs via content script bridge
    chrome.tabs.query({ url: ['*://*.jup.ag/*', '*://*.raydium.io/*', '*://pump.fun/*', '*://*.pump.fun/*'] }, (tabs) => {
      for (const tab of (tabs ?? [])) {
        chrome.tabs.sendMessage(tab.id, { type: 'ZQLITE_PUSH_SETTINGS', settings }).catch?.(() => {});
      }
    });
  });
}
