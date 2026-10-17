// Rack rendering for the main page.
// Security notes: every value from /api/racks is rendered with
// createElement/textContent only — never innerHTML — so server-provided
// strings (hostnames, models, locations) cannot inject HTML or scripts.
// A 401 from the API redirects to the login page. window.open passes
// 'noopener' so the opened iDRAC tab cannot script this page.

const U_HEIGHT = 22;
const TOTAL_U = 42;

const tooltip = document.getElementById('tooltip');

async function load() {
  const racksEl = document.getElementById('racks');
  racksEl.textContent = 'Loading…';
  try {
    const res = await fetch('/api/racks');
    if (res.status === 401) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      return;
    }
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    render(await res.json());
  } catch (err) {
    racksEl.textContent = `Failed to load rack data: ${err.message}`;
  }
}

let lastData = null;
let currentEnv = null;

function envKeyOf(item) {
  if (!item.datacenter && !item.env) return null;
  return `${item.datacenter ?? ''}|${item.env ?? ''}`;
}

function envLabel(key) {
  return key.split('|').filter(Boolean).join(' ');
}

function computeEnvKeys(data) {
  const keys = new Set();
  for (const r of data.racks) { const k = envKeyOf(r); if (k) keys.add(k); }
  for (const s of data.unassigned) { const k = envKeyOf(s); if (k) keys.add(k); }
  return [...keys].sort((a, b) => envLabel(a).localeCompare(envLabel(b)));
}

function hashEnvLabel() {
  return decodeURIComponent(location.hash.replace(/^#/, ''));
}

function resolveEnvKey(envKeys, wanted) {
  if (!wanted) return null;
  return envKeys.find((k) => envLabel(k) === wanted) ?? null;
}

function render(data) {
  lastData = data;
  const envKeys = computeEnvKeys(data);
  const fromHash = resolveEnvKey(envKeys, hashEnvLabel());
  currentEnv = fromHash ?? (envKeys.includes(currentEnv) ? currentEnv : envKeys[0] ?? null);
  renderEnvSelect(envKeys);
  renderEnvironment();

  const errorsEl = document.getElementById('errors');
  errorsEl.innerHTML = '';
  if (data.errors.length > 0) {
    const h = document.createElement('h2');
    h.textContent = 'Connection errors';
    errorsEl.appendChild(h);
    for (const e of data.errors) {
      const card = document.createElement('div');
      card.className = 'error-card';
      card.textContent = `${e.host}: ${e.reason}`;
      errorsEl.appendChild(card);
    }
  }
}

function renderEnvSelect(envKeys) {
  const sel = document.getElementById('env-select');
  sel.innerHTML = '';
  for (const key of envKeys) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = envLabel(key);
    sel.appendChild(opt);
  }
  sel.value = currentEnv ?? '';
  sel.hidden = envKeys.length === 0;
}

function renderEnvironment() {
  const data = lastData;
  const racksEl = document.getElementById('racks');
  racksEl.innerHTML = '';
  for (const rack of data.racks) {
    if (envKeyOf(rack) === currentEnv) racksEl.appendChild(renderRack(rack));
  }

  const unassignedEl = document.getElementById('unassigned');
  unassignedEl.innerHTML = '';
  const shown = data.unassigned.filter((s) => envKeyOf(s) === currentEnv || envKeyOf(s) === null);
  if (shown.length > 0) {
    const h = document.createElement('h2');
    h.textContent = 'Unassigned servers';
    unassignedEl.appendChild(h);
    for (const s of shown) unassignedEl.appendChild(renderCard(s, 'unassigned-card'));
  }
}

window.addEventListener('hashchange', () => {
  if (!lastData) return;
  const envKeys = computeEnvKeys(lastData);
  const key = resolveEnvKey(envKeys, hashEnvLabel());
  if (key && key !== currentEnv) {
    currentEnv = key;
    renderEnvSelect(envKeys);
    renderEnvironment();
  }
});

document.getElementById('env-select').addEventListener('change', (e) => {
  currentEnv = e.target.value;
  location.hash = encodeURIComponent(envLabel(currentEnv));
  renderEnvironment();
});

function renderRack(rack) {
  const wrap = document.createElement('div');
  wrap.className = 'rack-wrap';

  const title = document.createElement('h2');
  title.textContent = `Rack ${rack.rackNumber}`;

  const rackEl = document.createElement('div');
  rackEl.className = 'rack';
  for (let u = 1; u <= TOTAL_U; u++) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.style.bottom = `${(u - 1) * U_HEIGHT}px`;
    slot.textContent = u;
    rackEl.appendChild(slot);
  }
  for (const server of rack.servers) rackEl.appendChild(renderServer(server));

  wrap.append(title, rackEl);
  return wrap;
}

function renderServer(server) {
  const isSwitch = server.kind === 'switch';
  const el = document.createElement('div');
  el.className = 'server' + (isSwitch ? ' switch' : '');
  const bottom = Math.max(0, server.ru - 1) * U_HEIGHT;
  const height = Math.min(server.heightU, TOTAL_U - (server.ru - 1)) * U_HEIGHT;
  el.style.bottom = `${bottom}px`;
  el.style.height = `${height}px`;
  if (server.overlap) el.classList.add('overlap');
  if (server.warnings.includes('unknown model')) el.classList.add('unknown-model');

  const label = document.createElement('span');
  label.className = 'server-label';
  if (isSwitch) {
    label.textContent = `${server.model} · ${server.role}`;
  } else {
    el.tabIndex = 0;
    const model = server.model ? server.model.replace(/^PowerEdge\s+/i, '') : 'Unknown model';
    const shortHost = server.host.replace(/^(?:idrac|drac)-/i, '').split('.')[0];
    label.textContent = `${model} · ${server.serviceTag} · ${shortHost}`;
  }
  el.appendChild(label);

  el.addEventListener('mouseenter', (e) => showTooltip(e, server));
  el.addEventListener('mousemove', moveTooltip);
  el.addEventListener('mouseleave', hideTooltip);
  if (!isSwitch) {
    el.addEventListener('click', () => window.open(`https://${server.host}`, '_blank', 'noopener'));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') window.open(`https://${server.host}`, '_blank', 'noopener');
    });
  }
  return el;
}

function renderCard(server, className) {
  const card = document.createElement('div');
  card.className = className;
  const subject = server.kind === 'switch'
    ? `${server.name} — ${server.model} (${server.role})`
    : `${server.host} — ${server.model ?? 'unknown model'}`;
  card.textContent = `${subject} — "${server.locationRaw ?? 'no location'}"`;
  return card;
}

function showTooltip(e, server) {
  const lines = server.kind === 'switch'
    ? [
        server.name,
        `Make/Model: ${server.model}`,
        `Role: ${server.role}`,
        `IP: ${server.ip}`,
        `Serial: ${server.serial}`,
        `Position: RU${server.ru} (${server.heightU}U)`,
      ]
    : [
        server.host,
        `Service tag: ${server.serviceTag}`,
        `Model: ${server.model ?? 'unknown'}`,
        `Position: RU${server.ru} (${server.heightU}U)`,
      ];
  if (server.overlap) lines.push('WARNING: overlaps another device');
  for (const w of server.warnings) if (w !== 'unknown model') lines.push(`Note: ${w}`);
  tooltip.textContent = lines.join('\n');
  tooltip.hidden = false;
  moveTooltip(e);
}

function moveTooltip(e) {
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const rect = tooltip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - pad;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

document.getElementById('refresh').addEventListener('click', load);
load();
