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

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    lldpToggle.checked = data.lldpEnabled !== false;
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
