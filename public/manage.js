// Add/Remove page logic. All calls go to the auth-gated /api/* endpoints; a
// 401 redirects to login. Rendering uses createElement/textContent only (no
// innerHTML), so stored values cannot inject HTML. CSV uploads are sent as
// plain text and size-capped server-side (256kb); the server validates every
// row before storing it.

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

const nodeRows = document.getElementById('node-rows');

const addBtn = document.createElement('button');
addBtn.type = 'button';
addBtn.className = 'row-add';
addBtn.title = 'Add another field';
addBtn.setAttribute('aria-label', 'Add another field');
addBtn.textContent = '+';
addBtn.addEventListener('click', () => {
  addRow();
  nodeRows.querySelector('.node-row:last-child input').focus();
});

function addRow() {
  const row = document.createElement('div');
  row.className = 'node-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'iDRAC IP or DNS name';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'row-remove';
  remove.title = 'Remove this field';
  remove.setAttribute('aria-label', 'Remove this field');
  remove.textContent = '×';
  remove.addEventListener('click', () => {
    row.remove();
    syncRows();
  });
  row._removeBtn = remove;
  row.append(input, addBtn, remove);
  nodeRows.appendChild(row);
  syncRows();
}

function syncRows() {
  const rows = [...nodeRows.querySelectorAll('.node-row')];
  for (const r of rows) r._removeBtn.hidden = rows.length === 1;
  if (rows.length > 0 && !rows[rows.length - 1].contains(addBtn)) {
    rows[rows.length - 1].appendChild(addBtn);
  }
}

document.getElementById('add-node-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hosts = [...nodeRows.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
  if (hosts.length === 0) return;
  const resultsEl = document.getElementById('node-results');
  resultsEl.innerHTML = '';
  for (const host of hosts) {
    const line = document.createElement('div');
    line.className = 'result-line busy';
    line.textContent = `${host}: checking…`;
    resultsEl.appendChild(line);
    try {
      const res = await fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host }),
      });
      if (res.status === 401) { redirectToLogin(); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const tag = data.added.serviceTag ? ` (service tag ${data.added.serviceTag})` : '';
      line.textContent = `${host}: added${tag}`;
      line.className = 'result-line ok';
    } catch (err) {
      line.textContent = `${host}: ${err.message}`;
      line.className = 'result-line error';
    }
  }
  nodeRows.innerHTML = '';
  addRow();
  loadManaged();
});

const csvInput = document.getElementById('csv-file');
document.getElementById('import-csv').addEventListener('click', () => csvInput.click());
csvInput.addEventListener('change', async () => {
  const file = csvInput.files[0];
  if (!file) return;
  setStatus(`Importing ${file.name}…`, 'busy');
  try {
    const res = await fetch('/api/nodes/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: await file.text(),
    });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    const parts = [];
    if (data.added.length) parts.push(`added ${data.added.length}`);
    if (data.skipped.length) parts.push(`skipped ${data.skipped.length} already configured`);
    if (data.errors.length) parts.push(`${data.errors.length} failed: ${data.errors.map((e) => `${e.host} (${e.reason})`).join('; ')}`);
    setStatus(`Import ${parts.join(' · ')}.`, data.errors.length ? 'error' : 'ok');
    loadManaged();
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, 'error');
  } finally {
    csvInput.value = '';
  }
});

const oddEven = (n) => (n % 2 === 1 ? 'A' : 'B');

