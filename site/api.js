(function (global) {
  "use strict";

  const SUPABASE = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";
  const MAMMOTH = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js";
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
  const LIMITS = Object.freeze({ fileBytes: 10 * 1024 * 1024, resumeMin: 200, resumeMax: 20000, jobMax: 12000, tweakMax: 300 });
  const scriptLoads = new Map();
  const authListeners = new Set();
  let clientPromise = null;

  function config() {
    return global.APP_CONFIG || {};
  }

  function configured() {
    const cfg = config();
    return typeof cfg.SUPABASE_URL === "string" && /^https:\/\//.test(cfg.SUPABASE_URL)
      && !cfg.SUPABASE_URL.includes("PROJECT_REF")
      && typeof cfg.SUPABASE_ANON_KEY === "string" && cfg.SUPABASE_ANON_KEY.length > 0
      && !cfg.SUPABASE_ANON_KEY.startsWith("PASTE");
  }

  function failure(code, message, status, extra) {
    return Object.assign(new Error(message), { code: code, status: status || 0 }, extra || {});
  }

  function authError(error, fallback) {
    return failure(error.code || "auth_failed", error.message || fallback, error.status);
  }

  function checkAborted(signal) {
    if (signal && signal.aborted) {
      throw failure("aborted", "Stopped waiting. Your inputs are still here.", 0, { name: "AbortError" });
    }
  }

  function loadScript(src, globalName) {
    if (global[globalName]) return Promise.resolve(global[globalName]);
    if (scriptLoads.has(src)) return scriptLoads.get(src);
    const pending = new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      let timer;
      let settled = false;
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        if (error) {
          script.remove();
          reject(error);
        } else {
          resolve(global[globalName]);
        }
      }
      script.src = src;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = function () {
        finish(global[globalName] ? null : failure("library_unavailable", "A required browser library did not load. Check your connection and try again."));
      };
      script.onerror = function () {
        finish(failure("library_unavailable", "A required browser library could not load. Check your connection and try again."));
      };
      timer = setTimeout(function () {
        finish(failure("library_timeout", "The browser library took too long to load. Check your connection and try again."));
      }, 20000);
      document.head.appendChild(script);
    });
    scriptLoads.set(src, pending);
    pending.catch(function () { scriptLoads.delete(src); });
    return pending;
  }

  function createClient() {
    if (!configured()) return Promise.reject(failure("not_configured", "Sign-in is not connected in this copy. You can still explore the sample."));
    if (clientPromise) return clientPromise;
    clientPromise = loadScript(SUPABASE, "supabase").then(function (library) {
      const cfg = config();
      // Sign-in lives in this tab's memory only (29 Oct 2026): a reload or a new visit needs a new email code.
      // Sessions saved by the earlier version of the site are removed.
      try {
        Object.keys(localStorage).filter(function (k) { return /^sb-.*-auth-token$/.test(k); })
          .forEach(function (k) { localStorage.removeItem(k); });
      } catch (error) { /* storage blocked: nothing saved to remove */ }
      const client = library.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false }
      });
      client.auth.onAuthStateChange(function (event, session) {
        // Keep application work outside the auth library's state-change callback.
        authListeners.forEach(function (callback) {
          queueMicrotask(function () { callback(session, event); });
        });
      });
      return client;
    });
    clientPromise.catch(function () { clientPromise = null; });
    return clientPromise;
  }

  function existingClient() {
    if (!clientPromise) throw failure("not_signed_in", "Please sign in to use your own resume.");
    return clientPromise;
  }

  async function init() {
    const client = await createClient();
    const result = await client.auth.getSession();
    if (result.error) throw authError(result.error, "Could not check your sign-in. Please try again.");
    return result.data.session || null;
  }

  function onAuthChange(callback) {
    if (typeof callback !== "function") throw new TypeError("The auth listener must be a function.");
    authListeners.add(callback);
    return function () { authListeners.delete(callback); };
  }

  async function sendCode(email) {
    email = String(email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure("invalid_email", "Enter a valid email address.");
    const client = await createClient();
    const result = await client.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } });
    if (result.error) {
      if (result.error.status === 429) throw failure("rate_limited", "Too many codes requested. Wait a minute and try again.", 429);
      throw authError(result.error, "Could not send the code. Check the email address and try again.");
    }
    return result.data;
  }

  async function verifyCode(email, token) {
    email = String(email || "").trim();
    token = String(token || "").trim();
    if (!/^\d{6}$/.test(token)) throw failure("invalid_code", "Enter the 6-digit code from your email.");
    const client = await existingClient();
    const result = await client.auth.verifyOtp({ email: email, token: token, type: "email" });
    if (result.error) throw failure(result.error.code || "invalid_code", "That code did not work. Check it, or request a new one.", result.error.status);
    return result.data.session || null;
  }

  async function signOut() {
    if (!clientPromise) return;
    const client = await existingClient();
    const result = await client.auth.signOut();
    if (result.error) throw authError(result.error, "Could not sign out. Please try again.");
  }

  async function callFunction(name, body, signal) {
    checkAborted(signal);
    const client = await existingClient();
    const sessionResult = await client.auth.getSession();
    checkAborted(signal);
    if (sessionResult.error) throw authError(sessionResult.error, "Please sign in again.");
    const token = sessionResult.data.session && sessionResult.data.session.access_token;
    if (!token) throw failure("not_signed_in", "Please sign in again.");
    const cfg = config();
    let response;
    try {
      response = await fetch(cfg.SUPABASE_URL.replace(/\/$/, "") + "/functions/v1/" + name, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, apikey: cfg.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal
      });
    } catch (error) {
      checkAborted(signal);
      if (error.name === "AbortError") throw failure("aborted", "Stopped waiting. Your inputs are still here.", 0, { name: "AbortError" });
      throw failure("network", "We could not reach the service. Check your connection and try again.");
    }
    let json;
    try {
      json = await response.json();
    } catch (error) {
      checkAborted(signal);
      throw failure("invalid_response", "The service returned an unreadable response. Please try again.", response.status);
    }
    checkAborted(signal);
    if (!json || typeof json !== "object") throw failure("invalid_response", "The service returned an unreadable response. Please try again.", response.status);
    if (!response.ok) {
      throw failure(json.error || "request_failed", json.message || "The request did not finish. Please try again.", response.status);
    }
    return json;
  }

  async function generate(resumeText, jobText, signal) {
    resumeText = String(resumeText || "").trim();
    jobText = String(jobText || "").trim();
    if (resumeText.length < LIMITS.resumeMin) throw failure("resume_too_short", "Add at least 200 characters of resume text. If your file is a scan, paste its text instead.");
    if (resumeText.length > LIMITS.resumeMax) throw failure("resume_too_long", "Your resume is over 20,000 characters. Shorten it before continuing.");
    if (!jobText) throw failure("job_required", "Paste the job description first.");
    if (jobText.length > LIMITS.jobMax) throw failure("job_too_long", "The job description is over 12,000 characters. Shorten it before continuing.");
    return callFunction("generate", { resume_text: resumeText, jd_text: jobText }, signal);
  }

  async function tweak(sessionId, instruction, signal) {
    instruction = String(instruction || "").trim();
    if (!sessionId) throw failure("session_required", "Generate a resume before making a change.");
    if (!instruction) throw failure("instruction_required", "Type what you want changed.");
    if (instruction.length > LIMITS.tweakMax) throw failure("instruction_too_long", "Keep your change to 300 characters or fewer.");
    return callFunction("tweak", { session_id: sessionId, instruction: instruction }, signal);
  }

  async function undo(sessionId) {
    if (!sessionId) throw failure("session_required", "Generate a resume before undoing a change.");
    const client = await existingClient();
    const result = await client.rpc("undo_version", { p_session: sessionId });
    if (result.error) throw failure(result.error.message || result.error.code || "undo_failed", result.error.message || "Could not undo. Please try again.", result.status);
    return result.data;
  }

  async function currentUserId() {
    const client = await existingClient();
    const result = await client.auth.getSession();
    const id = result.data && result.data.session && result.data.session.user && result.data.session.user.id;
    if (!id) throw failure("not_signed_in", "Please sign in again.");
    return { client: client, id: id };
  }

  async function getProfile() {
    const me = await currentUserId();
    const result = await me.client.from("profiles").select("full_name, username").eq("user_id", me.id).maybeSingle();
    if (result.error) throw failure("profile_failed", "Could not load your profile.", result.status);
    return result.data || { full_name: null, username: null };
  }

  async function saveProfile(name, username) {
    name = String(name || "").trim().slice(0, 80) || null;
    username = String(username || "").trim().toLowerCase() || null;
    if (username && !/^[a-z0-9_]{3,20}$/.test(username)) throw failure("bad_username", "Use 3 to 20 lowercase letters, numbers or _ for the username.");
    const me = await currentUserId();
    const result = await me.client.from("profiles").upsert({ user_id: me.id, full_name: name, username: username, updated_at: new Date().toISOString() });
    if (result.error) {
      if (result.error.code === "23505") throw failure("username_taken", "That username is taken. Try another.");
      throw failure("profile_failed", "Could not save your profile. Please try again.", result.status);
    }
    return { full_name: name, username: username };
  }

  async function myResumes() {
    const client = await existingClient();
    const result = await client.rpc("my_resumes");
    if (result.error) throw failure("resumes_failed", "Could not load your resumes.", result.status);
    return result.data || [];
  }

  function tidy(text) {
    const ligatures = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
    return String(text || "").replace(/[ﬀ-ﬆ]/g, function (l) { return ligatures[l]; }).replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function pdfText(buffer) {
    const pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const task = pdfjs.getDocument({ data: buffer, isEvalSupported: false });
    let doc;
    try {
      doc = await task.promise;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        // Pieces that touch on the same line are one word. Joining every piece with a space split
        // "finstack" into "/ fi nstack" in the first real resume (29 Oct 2026).
        let text = "", prev = null;
        content.items.forEach(function (item) {
          if (typeof item.str !== "string") return;
          if (prev && !prev.hasEOL) {
            const size = Math.hypot(item.transform[0], item.transform[1]) || 10;
            const sameLine = Math.abs(item.transform[5] - prev.transform[5]) < size * 0.3;
            const gap = item.transform[4] - (prev.transform[4] + prev.width);
            text += sameLine && gap < size * 0.1 ? "" : " ";
          }
          text += item.str + (item.hasEOL ? "\n" : "");
          prev = item;
        });
        pages.push(text);
        page.cleanup();
      }
      return pages.join("\n");
    } finally {
      if (doc) await doc.destroy();
      else await task.destroy();
    }
  }

  async function extract(file) {
    if (!file) throw failure("file_required", "Choose a resume file first.");
    const extension = String(file.name || "").split(".").pop().toLowerCase();
    if (!["pdf", "docx", "txt"].includes(extension)) throw failure("file_type", "Choose a PDF, DOCX, or TXT file.");
    if (file.size > LIMITS.fileBytes) throw failure("file_too_large", "Choose a file smaller than 10 MB, or paste your resume text.");
    if (!file.size) throw failure("file_empty", "That file is empty. Choose another file or paste your text.");
    let text;
    try {
      if (extension === "txt") text = await file.text();
      else if (extension === "pdf") text = await pdfText(await file.arrayBuffer());
      else {
        const mammoth = await loadScript(MAMMOTH, "mammoth");
        const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
        text = result.value;
      }
    } catch (error) {
      if (error.code) throw error;
      if (error.name === "PasswordException") throw failure("file_locked", "That PDF needs a password. Use an unlocked copy or paste its text.");
      throw failure("file_unreadable", "Could not read that file. Paste your resume text instead.");
    }
    text = tidy(text);
    if (text.length < LIMITS.resumeMin) throw failure("resume_too_short", "This file has less than 200 characters of text. If it is a scan, paste your resume text instead.", 0, { text: text });
    if (text.length > LIMITS.resumeMax) throw failure("resume_too_long", "Your resume is over 20,000 characters. Nothing was cut. Shorten the text before continuing.", 0, { text: text });
    return text;
  }

  global.TailorAPI = {
    get configured() { return configured(); },
    limits: LIMITS,
    init: init,
    onAuthChange: onAuthChange,
    sendCode: sendCode,
    verifyCode: verifyCode,
    signOut: signOut,
    generate: generate,
    tweak: tweak,
    undo: undo,
    getProfile: getProfile,
    saveProfile: saveProfile,
    myResumes: myResumes,
    extract: extract
  };
})(window);
