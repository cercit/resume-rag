// Admin page: sign in with an email code, list every user, change a user's daily resume limit.
// The database decides who is an admin (public.admins); this page only shows what it is allowed to read.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = window.TailorAPI;
  let users = [], email = '';

  function error(text) { $('admin-error').textContent = text || ''; $('admin-error').hidden = !text; }
  const when = value => value ? new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never';

  function cell(text, sub) {
    const td = document.createElement('td'); td.textContent = text;
    if (sub) { const small = document.createElement('small'); small.textContent = sub; td.append(small); }
    return td;
  }

  function draw() {
    const q = $('filter').value.trim().toLowerCase();
    const shown = users.filter(u => !q || [u.email, u.full_name, u.username].some(v => (v || '').toLowerCase().includes(q)));
    $('rows').replaceChildren(...shown.map(u => {
      const tr = document.createElement('tr');
      const today = cell(`${u.resumes_24h} of ${u.daily_limit}`);
      if (u.resumes_24h >= u.daily_limit) today.className = 'used-up';
      const limitTd = document.createElement('td'), box = document.createElement('div'), input = document.createElement('input'), save = document.createElement('button');
      box.className = 'limit-cell';
      Object.assign(input, { type: 'number', min: 0, max: 50, step: 1, value: u.daily_limit });
      input.setAttribute('aria-label', `Daily limit for ${u.email}`);
      save.className = 'button small outline'; save.type = 'button'; save.textContent = 'Save';
      save.addEventListener('click', async () => {
        error(''); save.disabled = true;
        try {
          u.daily_limit = await API.adminSetLimit(u.user_id, input.value);
          save.textContent = 'Saved'; setTimeout(() => { save.textContent = 'Save'; draw(); }, 1200);
        } catch (e) { error(e.message); }
        finally { save.disabled = false; }
      });
      box.append(input, save); limitTd.append(box);
      tr.append(cell(u.email, [u.full_name, u.username && '@' + u.username].filter(Boolean).join(' · ')),
        cell(when(u.joined_at)), cell(when(u.last_sign_in_at)), today, cell(String(u.resumes_7d)), limitTd);
      return tr;
    }));
    $('summary').textContent = `${shown.length} of ${users.length} users`;
  }

  async function load() {
    error('');
    try { users = await API.adminUsers(); draw(); }
    catch (e) { error(e.message); }
  }

  async function enter() {
    if (!(await API.isAdmin())) { error('This account is not an admin.'); await API.signOut(); return; }
    $('sign-in').hidden = true; $('users').hidden = false; $('admin-sign-out').hidden = false;
    await load();
  }

  $('admin-email-form').addEventListener('submit', async event => {
    event.preventDefault(); error('');
    try {
      email = $('admin-email').value.trim();
      await API.sendCode(email);
      $('admin-email-form').hidden = true; $('admin-code-form').hidden = false; $('admin-code').focus();
    } catch (e) { error(e.message); }
  });
  $('admin-code').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
  $('admin-code-form').addEventListener('submit', async event => {
    event.preventDefault(); error('');
    try { await API.verifyCode(email, $('admin-code').value); await enter(); }
    catch (e) { error(e.message); }
  });
  $('filter').addEventListener('input', draw);
  $('reload').addEventListener('click', load);
  $('admin-sign-out').addEventListener('click', async () => { await API.signOut(); location.reload(); });
})();