// Patterns are tried in order, so "-mgmtagg" must precede "-mgmt". The
// number for odd/even pairing is the one right after the role token when
// present (e.g. -mgmtagg01), otherwise the -n9kNN suffix.
const NAME_ROLE_PATTERNS = [
  { re: /-lf-n9k(\d+)$/i, role: (m) => `Leaf ${oddEven(Number(m[1]))}` },
  { re: /-blf?-n9k(\d+)$/i, role: (m) => `Border Leaf ${oddEven(Number(m[1]))}` },
  {
    re: /-mgmtagg[-_]?(\d+)?(?:-n9k(\d+))?$/i,
    role: (m) => {
      const n = Number(m[1] ?? m[2]);
      return Number.isFinite(n) ? `Management Agg ${oddEven(n)}` : null;
    },
  },
  { re: /-(?:ma|agg)-n9k(\d+)$/i, role: (m) => `Management Agg ${oddEven(Number(m[1]))}` },
  { re: /-mgmt[-_]?(\d+)?(?:-n9k(\d+))?$/i, role: () => 'Management' },
  { re: /-sp-n9k(\d+)$/i, role: (m) => ('ABC'[Number(m[1]) - 1] ? `Spine ${'ABC'[Number(m[1]) - 1]}` : null) },
];

function deriveRole(name) {
  for (const { re, role } of NAME_ROLE_PATTERNS) {
    const m = name.match(re);
    if (m) {
      const r = role(m);
      if (r) return r;
    }
  }
  return null;
}

const swNameInput = document.getElementById('sw-name');
const swRoleSelect = document.getElementById('sw-role');
const swRoleHint = document.getElementById('sw-role-hint');

swNameInput.addEventListener('input', () => {
  const derived = deriveRole(swNameInput.value.trim());
  if (derived) {
    swRoleSelect.value = derived;
    swRoleHint.textContent = `Role suggested from name — override if needed`;
    swRoleHint.hidden = false;
  } else {
    swRoleHint.hidden = true;
  }
});

swRoleSelect.addEventListener('change', () => {
  swRoleHint.hidden = true;
});

// The add-device form doubles as the edit form: clicking Edit on a network
// device loads it here (editingIndex set), and submit then PUTs the change.
const swHeightSelect = document.getElementById('sw-height');
const swSubmitBtn = document.getElementById('sw-submit');
const swCancelBtn = document.getElementById('sw-cancel');
let editingIndex = null;
let managedSwitches = [];

function startEdit(i) {
  const sw = managedSwitches[i];
  if (!sw) return;
  editingIndex = i;
  document.getElementById('sw-make').value = sw.makeModel;
  document.getElementById('sw-name').value = sw.name;
  document.getElementById('sw-ip').value = sw.ip;
  document.getElementById('sw-serial').value = sw.serial;
  document.getElementById('sw-location').value = sw.locationRaw;
  swRoleSelect.value = sw.role;
  swHeightSelect.value = String(sw.heightU);
  swRoleHint.hidden = true;
  swSubmitBtn.textContent = 'Save changes';
  swCancelBtn.hidden = false;
  document.getElementById('add-switch-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setStatus(`Editing ${sw.name} — update the fields and save.`, 'busy');
}

function exitEdit() {
  editingIndex = null;
  swSubmitBtn.textContent = 'Add device';
  swCancelBtn.hidden = true;
}

swCancelBtn.addEventListener('click', () => {
  document.getElementById('add-switch-form').reset();
  exitEdit();
  swRoleHint.hidden = true;
  setStatus('Edit cancelled.', '');
});

document.getElementById('add-switch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    makeModel: document.getElementById('sw-make').value.trim(),
    name: document.getElementById('sw-name').value.trim(),
    ip: document.getElementById('sw-ip').value.trim(),
    serial: document.getElementById('sw-serial').value.trim(),
    locationRaw: document.getElementById('sw-location').value.trim(),
    role: document.getElementById('sw-role').value,
    heightU: document.getElementById('sw-height').value,
  };
  const editing = editingIndex != null;
  try {
    const res = await fetch(editing ? `/api/switches/${editingIndex}` : '/api/switches', {
      method: editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setStatus(editing ? `Updated ${data.updated.name}.` : `Added ${data.added.makeModel} (${data.added.name}).`, 'ok');
    e.target.reset();
    exitEdit();
    loadManaged();
  } catch (err) {
    setStatus(`Could not ${editing ? 'update' : 'add'} device: ${err.message}`, 'error');
  }
});

const switchCsvInput = document.getElementById('switch-csv-file');
document.getElementById('import-switch-csv').addEventListener('click', () => switchCsvInput.click());

// Chrome refuses network downloads from origins with an untrusted TLS cert
// ("Failed - Network error") even after the warning was bypassed, so fetch
// the template like any other same-origin request and save it from a local
// blob URL instead.
document.getElementById('download-example-csv').addEventListener('click', async () => {
  try {
    const res = await fetch('/switches-example.csv');
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'switches-example.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    setStatus(`Could not download template: ${err.message}`, 'error');
  }
});
switchCsvInput.addEventListener('change', async () => {
  const file = switchCsvInput.files[0];
  if (!file) return;
  setStatus(`Importing ${file.name}…`, 'busy');
  try {
    const res = await fetch('/api/switches/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: await file.text(),
    });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    const parts = [];
    if (data.added.length) parts.push(`added ${data.added.length}`);
    if (data.skipped.length) parts.push(`skipped ${data.skipped.length} already configured`);
    if (data.errors.length) parts.push(`${data.errors.length} failed: ${data.errors.map((e) => `line ${e.line} — ${e.reason}`).join('; ')}`);
    setStatus(`Import ${parts.join(' · ')}.`, data.errors.length ? 'error' : 'ok');
    loadManaged();
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, 'error');
  } finally {
    switchCsvInput.value = '';
  }
});

