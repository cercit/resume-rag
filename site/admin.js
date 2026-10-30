// Admin page: sign in with an email code, then four tabs. Requests: approve the number a user asked for, or change it.
// Users: daily limit and extra resumes. Feedback: bugs, improvements, ideas with a status. Weekly review: the numbers.
// The database decides who is an admin (public.admins); this page only shows what it is allowed to read.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = window.TailorAPI;
  let users = [], requests = [], feedback = [], weeks = [], email = '', tab = 'requests';

  function error(text) { $('admin-error').textContent = text || ''; $('admin-error').hidden = !text; }
  const when = value => value ? new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never';
  const day = value => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  function cell(text, sub, className) {
    const td = document.createElement('td'); td.textContent = text;
    if (className) td.className = className;
    if (sub) { const small = document.createElement('small'); small.textContent = sub; td.append(small); }
    return td;
  }
  function pill(text, kind) { const span = document.createElement('span'); span.className = 'pill ' + (kind || ''); span.textContent = text; return span; }
  function emptyRow(tbody, cols, text) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    tr.className = 'empty-row'; td.colSpan = cols; td.textContent = text; tr.append(td); tbody.replaceChildren(tr);
  }
  // number box + button; save(value) returns the saved value
  function editCell(value, min, max, label, buttonText, save) {
    const td = document.createElement('td'), box = document.createElement('div'), input = document.createElement('input'), button = document.createElement('button');
    box.className = 'limit-cell';
    Object.assign(input, { type: 'number', min, max, step: 1, value });
    input.setAttribute('aria-label', label);
    button.className = 'button small outline'; button.type = 'button'; button.textContent = buttonText;
    button.addEventListener('click', async () => {
      error(''); button.disabled = true;
      try { await save(input.value, button); }
      catch (e) { error(e.message); button.disabled = false; }
    });
    box.append(input, button); td.append(box);
    return td;
  }
  const who = u => [u.full_name, u.username && '@' + u.username].filter(Boolean).join(' · ');

  // ---- totals ----
  async function loadTotals() {
    const t = await API.adminStats();
    const items = [[t.users_all_time, 'people used it (all time)'], [t.resumes_all_time, 'resumes made (all time)'],
      [t.signed_up, 'signed up'], [t.resumes_7d, 'resumes in the last 7 days'], [t.pending_requests, 'requests waiting'], [t.new_feedback, 'new feedback']];
    $('totals').replaceChildren(...items.map(([n, label]) => {
      const div = document.createElement('div'), strong = document.createElement('strong'), span = document.createElement('span');
      strong.textContent = Number(n).toLocaleString('en-IN'); span.textContent = label; div.append(strong, span); return div;
    }));
    $('badge-requests').textContent = t.pending_requests; $('badge-requests').hidden = !t.pending_requests;
    $('badge-feedback').textContent = t.new_feedback; $('badge-feedback').hidden = !t.new_feedback;
  }

  // ---- requests ----
  function drawRequests() {
    if (!requests.length) { emptyRow($('request-rows'), 6, 'No requests here.'); $('request-summary').textContent = ''; return; }
    $('request-rows').replaceChildren(...requests.map(r => {
      const tr = document.createElement('tr');
      const status = document.createElement('td');
      status.append(pill(r.status === 'pending' ? 'waiting' : r.status, r.status));
      if (r.status === 'approved') { const small = document.createElement('small'); small.textContent = `${r.granted} given · ${day(r.decided_at)}`; status.append(small); }
      let decide;
      if (r.status === 'pending') {
        decide = editCell(r.requested, 1, 50, `Resumes to approve for ${r.email}`, 'Approve', async (value, button) => {
          await API.adminDecideRequest(r.id, true, value);
          button.textContent = 'Approved'; await refresh();
        });
        const decline = document.createElement('button');
        decline.className = 'button small outline'; decline.type = 'button'; decline.textContent = 'Decline';
        decline.addEventListener('click', async () => {
          if (!confirm(`Decline ${r.email}'s request for ${r.requested}?`)) return;
          error(''); decline.disabled = true;
          try { await API.adminDecideRequest(r.id, false); await refresh(); } catch (e) { error(e.message); decline.disabled = false; }
        });
        decide.firstChild.append(decline);
      } else decide = cell('–');
      tr.append(cell(r.email, who(r)), cell(`${r.requested} more`, day(r.created_at)), cell(r.reason || '–', null, 'message-cell'),
        cell(`${r.daily_limit} a day + ${r.extra} extra`, `${r.resumes_all_time} made all time`), status, decide);
      return tr;
    }));
    $('request-summary').textContent = `${requests.length} request${requests.length === 1 ? '' : 's'}`;
  }

  // ---- users ----
  function drawUsers() {
    const q = $('filter').value.trim().toLowerCase();
    const shown = users.filter(u => !q || [u.email, u.full_name, u.username].some(v => (v || '').toLowerCase().includes(q)));
    if (!shown.length) { emptyRow($('rows'), 7, 'No users match.'); }
    else $('rows').replaceChildren(...shown.map(u => {
      const tr = document.createElement('tr');
      const today = cell(`${u.resumes_24h} of ${u.daily_limit}`, u.pending_request ? `asked for ${u.pending_request} more` : null);
      if (u.resumes_24h >= u.daily_limit + u.extra) today.className = 'used-up';
      const limit = editCell(u.daily_limit, 0, 50, `Daily limit for ${u.email}`, 'Save', async (value, button) => {
        u.daily_limit = await API.adminSetLimit(u.user_id, value);
        button.textContent = 'Saved'; setTimeout(() => { button.textContent = 'Save'; button.disabled = false; drawUsers(); }, 1200);
      });
      const extra = editCell(u.extra, 0, 500, `Extra resumes for ${u.email}`, 'Save', async (value, button) => {
        u.extra = await API.adminSetExtra(u.user_id, value);
        button.textContent = 'Saved'; setTimeout(() => { button.textContent = 'Save'; button.disabled = false; drawUsers(); }, 1200);
      });
      tr.append(cell(u.email, who(u)), cell(when(u.joined_at)), cell(when(u.last_sign_in_at)), today,
        cell(String(u.resumes_all_time), `${u.resumes_7d} in 7 days`), limit, extra);
      return tr;
    }));
    $('summary').textContent = `${shown.length} of ${users.length} users`;
  }

  // ---- feedback ----
  function drawFeedback() {
    const kind = $('feedback-kind').value, status = $('feedback-status').value;
    const shown = feedback.filter(f => (!kind || f.kind === kind) && (!status || f.status === status));
    if (!shown.length) { emptyRow($('feedback-rows'), 6, 'No feedback here yet.'); }
    else $('feedback-rows').replaceChildren(...shown.map(f => {
      const tr = document.createElement('tr');
      const type = document.createElement('td'); type.append(pill(f.kind, f.kind === 'bug' ? 'new' : ''));
      if (f.rating) { const small = document.createElement('small'); small.textContent = `rated ${f.rating}/5`; type.append(small); }
      const context = { general: 'from the menu', after_generate: 'after a resume', after_tweak: 'after a tweak' }[f.context];
      let resume = '–', resumeSub = null;
      if (f.session_id) {
        resume = f.resume_role || 'linked resume';
        const dropped = Array.isArray(f.keywords_dropped) && f.keywords_dropped.length ? `dropped: ${f.keywords_dropped.join(', ')}` : null;
        resumeSub = [f.session_expired ? 'resume expired' : null, dropped].filter(Boolean).join(' · ') || null;
      }
      const statusTd = document.createElement('td'), select = document.createElement('select');
      [['new', 'New'], ['planned', 'Planned'], ['done', 'Done'], ['wont_do', "Won't do"]].forEach(([v, t]) => select.add(new Option(t, v, false, v === f.status)));
      select.setAttribute('aria-label', 'Feedback status');
      select.addEventListener('change', async () => {
        error('');
        try { f.status = await API.adminSetFeedbackStatus(f.id, select.value); loadTotals().catch(() => {}); }
        catch (e) { error(e.message); select.value = f.status; }
      });
      statusTd.append(select);
      tr.append(cell(when(f.created_at), context), type, cell(f.message, null, 'message-cell'), cell(f.email || '(deleted user)', f.full_name), cell(resume, resumeSub), statusTd);
      return tr;
    }));
    $('feedback-summary').textContent = `${shown.length} of ${feedback.length} messages (last 90 days)`;
  }

  // ---- weekly review ----
  function drawWeek() {
    const i = Number($('week-pick').value || 0), w = weeks[i], prev = weeks[i + 1];
    if (!w) { $('week-view').textContent = 'No weekly numbers yet.'; return; }
    const n = w.numbers, p = prev ? prev.numbers : null;
    const card = (key, label, suffix = '', lowerIsBetter = false) => {
      const div = document.createElement('div'), strong = document.createElement('strong'), span = document.createElement('span');
      const v = n[key];
      strong.textContent = v === null || v === undefined ? '–' : v + suffix;
      if (p && typeof v === 'number' && typeof p[key] === 'number' && v !== p[key]) {
        const em = document.createElement('em'), better = (v > p[key]) !== lowerIsBetter;
        em.className = better ? 'up' : 'down'; em.textContent = (v > p[key] ? '▲' : '▼') + Math.abs(Math.round((v - p[key]) * 10) / 10);
        strong.append(em);
      }
      span.textContent = label; div.append(strong, span); return div;
    };
    const grid = document.createElement('div'); grid.className = 'week-grid';
    grid.append(card('resumes', 'resumes made'), card('people', 'people'), card('new_users', 'new people'),
      card('download_rate', 'downloaded the PDF', '%'), card('tweaks_per_resume', 'tweaks per resume', '', true),
      card('refusal_rate', 'tweaks refused', '%', true), card('undos', 'undos', '', true), card('avg_seconds', 'seconds to generate', 's', true),
      card('thumbs_up', 'thumbs up'), card('thumbs_down', 'thumbs down', '', true), card('requests', 'requests for more'));
    const list = (title, hint, items, fmt) => {
      const section = document.createElement('section'), h = document.createElement('h3'), para = document.createElement('p'), ol = document.createElement('ol');
      h.textContent = title; para.textContent = hint;
      (items || []).forEach(x => { const li = document.createElement('li'); li.textContent = fmt(x); ol.append(li); });
      if (!items || !items.length) { const li = document.createElement('li'); li.textContent = 'Nothing yet'; ol.append(li); }
      section.append(h, para, ol); return section;
    };
    const fb = n.feedback || {};
    const lists = document.createElement('div'); lists.className = 'week-lists';
    lists.append(
      list('Dropped keywords', 'In the uploaded resume but lost in the tailored one. These are our misses: fix first.', n.top_dropped_keywords, x => `${x.keyword} (${x.count})`),
      list('Tweak types', 'What people change after generating. A big share means the first draft should do it by default.', n.tweak_types, x => `${x.type.replace('_', ' ')} (${x.count})`),
      list('Top roles', 'Which jobs people tailor for. Tune for these first.', n.top_roles, x => `${x.role} (${x.count})`),
      list('Missing keywords', 'Not in the candidate\'s resume at all: their gaps, not ours.', n.top_missing_keywords, x => `${x.keyword} (${x.count})`),
      list('Feedback this week', 'Read them in the Feedback tab.', Object.entries(fb), ([k, v]) => `${k}: ${v}`));
    $('week-view').replaceChildren(grid, lists);
  }

  // ---- loading ----
  async function loadTab(name) {
    error('');
    try {
      if (name === 'requests') { requests = await API.adminRequests($('request-filter').value); drawRequests(); }
      if (name === 'users') { users = await API.adminUsers(); drawUsers(); }
      if (name === 'feedback') { feedback = await API.adminFeedback(90); drawFeedback(); }
      if (name === 'weekly') {
        weeks = await API.adminWeeklyReports();
        const pick = $('week-pick'), keep = pick.value;
        pick.replaceChildren(...weeks.map((w, i) => new Option(i === 0 ? `This week so far (from ${day(w.week_start)})` : `Week of ${day(w.week_start)}`, String(i))));
        if (keep && Number(keep) < weeks.length) pick.value = keep;
        drawWeek();
      }
    } catch (e) { error(e.message); }
  }
  async function refresh() { await Promise.all([loadTotals().catch(e => error(e.message)), loadTab(tab)]); }
  function showTab(name) {
    tab = name;
    ['requests', 'users', 'feedback', 'weekly'].forEach(t => {
      $('tab-' + t).setAttribute('aria-selected', String(t === name));
      $('view-' + t).hidden = t !== name;
    });
    loadTab(name);
  }

  async function enter() {
    if (!(await API.isAdmin())) { error('This account is not an admin.'); await API.signOut(); return; }
    $('sign-in').hidden = true; $('panel').hidden = false; $('admin-sign-out').hidden = false;
    await refresh();
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
  ['requests', 'users', 'feedback', 'weekly'].forEach(t => $('tab-' + t).addEventListener('click', () => showTab(t)));
  document.querySelectorAll('[data-reload]').forEach(b => b.addEventListener('click', refresh));
  $('filter').addEventListener('input', drawUsers);
  $('request-filter').addEventListener('change', () => loadTab('requests'));
  $('feedback-kind').addEventListener('change', drawFeedback);
  $('feedback-status').addEventListener('change', drawFeedback);
  $('week-pick').addEventListener('change', drawWeek);
  $('admin-sign-out').addEventListener('click', async () => { await API.signOut(); location.reload(); });
})();
