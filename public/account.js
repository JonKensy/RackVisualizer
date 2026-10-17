// Account menu shared by all pages. Local accounts get Change password +
// Log out; AD-only accounts get a plain Log out link (they have no local
// password to change). The decision comes from /api/account, which returns
// only the caller's own identity — hiding the menu item is UX, not access
// control; the server enforces it independently.

const menu = document.querySelector('.account-menu');
const toggle = document.querySelector('.account-toggle');
const dropdown = document.querySelector('.account-dropdown');

if (toggle && dropdown) {
  function close() {
    dropdown.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
    toggle.setAttribute('aria-expanded', String(!dropdown.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.hidden && !e.target.closest('.account-menu')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dropdown.hidden) { close(); toggle.focus(); }
  });

  // AD-only accounts have no local password to change — show a plain Log out button.
  fetch('/api/account')
    .then((res) => {
      if (res.status === 401) {
        location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
        return null;
      }
      return res.ok ? res.json() : null;
    })
    .then((data) => {
      if (data && !data.local) {
        const link = document.createElement('a');
        link.className = 'button-link';
        link.href = '/logout';
        link.textContent = 'Log out';
        menu.replaceWith(link);
      }
    })
    .catch(() => {});
}
