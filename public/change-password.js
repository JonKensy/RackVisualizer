// Change-password page. The client-side checks here are UX only — the
// server re-verifies the current password, the minimum length, and the
// local-vs-AD status on every POST.

const statusEl = document.getElementById('cp-status');

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind;
  statusEl.hidden = !message;
}

function toLogin() {
  location.href = '/login?next=' + encodeURIComponent('/change-password');
}

async function init() {
  const res = await fetch('/api/account');
  if (res.status === 401) { toLogin(); return; }
  if (!res.ok) { setStatus(`Failed to load account: ${res.status}`, 'error'); return; }
  const data = await res.json();
  if (!data.local) {
    document.getElementById('cp-ad-note').hidden = false;
    return;
  }
  document.getElementById('cp-intro').textContent =
    `This changes the app's local login for ${data.user} — separate from any Active Directory password.`;
  document.getElementById('cp-form').hidden = false;
}

document.getElementById('cp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch('/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: document.getElementById('cp-current').value,
        newPassword: document.getElementById('cp-new').value,
        confirmPassword: document.getElementById('cp-confirm').value,
      }),
    });
    if (res.status === 401) { toLogin(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    e.target.reset();
    setStatus('Password updated.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

init();
