// Resume tailor front end. Plain JS, no build step.
// Files become text here in the browser (pdf.js, mammoth). Only text is sent to the server.
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
const MIN_TEXT = 200;

const cfg = window.APP_CONFIG || {};
const $ = (id) => document.getElementById(id);
const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("PROJECT_REF") && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.startsWith("PASTE");
if (!configured) $("setup-warning").hidden = false;

const sb = window.supabase.createClient(cfg.SUPABASE_URL || "http://localhost", cfg.SUPABASE_ANON_KEY || "none", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const state = { email: "", sessionId: null, resume: null, versions: 1, tweaksLeft: 10, notes: null };

// ---------- messages in plain words ----------

const MESSAGES = {
  daily_session_limit: "You have used today's 3 sessions. Try again tomorrow.",
  tweak_limit_reached: "No tweaks left.",
  busy: "Still working on the last change.",
  not_signed_in: "Please sign in again.",
  nothing_to_undo: "Nothing to undo.",
};

function showError(msg) {
  const el = $("error");
  el.textContent = msg;
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ block: "nearest" });
}

function busy(on, text) {
  $("busy").hidden = !on;
  if (text) $("busy-text").textContent = text;
}

function show(screen) {
  for (const s of ["signin", "input", "result"]) $(`screen-${s}`).hidden = s !== screen;
  window.scrollTo(0, 0);
}

// ---------- sign in (email one-time code) ----------

$("email-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showError("");
  state.email = $("email").value.trim();
  busy(true, "Sending code...");
  const { error } = await sb.auth.signInWithOtp({ email: state.email, options: { shouldCreateUser: true } });
  busy(false);
  if (error) return showError(error.status === 429 ? "Too many codes asked for. Wait a minute and try again." : "Could not send the code. Check the email address.");
  $("email-form").hidden = true;
  $("code-form").hidden = false;
  $("code").focus();
});

$("code-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showError("");
  busy(true, "Signing in...");
  const { error } = await sb.auth.verifyOtp({ email: state.email, token: $("code").value.trim(), type: "email" });
  busy(false);
  if (error) return showError("That code did not work. Check it, or ask for a new one.");
});

$("code-back").addEventListener("click", () => {
  $("code-form").hidden = true;
  $("email-form").hidden = false;
});

$("sign-out").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((_event, session) => {
  $("who").hidden = !session;
  $("who-email").textContent = session?.user?.email || "";
  if (!session) {
    show("signin");
    $("code-form").hidden = true;
    $("email-form").hidden = false;
  } else if ($("screen-signin").hidden === false || !state.resume) {
    show(state.resume ? "result" : "input");
  }
});

// ---------- resume file to text, in the browser ----------

async function pdfText(buf) {
  const pdfjs = await import(PDFJS);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join(""));
  }
  return pages.join("\n");
}

async function docxText(buf) {
  const res = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return res.value;
}

function tidy(text) {
  return text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

$("file").addEventListener("change", async () => {
  const f = $("file").files[0];
  if (!f) return;
  showError("");
  busy(true, "Reading your file...");
  try {
    const buf = await f.arrayBuffer();
    const name = f.name.toLowerCase();
    let text;
    if (name.endsWith(".pdf")) text = await pdfText(buf);
    else if (name.endsWith(".docx")) text = await docxText(buf);
    else throw new Error("type");
    text = tidy(text);
    $("resume-text").value = text.slice(0, 20000);
    updateCounts();
    if (text.length < MIN_TEXT) showError("This looks like a scan. Paste your resume text instead.");
    else if (text.length > 20000) showError("Your resume is over 20,000 characters, so the end was cut. Check the text below.");
  } catch (e) {
    showError(e.message === "type" ? "Please choose a PDF or DOCX file." : "Could not read that file. Paste your resume text instead.");
  } finally {
    busy(false);
  }
});

function updateCounts() {
  $("resume-count").textContent = `${$("resume-text").value.length.toLocaleString("en-IN")} / 20,000 characters`;
  $("jd-count").textContent = `${$("jd-text").value.length.toLocaleString("en-IN")} / 12,000 characters`;
}
$("resume-text").addEventListener("input", updateCounts);
$("jd-text").addEventListener("input", updateCounts);

// ---------- calling the Edge Functions ----------

async function callFunction(name, body) {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw Object.assign(new Error("not_signed_in"), { code: "not_signed_in" });
  let res;
  try {
    res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, apikey: cfg.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("network"), { code: "network" });
  }
  let json = {};
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw Object.assign(new Error(json.message || "failed"), { code: json.error || "failed", status: res.status });
  return json;
}

