// Admin Console: sign in with an email code, then five tabs. Overview: charts of usage and quality. Requests: approve the number a user asked for, or change it.
// Users: daily limit and extra resumes. Feedback: bugs, improvements, ideas with a status. Weekly review: the numbers.
// The database decides who is an admin (public.admins); this page only shows what it is allowed to read.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = window.TailorAPI;
  let users = [], requests = [], feedback = [], weeks = [], email = '', tab = 'overview', days = 30, overview = null;

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

  // ---- overview (charts) ----
  const C = window.AdminCharts;
  const sum = (list, key) => list.reduce((n, d) => n + Number(d[key] || 0), 0);
  const nice = s => String(s).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const LABELS = { wont_do: "Won't do", pending: 'Waiting', no_change: 'No change' };
  const named = list => (list || []).map(x => ({ label: LABELS[x.label] || nice(x.label), value: Number(x.count) }));
  function headline(id, total, text) {
    const node = $(id); node.textContent = Number(total).toLocaleString('en-IN');
    const small = document.createElement('small'); small.textContent = text; node.append(small);
  }
  function drawOverview() {
    if (!overview) return;
    C.hideTip();
    const daily = overview.daily || [];
    const series = key => daily.map(d => {
      const date = new Date(d.day + 'T00:00:00');
      return { label: date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        title: date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), value: Number(d[key]) };
    });
    const range = `in the last ${overview.days} days`;
    headline('h-resumes', sum(daily, 'resumes'), range);
    headline('h-signups', sum(daily, 'signups'), range);
    headline('h-downloads', sum(daily, 'downloads'), range);
    C.columns($('c-resumes'), series('resumes'), { color: 'blue', label: 'Resumes made per day', unit: 'Resumes' });
    C.columns($('c-signups'), series('signups'), { color: 'orange', label: 'New sign-ups per day', unit: 'Sign-ups' });
    C.columns($('c-downloads'), series('downloads'), { color: 'blue', label: 'PDF downloads per day', unit: 'Downloads' });
    const f = overview.funnel || {}, base = Number(f.signed_up) || 0;
    const pct = v => base ? Math.round((100 * v) / base) + '%' : '';
    C.bars($('c-funnel'), [['Signed up', f.signed_up], ['Made a resume', f.made_resume], ['Downloaded a PDF', f.downloaded]]
      .map(([label, v]) => ({ label, value: Number(v) || 0, note: pct(Number(v) || 0) })), { label: 'From sign-up to download', labelHead: 'Step', unit: 'People' });
    const r = overview.ratings || {}, total = (r.up || 0) + (r.down || 0);
    $('c-ratings').replaceChildren(...[['👍 Good', r.up || 0], ['👎 Needs work', r.down || 0], ['Share good', total ? Math.round((100 * (r.up || 0)) / total) + '%' : '–']].map(([label, v]) => {
      const div = document.createElement('div'), strong = document.createElement('strong'), span = document.createElement('span');
      strong.textContent = v; span.textContent = label; div.append(strong, span); return div;
    }));
    C.bars($('c-tweaks'), named(overview.tweak_types), { label: 'Tweak types', labelHead: 'Tweak type', empty: 'No tweaks in this range yet.' });
    C.bars($('c-outcomes'), named(overview.tweak_outcomes), { label: 'Tweak results', labelHead: 'Result', empty: 'No tweaks in this range yet.' });
    C.bars($('c-dropped'), (overview.dropped_keywords || []).map(x => ({ label: x.label, value: Number(x.count) })), { label: 'Dropped keywords', labelHead: 'Keyword', unit: 'Resumes', empty: 'No dropped keywords. Good.' });
    C.bars($('c-roles'), named(overview.roles), { label: 'Top roles', labelHead: 'Role', unit: 'Resumes', empty: 'No resumes in this range yet.' });
    C.bars($('c-feedback'), named(overview.feedback_kinds), { label: 'Feedback by type', labelHead: 'Type', empty: 'No feedback in this range yet.' });
    C.bars($('c-fstatus'), named(overview.feedback_status), { label: 'Feedback status', labelHead: 'Status', empty: 'No feedback yet.' });
    headline('h-requests', overview.extra_granted || 0, 'extra resumes given so far');
    C.bars($('c-requests'), named(overview.requests), { label: 'Requests by status', labelHead: 'Status', empty: 'No requests yet.' });
  }
  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (tab === 'overview') drawOverview(); }, 150); });

  // ---- loading ----
  async function loadTab(name) {
    error('');
    try {
      if (name === 'overview') {
        try { overview = await API.adminOverview(days); $('overview-note').textContent = ''; }
        catch (e) {
          if (e.code === 'not_admin') throw e;
          overview = null; $('overview-note').textContent = 'Charts need the 0005 database update.'; return;
        }
        drawOverview();
      }
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
    ['overview', 'requests', 'users', 'feedback', 'weekly'].forEach(t => {
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
      $('admin-spam-hint').hidden = true;
      clearTimeout(spamTimer);
      spamTimer = setTimeout(() => { if ($('admin-code').value.length < 6) $('admin-spam-hint').hidden = false; }, 15000);
    } catch (e) { error(e.message); }
  });
  let spamTimer;
  $('admin-code').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
  $('admin-code-form').addEventListener('submit', async event => {
    event.preventDefault(); error('');
    try { await API.verifyCode(email, $('admin-code').value); await enter(); }
    catch (e) { error(e.message); }
  });
  ['overview', 'requests', 'users', 'feedback', 'weekly'].forEach(t => $('tab-' + t).addEventListener('click', () => showTab(t)));
  document.querySelectorAll('[data-days]').forEach(b => b.addEventListener('click', () => {
    days = Number(b.dataset.days);
    document.querySelectorAll('[data-days]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    loadTab('overview');
  }));
  document.querySelectorAll('[data-reload]').forEach(b => b.addEventListener('click', refresh));
  $('filter').addEventListener('input', drawUsers);
  $('request-filter').addEventListener('change', () => loadTab('requests'));
  $('feedback-kind').addEventListener('change', drawFeedback);
  $('feedback-status').addEventListener('change', drawFeedback);
  $('week-pick').addEventListener('change', drawWeek);
  $('admin-sign-out').addEventListener('click', async () => { await API.signOut(); location.reload(); });
  // Arrived from the profile's "Open admin panel": use the handed-over sign-in, no second code.
  API.takeHandoff().then(session => { if (session) enter().catch(e => error(e.message)); }).catch(() => {});
})();
