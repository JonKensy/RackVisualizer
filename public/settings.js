// Settings page logic. All calls go to the auth-gated /api/* endpoints; a
// 401 redirects to login. Rendering uses createElement/textContent only (no
// innerHTML), so stored values cannot inject HTML.

const statusEl = document.getElementById('action-status');
let statusTimer = null;

function redirectToLogin() {
  location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
}

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind ?? '';
  clearTimeout(statusTimer);
  if (kind !== 'busy') statusTimer = setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 10000);
}

const lldpToggle = document.getElementById('lldp-enabled');

lldpToggle.addEventListener('change', async () => {
  lldpToggle.disabled = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lldpEnabled: lldpToggle.checked }),
    });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setStatus(`LLDP collection ${data.lldpEnabled ? 'enabled' : 'disabled'}.`, 'ok');
  } catch (err) {
    lldpToggle.checked = !lldpToggle.checked;
    setStatus(`Could not change setting: ${err.message}`, 'error');
  } finally {
    lldpToggle.disabled = false;
  }
});

const pfxToggle = document.getElementById('powerflex-enabled');
const pfxFields = document.getElementById('powerflex-fields');
const pfxForm = document.getElementById('powerflex-form');
const pfxRefresh = document.getElementById('powerflex-refresh');

function showPfxFields(enabled) {
  pfxFields.hidden = !enabled;
}

pfxToggle.addEventListener('change', async () => {
  pfxToggle.disabled = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ powerflexEnabled: pfxToggle.checked }),
    });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    showPfxFields(data.powerflexEnabled);
    setStatus(`PowerFlex discovery ${data.powerflexEnabled ? 'enabled' : 'disabled'}.`, 'ok');
  } catch (err) {
    pfxToggle.checked = !pfxToggle.checked;
    setStatus(`Could not change setting: ${err.message}`, 'error');
  } finally {
    pfxToggle.disabled = false;
  }
});

pfxForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    powerflexUrl: document.getElementById('powerflex-url').value.trim(),
    powerflexUser: document.getElementById('powerflex-user').value.trim(),
    powerflexLoginPath: document.getElementById('powerflex-login-path').value.trim(),
    powerflexResourcesPath: document.getElementById('powerflex-resources-path').value.trim(),
    idracUser: document.getElementById('idrac-user').value.trim(),
  };
  // Blank password fields mean "keep the stored value"; clearing is explicit.
  const pfxPass = document.getElementById('powerflex-password').value;
  const idracPass = document.getElementById('idrac-password').value;
  if (pfxPass) body.powerflexPassword = pfxPass;
  if (idracPass) body.idracPassword = idracPass;
  if (document.getElementById('powerflex-password-clear').checked) body.powerflexPasswordClear = true;
  if (document.getElementById('idrac-password-clear').checked) body.idracPasswordClear = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setStatus('Settings saved.', 'ok');
    document.getElementById('powerflex-password').value = '';
    document.getElementById('idrac-password').value = '';
    document.getElementById('powerflex-password-clear').checked = false;
    document.getElementById('idrac-password-clear').checked = false;
    fillPfxFields(data);
  } catch (err) {
    setStatus(`Could not save settings: ${err.message}`, 'error');
  }
});

function fillPfxFields(data) {
  document.getElementById('powerflex-url').value = data.powerflexUrl ?? '';
  document.getElementById('powerflex-user').value = data.powerflexUser ?? '';
  document.getElementById('powerflex-login-path').value = data.powerflexLoginPath ?? '';
  document.getElementById('powerflex-resources-path').value = data.powerflexResourcesPath ?? '';
  document.getElementById('idrac-user').value = data.idracUser ?? '';
  const pfxPassEl = document.getElementById('powerflex-password');
  const idracPassEl = document.getElementById('idrac-password');
  pfxPassEl.placeholder = data.hasPowerflexPassword ? '(stored — blank keeps it)' : '(not set)';
  idracPassEl.placeholder = data.hasIdracPassword ? '(stored — blank keeps it)' : '(not set)';
}

pfxRefresh.addEventListener('click', async () => {
  pfxRefresh.disabled = true;
  setStatus('Querying PowerFlex Manager…', 'busy');
  try {
    const res = await fetch('/api/powerflex/refresh', { method: 'POST' });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    const trunc = data.truncated ? ' (list truncated at 500)' : '';
    setStatus(`Discovered ${data.kept} iDRACs of ${data.total} resources, ${data.rejected} rejected${trunc}.`, 'ok');
    loadPfxHosts();
  } catch (err) {
    setStatus(`PowerFlex refresh failed: ${err.message}`, 'error');
  } finally {
    pfxRefresh.disabled = false;
  }
});

async function loadPfxHosts() {
  const listEl = document.getElementById('powerflex-hosts');
  try {
    const res = await fetch('/api/powerflex/hosts');
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    listEl.innerHTML = '';
    const hosts = data.hosts ?? [];
    if (hosts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'managed-item muted';
      empty.textContent = 'none — use "Refresh from PowerFlex" to populate';
      listEl.appendChild(empty);
      return;
    }
    for (const h of hosts) {
      const row = document.createElement('div');
      row.className = 'managed-item';
      const label = document.createElement('span');
      const suffix = [h.name, h.serviceTag].filter(Boolean).join(' / ');
      label.textContent = suffix ? `${h.host} — ${suffix}` : h.host;
      row.appendChild(label);
      listEl.appendChild(row);
    }
  } catch (err) {
    listEl.textContent = `Failed to load discovered hosts: ${err.message}`;
  }
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    lldpToggle.checked = data.lldpEnabled !== false;
    pfxToggle.checked = data.powerflexEnabled === true;
    showPfxFields(pfxToggle.checked);
    fillPfxFields(data);
  } catch (err) {
    setStatus(`Failed to load settings: ${err.message}`, 'error');
  }
}

document.getElementById('add-mac-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    mac: document.getElementById('mac-address').value.trim(),
    name: document.getElementById('mac-name').value.trim(),
  };
  try {
    const res = await fetch('/api/switch-macs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setStatus(`Added ${data.added.mac} → ${data.added.name}.`, 'ok');
    e.target.reset();
    loadMacs();
  } catch (err) {
    setStatus(`Could not add mapping: ${err.message}`, 'error');
  }
});

async function removeMac(index, label) {
  try {
    const res = await fetch(`/api/switch-macs/${index}`, { method: 'DELETE' });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setStatus(`Removed ${label}.`, 'ok');
    loadMacs();
  } catch (err) {
    setStatus(`Could not remove ${label}: ${err.message}`, 'error');
  }
}

async function loadMacs() {
  const listEl = document.getElementById('mac-list');
  try {
    const res = await fetch('/api/switch-macs');
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    listEl.innerHTML = '';
    const macs = data.switchMacs ?? [];
    if (macs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'managed-item muted';
      empty.textContent = 'none';
      listEl.appendChild(empty);
    }
    for (const [i, m] of macs.entries()) {
      const row = document.createElement('div');
      row.className = 'managed-item';
      const label = document.createElement('span');
      label.textContent = `${m.mac} → ${m.name}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row-remove';
      btn.textContent = 'Remove';
      btn.addEventListener('click', () => removeMac(i, `${m.mac} → ${m.name}`));
      row.append(label, btn);
      listEl.appendChild(row);
    }
  } catch (err) {
    listEl.textContent = `Failed to load mappings: ${err.message}`;
  }
}

loadSettings();
loadMacs();