async function removeEntry(url, label) {
  try {
    const res = await fetch(url, { method: 'DELETE' });
    if (res.status === 401) { redirectToLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setStatus(`Removed ${label}.`, 'ok');
    loadManaged();
  } catch (err) {
    setStatus(`Could not remove ${label}: ${err.message}`, 'error');
  }
}

function renderGroup(title, items) {
  const group = document.createElement('div');
  group.className = 'managed-group';
  const h = document.createElement('h3');
  h.textContent = title;
  group.appendChild(h);
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'managed-item muted';
    empty.textContent = 'none';
    group.appendChild(empty);
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'managed-item';
    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(label);
    if (item.editIndex != null || item.removeUrl) {
      const actions = document.createElement('span');
      actions.className = 'item-actions';
      if (item.editIndex != null) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'row-edit';
        btn.textContent = 'Edit';
        btn.addEventListener('click', () => startEdit(item.editIndex));
        actions.appendChild(btn);
      }
      if (item.removeUrl) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'row-remove';
        btn.textContent = 'Remove';
        btn.addEventListener('click', () => removeEntry(item.removeUrl, item.label));
        actions.appendChild(btn);
      }
      row.appendChild(actions);
    }
    group.appendChild(row);
  }
  return group;
}

async function loadManaged() {
  const listEl = document.getElementById('managed-list');
  try {
    const res = await fetch('/api/managed');
    if (res.status === 401) { redirectToLogin(); return; }
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    managedSwitches = data.switches;
    const datalist = document.getElementById('sw-make-list');
    datalist.innerHTML = '';
    for (const model of data.models ?? []) {
      const opt = document.createElement('option');
      opt.value = model;
      datalist.appendChild(opt);
    }
    listEl.innerHTML = '';
    listEl.appendChild(renderGroup('iDRAC nodes — servers.json (edit the file to change)',
      data.static.map((h) => ({ label: h }))));
    listEl.appendChild(renderGroup('iDRAC nodes — discovered',
      data.discovered.map((d) => ({
        label: `${d.host}${d.serviceTag ? ` · ${d.serviceTag}` : ''}`,
        removeUrl: `/api/nodes/${encodeURIComponent(d.host)}`,
      }))));
    listEl.appendChild(renderGroup('Network devices',
      data.switches.map((s, i) => ({
        label: `${s.makeModel} · ${s.name} · ${s.role} · ${s.locationRaw} · ${s.heightU}U`,
        editIndex: i,
        removeUrl: `/api/switches/${i}`,
      }))));
  } catch (err) {
    listEl.textContent = `Failed to load entries: ${err.message}`;
  }
}

addRow();
loadManaged();