function errorText(e, fallback) {
  return MESSAGES[e.code] || (e.status && e.status < 500 && e.message !== "failed" ? e.message : fallback);
}

// ---------- generate ----------

$("generate").addEventListener("click", async () => {
  showError("");
  const resume_text = $("resume-text").value.trim();
  const jd_text = $("jd-text").value.trim();
  if (resume_text.length < MIN_TEXT) return showError(resume_text ? "This looks like a scan. Paste your resume text instead." : "Add your resume first.");
  if (!jd_text) return showError("Paste the job description.");
  busy(true, "Writing your resume. This takes about a minute...");
  try {
    const r = await callFunction("generate", { resume_text, jd_text });
    state.sessionId = r.session_id;
    state.resume = r.resume;
    state.tweaksLeft = r.tweaks_left;
    state.versions = 1;
    state.notes = r.notes;
    show("result");
    await drawResult();
  } catch (e) {
    showError(errorText(e, "Something failed. Please try again."));
  } finally {
    busy(false);
  }
});

// ---------- result ----------

function chips(el, items) {
  el.replaceChildren(...(items || []).map((k) => Object.assign(document.createElement("span"), { textContent: k })));
  if (!items || !items.length) el.textContent = "None";
}

async function drawResult() {
  const fit = await window.ResumeRender.fit($("preview"), state.resume);
  $("fit-status").textContent = fit.fits
    ? `${fit.pages} page${fit.pages > 1 ? "s" : ""}, A4`
    : "Over 2 pages, try asking for a shorter version";
  $("fit-status").classList.toggle("error-text", !fit.fits);
  $("tweaks-left").textContent = `${state.tweaksLeft} of 10 tweaks left`;
  $("tweak").disabled = state.tweaksLeft <= 0;
  $("undo").disabled = state.versions <= 1;
  if (state.notes) {
    chips($("kw-found"), state.notes.keywords_found);
    chips($("kw-missing"), state.notes.keywords_missing);
    $("gaps").replaceChildren(...(state.notes.gaps || []).map((g) => Object.assign(document.createElement("li"), { textContent: g })));
  }
}

$("tweak").addEventListener("click", async () => {
  showError("");
  const instruction = $("tweak-text").value.trim();
  if (!instruction) return showError("Type what you want changed.");
  busy(true, "Making the change...");
  try {
    const r = await callFunction("tweak", { session_id: state.sessionId, instruction });
    state.resume = r.resume;
    state.tweaksLeft = r.tweaks_left;
    state.versions += 1;
    if (r.notes) state.notes = { ...state.notes, ...r.notes };
    $("tweak-text").value = "";
    await drawResult();
  } catch (e) {
    if (e.code === "tweak_limit_reached") { state.tweaksLeft = 0; await drawResult(); }
    showError(errorText(e, "Something failed. You were not charged a tweak."));
  } finally {
    busy(false);
  }
});

$("undo").addEventListener("click", async () => {
  showError("");
  busy(true, "Undoing...");
  const { data, error } = await sb.rpc("undo_version", { p_session: state.sessionId });
  busy(false);
  if (error) return showError(MESSAGES[error.message] || "Could not undo. Please try again.");
  state.resume = data;
  state.versions -= 1;
  await drawResult();
});

$("download").addEventListener("click", () => {
  document.title = state.resume.file_name || "Resume";
  window.ResumeRender.print($("preview"));
  setTimeout(() => { document.title = "Resume tailor"; }, 1000);
});

$("start-over").addEventListener("click", () => {
  Object.assign(state, { sessionId: null, resume: null, versions: 1, tweaksLeft: 10, notes: null });
  $("jd-text").value = "";
  updateCounts();
  show("input");
});

updateCounts();
