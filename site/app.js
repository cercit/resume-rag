(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const API = window.TailorAPI;
  const DEMO = window.TailorDemo;
  const clone = value => JSON.parse(JSON.stringify(value));
  const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const stageDefinitions = [
    { title: 'Reading your experience', detail: 'Getting to know your roles, skills and achievements.', start: 0, end: 4 },
    { title: 'Understanding the opportunity', detail: 'Finding where your experience meets the role.', start: 4, end: 9 },
    { title: 'Finding the right words', detail: 'Bringing your most relevant work forward.', start: 9, end: 19 },
    { title: 'Keeping your story honest', detail: 'Checking claims against your original resume.', start: 19, end: 26 },
    { title: 'Adding the finishing touches', detail: 'Preparing a clean, readable A4 layout.', start: 26, end: 30 }
  ];
  const state = { view: 'home', session: null, demo: false, sample: false, busy: false, run: 0, controller: null,
    waitTimer: null, startedAt: 0, stage: -1, tip: Math.floor(Math.random() * DEMO.tips.length), tipPaused: reducedMotion.matches,
    tipLastAt: 0, quiz: 0, completed: false, failed: false, resume: null, notes: null, sessionId: null,
    history: [], tweaksLeft: 10, versions: 1, pendingGenerate: false, email: '', codeSentAt: 0, otpTimer: null,
    toastTimer: null, motionOff: reducedMotion.matches, authEpoch: 0 };

  function pref(key, value) {
    try { if (value !== undefined) localStorage.setItem(key, value); else return localStorage.getItem(key); } catch (_) { /* Preferences are optional. */ }
  }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
  }
  function message(target, text) { $(target).textContent = text; $(target).hidden = !text; }
  function announce(text) { $('stage-announcement').textContent = text; }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('theme-toggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    $('theme-toggle').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
    pref('resume-tailor-theme', theme);
  }
  function setMotion(off) {
    state.motionOff = off;
    document.documentElement.dataset.motion = off ? 'off' : 'on';
    $('motion-toggle').textContent = off ? 'Motion off' : 'Motion on';
    $('motion-toggle').setAttribute('aria-pressed', String(off));
    if (off) setTipsPaused(true);
  }
  function showView(view, scroll = true) {
    $$('.view').forEach(el => { el.hidden = el.id !== 'view-' + view; el.classList.remove('entering'); });
    state.view = view;
    $('view-' + view).classList.add('entering');
    if (view !== 'waiting') clearInterval(state.waitTimer);
    document.title = view === 'waiting' ? 'Finding your fit — Resume Tailor' : view === 'result' ? 'Your tailored resume — Resume Tailor' : 'Resume Tailor — Your experience. A better fit.';
    if (scroll) window.scrollTo({ top: 0, behavior: 'instant' });
    const heading = $(view === 'waiting' ? 'waiting-title' : view === 'result' ? 'result-title' : 'hero-title');
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  function goHome(anchor = '') {
    if (state.view === 'waiting') stopWaiting(false);
    showView('home', !anchor);
    history.replaceState(null, '', anchor ? '#' + anchor : location.pathname + location.search);
    if (anchor) {
      $(anchor).scrollIntoView({ behavior: state.motionOff ? 'instant' : 'smooth' });
      const heading = $(anchor).querySelector('h2');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
  }
  function selectInputTab(tab, focus = false) {
    ['upload', 'paste'].forEach(name => {
      const active = name === tab;
      $('tab-' + name).classList.toggle('active', active);
      $('tab-' + name).setAttribute('aria-selected', String(active));
      $('tab-' + name).tabIndex = active ? 0 : -1;
      $('panel-' + name).hidden = !active;
    });
    if (focus) $('tab-' + tab).focus();
  }
  function counts() {
    $('resume-count').textContent = `${$('resume-text').value.length.toLocaleString('en-IN')} / 20,000`;
    $('jd-count').textContent = `${$('jd-text').value.length.toLocaleString('en-IN')} / 12,000`;
  }
  async function readFile(file) {
    if (!file || state.busy) return;
    state.busy = true;
    const zone = $('upload-zone');
    const old = zone.innerHTML;
    zone.disabled = true; $('generate-button').disabled = true;
    zone.innerHTML = icon('document') + '<strong>Reading your file…</strong><span>It stays on this device.</span>';
    message('input-error', '');
    try {
      const text = await API.extract(file);
      $('resume-text').value = text;
      selectInputTab('paste'); counts();
      toast(`${file.name} is ready. Review the extracted text.`);
    } catch (error) {
      if (typeof error.text === 'string') { $('resume-text').value = error.text; selectInputTab('paste'); counts(); }
      message('input-error', error.message || 'Could not read that file. Please paste its text.');
    } finally {
      zone.innerHTML = old; zone.disabled = false; $('generate-button').disabled = false;
      state.busy = false; $('resume-file').value = '';
    }
  }
  function validation() {
    const resume = $('resume-text').value.trim(), jd = $('jd-text').value.trim();
    if (resume.length < 200) {
      selectInputTab('paste');
      message('input-error', resume ? 'Add at least 200 characters. If your resume is a scan, paste its text here.' : 'Add your resume first. Upload a file or paste the text.');
      $('resume-text').focus(); return false;
    }
    if (resume.length > 20000) { message('input-error', 'Shorten your resume to 20,000 characters before continuing.'); $('resume-text').focus(); return false; }
    if (!jd) { message('input-error', 'Paste the job description so we can find the right fit.'); $('jd-text').focus(); return false; }
    if (jd.length > 12000) { message('input-error', 'Shorten the job description to 12,000 characters.'); $('jd-text').focus(); return false; }
    message('input-error', ''); return true;
  }

  // A real request has no stage events. Only the clearly labelled sample advances simulated stages.
  function renderStages(elapsed = 0) {
    const current = state.completed ? 5 : stageDefinitions.findIndex(s => elapsed < s.end);
    const nextStage = current < 0 ? 4 : current;
    if (state.demo && state.stage === nextStage) return;
    state.stage = nextStage;
    $('stage-list').classList.toggle('reference-stages', !state.demo && !state.completed);
    $('stage-list').replaceChildren(...stageDefinitions.map((s, i) => {
      const li = document.createElement('li');
      const complete = state.completed || (state.demo && i < nextStage);
      const active = state.demo && i === nextStage && !state.completed;
      li.className = complete ? 'complete' : active ? 'active' : '';
      if (active) li.setAttribute('aria-current', 'step');
      const circle = document.createElement('span'); circle.className = 'stage-circle'; circle.setAttribute('aria-hidden', 'true');
      circle.innerHTML = complete ? icon('check') : String(i + 1).padStart(2, '0');
      const content = document.createElement('div'); content.className = 'stage-content';
      const title = document.createElement('strong'); title.textContent = s.title;
      const detail = document.createElement('small'); detail.textContent = s.detail;
      content.append(title, detail);
      const duration = document.createElement('span'); duration.className = 'stage-duration';
      duration.textContent = state.demo ? complete ? `${s.end - s.start}s` : active ? 'Now' : '' : '';
      li.append(circle, content, duration); return li;
    }));
    if (state.demo && !state.completed) {
      $('progress-caption').textContent = `Step ${nextStage + 1} of 5 · ${stageDefinitions[nextStage].title}`;
      announce('Sample demo: ' + stageDefinitions[nextStage].title);
    }
  }
  function setTipsPaused(paused) {
    state.tipPaused = paused; state.tipLastAt = performance.now();
    $('pause-tips').innerHTML = icon(paused ? 'play' : 'pause');
    $('pause-tips').setAttribute('aria-label', paused ? 'Play tips' : 'Pause tips');
    $('pause-tips').setAttribute('aria-pressed', String(paused));
  }
  function showTip(index, manual = false) {
    state.tip = (index + DEMO.tips.length) % DEMO.tips.length;
    $('tip-title').textContent = DEMO.tips[state.tip].title;
    $('tip-body').textContent = DEMO.tips[state.tip].body;
    $('tip-counter').textContent = String(state.tip + 1).padStart(2, '0') + ' / ' + String(DEMO.tips.length).padStart(2, '0');
    $('tip-dots').replaceChildren(...DEMO.tips.map((_, i) => { const dot = document.createElement('i'); if (i === state.tip) dot.className = 'active'; return dot; }));
    $('tip-content').classList.remove('changing');
    requestAnimationFrame(() => $('tip-content').classList.add('changing'));
    state.tipLastAt = performance.now();
    if (manual) { setTipsPaused(true); announce(DEMO.tips[state.tip].title + ' ' + DEMO.tips[state.tip].body); }
  }
  function showQuiz(index) {
    state.quiz = index % DEMO.quizzes.length;
    const q = DEMO.quizzes[state.quiz];
    $('quiz-question').textContent = q.question;
    $('quiz-feedback').hidden = true; $('next-quiz').hidden = true;
    $('quiz-options').replaceChildren(...q.options.map((option, i) => {
      const button = document.createElement('button'); button.type = 'button';
      const letter = document.createElement('span'); letter.textContent = String.fromCharCode(65 + i); letter.setAttribute('aria-hidden', 'true');
      button.append(letter, document.createTextNode(option));
      button.addEventListener('click', () => {
        $$('#quiz-options button').forEach((b, index) => { b.disabled = true; b.classList.toggle('correct', index === q.answer); b.classList.toggle('incorrect', index === i && i !== q.answer); });
        message('quiz-feedback', (i === q.answer ? 'Exactly. ' : 'A useful distinction: ') + q.explanation);
        $('next-quiz').hidden = false;
      });
      return button;
    }));
  }
  function tickWaiting() {
    if (state.completed || state.failed || state.view !== 'waiting') return;
    const elapsed = (performance.now() - state.startedAt) / 1000;
    const whole = Math.floor(elapsed);
    $('elapsed').innerHTML = String(Math.floor(whole / 60)).padStart(2, '0') + '<span>:</span>' + String(whole % 60).padStart(2, '0');
    if (state.demo) {
      const value = Math.min(100, elapsed / 30 * 100);
      $('progress-fill').style.width = value + '%';
      $('progress-track').setAttribute('aria-valuenow', String(Math.floor(value)));
      renderStages(elapsed);
      if (elapsed >= 30) { finishWaiting({ resume: clone(DEMO.resume), notes: clone(DEMO.notes), tweaks_left: 10 }); return; }
    } else if (elapsed >= 90) {
      $('time-estimate').textContent = 'Taking longer than usual';
      $('time-detail').textContent = 'Still waiting for a response';
      $('wait-reassurance').textContent = 'Your request is still pending. You can keep browsing the tips.';
      if (elapsed >= 180) {
        state.controller?.abort();
        failWaiting(new Error('The service took too long to respond. Your inputs are still here. Return to the workspace and try again later.'));
        return;
      }
    } else if (elapsed >= 75) $('time-detail').textContent = 'A little longer. Still working on it.';
    const focusInTips = $('tip-card').contains(document.activeElement);
    if (!state.tipPaused && !document.hidden && !focusInTips && performance.now() - state.tipLastAt >= 8000) showTip(state.tip + 1);
  }
  function beginWaiting(demo) {
    if (state.busy) return;
    state.controller?.abort(); clearInterval(state.waitTimer);
    Object.assign(state, { demo, completed: false, failed: false, startedAt: performance.now(), stage: -1, busy: true, run: state.run + 1 });
    const run = state.run;
    state.controller = new AbortController();
    $('waiting-title').innerHTML = 'Good things take<br>a little <span class="accent">tailoring.</span>';
    $('waiting-description').textContent = 'Your next chapter is taking shape. Here\'s what goes into it.';
    $('waiting-mode').textContent = demo ? 'SAMPLE DEMO · SIMULATED STAGES' : 'YOUR RESUME · LIVE REQUEST';
    $('progress-eyebrow').textContent = demo ? 'YOUR RESUME, IN THE MAKING' : 'WHAT GOES INTO YOUR RESUME';
    $('time-estimate').textContent = demo ? '30-second sample demo' : 'Usually about a minute';
    $('time-detail').textContent = demo ? 'Real generation is usually 54–90 seconds' : 'Timing varies with the AI service';
    $('progress-badge').innerHTML = '<i></i> Working';
    $('progress-track').classList.toggle('indeterminate', !demo);
    $('progress-track').setAttribute('aria-label', demo ? 'Sample demo progress' : 'Waiting for the resume service');
    if (demo) $('progress-track').setAttribute('aria-valuenow', '0'); else $('progress-track').removeAttribute('aria-valuenow');
    $('progress-fill').style.width = '0%';
    $('progress-caption').textContent = demo ? '' : 'Request sent · The steps below explain the process, not live status.';
    $('wait-reassurance').textContent = 'A clearer story, built from your experience.';
    $('wait-complete-actions').hidden = true;
    $('ready-shortcut').hidden = true;
    $('pause-tips').disabled = false;
    message('waiting-error', '');
    setTipsPaused(state.motionOff || reducedMotion.matches);
    showTip(state.tip + 1); showQuiz(state.quiz);
    showView('waiting'); history.replaceState(null, '', '#waiting');
    renderStages(0); tickWaiting();
    state.waitTimer = setInterval(tickWaiting, 250);
    if (!demo) {
      API.generate($('resume-text').value, $('jd-text').value, state.controller.signal)
        .then(response => { if (run === state.run && !state.failed && state.view === 'waiting') finishWaiting(response); })
        .catch(error => { if (run === state.run && !state.failed && error.name !== 'AbortError') failWaiting(error); });
    }
  }
  function finishWaiting(response) {
    if (!response?.resume?.contact) { failWaiting(new Error('The service returned an incomplete resume. Your original inputs are still here.')); return; }
    clearInterval(state.waitTimer);
    Object.assign(state, { completed: true, busy: false, resume: response.resume, notes: response.notes || {}, sessionId: response.session_id || null,
      tweaksLeft: response.tweaks_left ?? 10, history: [], versions: 1 });
    $('progress-track').classList.remove('indeterminate');
    $('progress-track').setAttribute('aria-valuenow', '100'); $('progress-fill').style.width = '100%';
    $('progress-badge').innerHTML = icon('check') + ' Ready';
    $('progress-caption').textContent = state.demo ? 'Sample complete · Ready for your review' : 'Resume received · Ready for your review';
    $('waiting-title').innerHTML = 'A little more clarity.<br>A <span class="accent">better fit.</span>';
    $('waiting-description').textContent = 'Your resume is ready. Take a look whenever you\'re ready.';
    $('time-estimate').textContent = 'Ready for your review'; $('time-detail').textContent = 'Every change is yours to review';
    $('wait-reassurance').textContent = 'Your resume is ready. Review every detail before applying.';
    renderStages(30); setTipsPaused(true);
    $('pause-tips').disabled = true;
    $('wait-complete-actions').hidden = false;
    $('ready-shortcut').hidden = false;
    announce('Your resume is ready. Use Review your resume to continue.');
  }
  function friendlyError(error) {
    const errors = { daily_session_limit: 'You have used today\'s 3 sessions. Please try again tomorrow.', tweak_limit_reached: 'All 10 tweaks have been used. You can still undo or download.', busy: 'The previous request is still being processed. Please wait before trying again.', not_signed_in: 'Your sign-in has expired. Please sign in again.', nothing_to_undo: 'There is no earlier version to restore.', llm_busy: 'The AI service is busy right now. Wait a minute and try again. Your inputs are still here, and no tweak was used.' };
    return errors[error.code] || (error.status >= 500 ? 'The resume service could not finish this time. Your inputs are still here.' : error.message) || 'Something did not finish. Please try again.';
  }
  function failWaiting(error) {
    clearInterval(state.waitTimer); state.busy = false; state.failed = true;
    $('progress-track').classList.remove('indeterminate');
    $('progress-fill').style.width = '0%';
    $('progress-track').removeAttribute('aria-valuenow');
    $('progress-badge').textContent = 'Not completed';
    $('progress-caption').textContent = 'No result received';
    $('waiting-title').innerHTML = 'A small <span class="accent">pause.</span>';
    $('waiting-description').textContent = 'We couldn\'t finish this time. Your inputs are still here.';
    $('time-estimate').textContent = 'Request ended'; $('time-detail').textContent = 'Return to the workspace to retry';
    message('waiting-error', friendlyError(error));
    setTipsPaused(true); announce('The request did not finish. Your inputs are still here.');
    $('pause-tips').disabled = true;
  }
  function stopWaiting(notify = true) {
    const running = state.busy;
    state.run++; state.controller?.abort(); clearInterval(state.waitTimer); state.busy = false;
    showView('home'); history.replaceState(null, '', '#workspace'); $('workspace').scrollIntoView();
    if (notify && running) toast(state.demo ? 'Demo stopped. You can replay it anytime.' : 'Stopped waiting. Your inputs are still here. Server processing may continue.');
  }

  function chipList(id, items) {
    $(id).replaceChildren(...(items || []).map(text => { const span = document.createElement('span'); span.textContent = text; return span; }));
    if (!items?.length) $(id).textContent = 'None reported';
  }
  function scaleResume() {
    const wrap = $('resume-preview-wrap'), frame = $('resume-preview');
    if (state.view !== 'result' || !frame.contentDocument?.body) return;
    const padding = parseFloat(getComputedStyle(wrap).paddingLeft) * 2;
    const scale = Math.min(1, (wrap.clientWidth - padding) / 794);
    const height = Math.max(1123, frame.contentDocument.body.scrollHeight + 110);
    frame.style.height = height + 'px'; frame.style.transform = `scale(${scale})`;
    wrap.style.height = height * scale + padding + 'px'; wrap.style.minHeight = '0';
  }
  async function drawResult() {
    $('tweaks-left').textContent = `${state.tweaksLeft} of 10 tweaks left`;
    $('version-label').textContent = `Version ${state.versions}`;
    $('apply-tweak').disabled = state.tweaksLeft <= 0 || state.busy;
    $('undo-tweak').disabled = state.versions <= 1 || state.busy;
    chipList('keywords-found', state.notes?.keywords_found); chipList('keywords-missing', state.notes?.keywords_missing);
    $('gaps').replaceChildren(...(state.notes?.gaps || []).map(gap => { const li = document.createElement('li'); li.textContent = gap; return li; }));
    const fit = await window.ResumeRender.fit($('resume-preview'), state.resume);
    $('fit-status').textContent = fit.fits ? `${fit.pages} page${fit.pages === 1 ? '' : 's'} · A4` : 'Over 2 pages · try a shorter version';
    const style = $('resume-preview').contentDocument.createElement('style');
    style.textContent = '@media screen { body { margin:50px 56px!important; } }';
    $('resume-preview').contentDocument.head.append(style);
    scaleResume();
  }
  async function reviewResult() {
    showView('result'); history.replaceState(null, '', '#result'); message('tweak-status', '');
    await drawResult();
  }
  function lockEdits(locked) {
    state.busy = locked;
    $('apply-tweak').disabled = locked || state.tweaksLeft <= 0;
    $('undo-tweak').disabled = locked || state.versions <= 1;
    $('download-pdf').disabled = locked;
    $('start-over').disabled = locked;
    $$('[data-tweak]').forEach(button => { button.disabled = locked; });
  }
  function demoTweak(instruction) {
    const result = clone(state.resume), normalized = instruction.toLowerCase().trim().replace(/[.!]+$/, '');
    if (/^(shorten (the |my )?summary|shorter summary)$/.test(normalized)) {
      if (result.summary.length === 1 && result.summary[0] === DEMO.resume.summary[0]) throw new Error('The sample summary is already short. Try putting projects first. No tweak used.');
      result.summary = [DEMO.resume.summary[0]];
    } else if (/^(put )?projects first$/.test(normalized)) {
      if (result.order?.[0] === 'portfolio') throw new Error('Projects are already first. Try a shorter summary. No tweak used.');
      result.order = ['portfolio', 'experience'];
    } else if (/^(put )?experience first$/.test(normalized)) {
      if (result.order?.[0] === 'experience') throw new Error('Experience is already first. No tweak used.');
      result.order = ['experience', 'portfolio'];
    } else throw new Error('The sample supports “shorten the summary”, “put projects first” and “put experience first”. Sign in with your own resume for other edits. No tweak used.');
    return result;
  }
  async function applyTweak() {
    if (state.busy || state.tweaksLeft <= 0) return;
    const instruction = $('tweak-text').value.trim();
    if (!instruction) { message('tweak-status', 'Type a change or choose a suggestion above.'); $('tweak-text').focus(); return; }
    lockEdits(true); message('tweak-status', 'Making your change…');
    const previous = { resume: clone(state.resume), notes: clone(state.notes) };
    let tweakController, tweakTimeout;
    try {
      if (state.demo) { state.resume = demoTweak(instruction); state.tweaksLeft--; }
      else {
        tweakController = new AbortController();
        tweakTimeout = setTimeout(() => tweakController.abort(), 45000);
        const response = await API.tweak(state.sessionId, instruction, tweakController.signal);
        if (!response?.resume?.contact) throw new Error('An incomplete result was returned. Your previous version is still here.');
        state.resume = response.resume; state.tweaksLeft = response.tweaks_left;
        if (response.notes) state.notes = { ...state.notes, ...response.notes };
      }
      state.history.push(previous); state.versions++;
      $('tweak-text').value = ''; await drawResult();
      message('tweak-status', 'Updated. You can undo this change for free.');
    } catch (error) {
      if (error.code === 'tweak_limit_reached') state.tweaksLeft = 0;
      message('tweak-status', error.name === 'AbortError' ? 'The change took too long. Your previous version is still here. The server may still be processing it; wait a moment before trying again.' : friendlyError(error));
    } finally { clearTimeout(tweakTimeout); lockEdits(false); }
  }
  async function undoTweak() {
    if (state.busy || state.versions <= 1) return;
    lockEdits(true); message('tweak-status', 'Restoring your previous version…');
    try {
      const previous = state.history[state.history.length - 1];
      state.resume = state.demo ? previous.resume : await API.undo(state.sessionId);
      if (previous) state.notes = previous.notes;
      state.history.pop(); state.versions--; await drawResult();
      message('tweak-status', 'Previous version restored. Undo did not use a tweak.');
    } catch (error) { message('tweak-status', friendlyError(error)); }
    finally { lockEdits(false); }
  }

  function updateAccount(session) {
    state.session = session;
    $('account-button').innerHTML = (session ? 'Sign out ' : 'Sign in ') + icon('up-right');
    $('account-button').title = session ? `Signed in as ${session.user?.email || 'you'}` : 'Sign in with an email code';
  }
  async function requestGeneration() {
    if (state.busy || !validation()) return;
    counts();
    if (state.session) { beginWaiting(false); return; }
    state.pendingGenerate = true; await openAuth();
  }
  async function openAuth() {
    message('auth-error', '');
    $('auth-dialog').showModal();
    $('auth-email').focus();
    try {
      const session = await API.init();
      if (!$('auth-dialog').open) return;
      if (session) {
        updateAccount(session); $('auth-dialog').close();
        const pending = state.pendingGenerate; state.pendingGenerate = false;
        if (pending) beginWaiting(false); else toast('You are already signed in.');
      }
    } catch (error) { message('auth-error', friendlyError(error)); }
  }
  function otpTick() {
    const elapsed = Math.floor((Date.now() - state.codeSentAt) / 1000), left = Math.max(0, 600 - elapsed), cooldown = Math.max(0, 60 - elapsed);
    $('code-expiry').textContent = left ? `Valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Code expired. Request a new one.';
    $('resend-code').disabled = cooldown > 0;
    $('resend-code').textContent = cooldown ? `Resend in ${cooldown}s` : 'Resend code';
  }
  async function sendCode() {
    const email = $('auth-email').value.trim();
    const epoch = ++state.authEpoch;
    const buttons = $$('#auth-dialog button[type="submit"], #resend-code'); buttons.forEach(button => { button.disabled = true; });
    message('auth-error', '');
    try {
      await API.sendCode(email);
      if (epoch !== state.authEpoch || !$('auth-dialog').open) return;
      state.email = email; state.codeSentAt = Date.now();
      $('email-form').hidden = true; $('code-form').hidden = false; $('auth-code').value = '';
      $('auth-title').textContent = 'Check your inbox.';
      $('auth-description').textContent = `We sent a code to ${email}. Check your spam folder if it hasn't arrived.`;
      clearInterval(state.otpTimer); otpTick(); state.otpTimer = setInterval(otpTick, 1000); $('auth-code').focus();
    } catch (error) { message('auth-error', friendlyError(error)); }
    finally { buttons.forEach(button => { button.disabled = false; }); if (state.codeSentAt) otpTick(); }
  }
  function resetAuthForms() {
    state.authEpoch++;
    clearInterval(state.otpTimer); state.codeSentAt = 0;
    $('email-form').hidden = false; $('code-form').hidden = true;
    $('auth-title').innerHTML = 'Your next chapter,<br>in your inbox.';
    $('auth-description').textContent = 'Sign in with a 6-digit email code. No password to remember.';
    message('auth-error', '');
  }

  // Navigation and input interactions.
  setTheme(pref('resume-tailor-theme') === 'light' ? 'light' : 'dark');
  setMotion(reducedMotion.matches || pref('resume-tailor-motion') === 'off');
  $('theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('motion-toggle').addEventListener('click', () => { setMotion(!state.motionOff); pref('resume-tailor-motion', state.motionOff ? 'off' : 'on'); });
  reducedMotion.addEventListener('change', event => setMotion(event.matches || pref('resume-tailor-motion') === 'off'));
  $$('[data-home-anchor]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); goHome(link.dataset.homeAnchor); }));
  $$('.brand').forEach(link => link.addEventListener('click', event => { event.preventDefault(); goHome(); }));
  $$('[data-action="privacy"]').forEach(button => button.addEventListener('click', () => $('privacy-dialog').showModal()));
  $$('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  }));
  $('tab-upload').addEventListener('click', () => selectInputTab('upload'));
  $('tab-paste').addEventListener('click', () => selectInputTab('paste'));
  $$('.input-tab').forEach(button => button.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); selectInputTab(event.key === 'Home' ? 'upload' : event.key === 'End' ? 'paste' : button.id === 'tab-upload' ? 'paste' : 'upload', true);
    }
  }));
  ['resume-text', 'jd-text'].forEach(id => $(id).addEventListener('input', counts));
  $('upload-zone').addEventListener('click', () => $('resume-file').click());
  $('resume-file').addEventListener('change', () => readFile($('resume-file').files[0]));
  ['dragenter', 'dragover'].forEach(name => $('upload-zone').addEventListener(name, event => { event.preventDefault(); $('upload-zone').classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(name => $('upload-zone').addEventListener(name, event => { event.preventDefault(); $('upload-zone').classList.remove('dragover'); }));
  $('upload-zone').addEventListener('drop', event => readFile(event.dataTransfer.files[0]));
  $('generate-button').addEventListener('click', requestGeneration);
  $('stop-waiting').addEventListener('click', () => stopWaiting());
  $('previous-tip').addEventListener('click', () => showTip(state.tip - 1, true));
  $('next-tip').addEventListener('click', () => showTip(state.tip + 1, true));
  $('pause-tips').addEventListener('click', () => setTipsPaused(!state.tipPaused));
  $('next-quiz').addEventListener('click', () => showQuiz(state.quiz + 1));
  $('review-result').addEventListener('click', reviewResult);
  $('ready-shortcut').addEventListener('click', reviewResult);
  $('apply-tweak').addEventListener('click', applyTweak);
  $('undo-tweak').addEventListener('click', undoTweak);
  $$('[data-tweak]').forEach(button => button.addEventListener('click', () => { $('tweak-text').value = button.dataset.tweak; $('tweak-text').focus(); }));
  $('tweak-text').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); applyTweak(); } });
  $('download-pdf').addEventListener('click', () => { if (state.resume && !state.busy) window.ResumeRender.print($('resume-preview')); });
  $('start-over').addEventListener('click', () => { if (state.busy) return; state.resume = null; state.sessionId = null; $('jd-text').value = ''; counts(); goHome('workspace'); });
  window.addEventListener('resize', scaleResume);
  document.addEventListener('visibilitychange', () => { state.tipLastAt = performance.now(); if (!document.hidden && state.view === 'waiting') tickWaiting(); });
  API.onAuthChange(session => updateAccount(session));
  $('account-button').addEventListener('click', async () => {
    if (state.busy) { toast('Finish the current action before changing accounts.'); return; }
    if (!state.session) { state.pendingGenerate = false; openAuth(); return; }
    try {
      await API.signOut(); updateAccount(null);
      if (!state.demo) { state.resume = null; state.notes = null; state.history = []; state.sessionId = null; goHome(); }
      toast('Signed out.');
    } catch (error) { toast(friendlyError(error)); }
  });
  $('email-form').addEventListener('submit', event => { event.preventDefault(); sendCode(); });
  $('resend-code').addEventListener('click', sendCode);
  $('change-email').addEventListener('click', () => { resetAuthForms(); $('auth-email').focus(); });
  $('auth-code').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
  $('code-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('code-form').querySelector('button[type="submit"]'); button.disabled = true;
    const epoch = state.authEpoch;
    message('auth-error', '');
    try {
      const session = await API.verifyCode(state.email, $('auth-code').value);
      if (!session) throw new Error('Sign-in did not complete. Request a new code.');
      updateAccount(session);
      if (!$('auth-dialog').open || epoch !== state.authEpoch) return;
      const pending = state.pendingGenerate; state.pendingGenerate = false;
      $('auth-dialog').close(); resetAuthForms();
      if (pending) beginWaiting(false); else { toast('Signed in. Your next chapter is waiting.'); goHome('workspace'); }
    } catch (error) { message('auth-error', friendlyError(error)); }
    finally { button.disabled = false; }
  });
  $('auth-dialog').addEventListener('close', () => { state.pendingGenerate = false; state.authEpoch++; });

  // Pointer motion is decorative. It never moves interactive targets.
  const visual = document.querySelector('.hero-visual'), paper = document.querySelector('[data-tilt]');
  visual.addEventListener('pointermove', event => {
    if (state.motionOff || reducedMotion.matches || event.pointerType !== 'mouse') return;
    const rect = visual.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width - .5, y = (event.clientY - rect.top) / rect.height - .5;
    paper.style.transform = `rotate(5deg) rotateY(${x * 12}deg) rotateX(${-y * 10}deg)`;
  });
  visual.addEventListener('pointerleave', () => { paper.style.transform = ''; });
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('revealed'); observer.unobserve(entry.target); } }), { threshold: .06 });
    $$('.how-section,.honesty').forEach(el => { el.classList.add('scroll-reveal'); observer.observe(el); });
  }
  counts(); showTip(state.tip); showQuiz(0);
  // No demo: #waiting and #result only exist during a real request, so a direct link or reload goes to the workspace.
  if (location.hash === '#waiting' || location.hash === '#result') { history.replaceState(null, '', location.pathname); }
})();
