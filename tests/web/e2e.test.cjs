// Browser test of web/ with the real page code, real pdf.js and mammoth (same pinned versions, served
// from a local npm install in place of the CDN), and Supabase auth + Edge Functions mocked at the network.
// Run: WEBDEPS=<dir with node_modules> node tests/web/e2e.test.cjs
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const assert = require("assert/strict");

const ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(ROOT, "tests/out/web");
const DEPS = path.join(process.env.WEBDEPS || "", "node_modules");
fs.mkdirSync(OUT, { recursive: true });
const SITE = "http://localhost:5500/resume-rag/";
const SB = "https://testref.supabase.co";

const CDN = {
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js": "@supabase/supabase-js/dist/umd/supabase.js",
  "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js": "mammoth/mammoth.browser.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs": "pdfjs-dist/build/pdf.min.mjs",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs": "pdfjs-dist/build/pdf.worker.min.mjs",
};
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };

const fresher = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/samples/fresher.json"), "utf8"));
const tailored = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/out/fresher.resume.json"), "utf8"));
const resumeTextLines = [fresher.contact.name, fresher.role_line, fresher.contact.email, "", "SUMMARY", ...fresher.summary, "", "EXPERIENCE",
  ...fresher.experience.flatMap((e) => [`${e.title}, ${e.company} ${e.dates}`, ...e.bullets]), "", "EDUCATION",
  ...fresher.education.map((e) => `${e.title}, ${e.place}, ${e.dates}`)];

function fakeJwt() {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b({ sub: "u1", email: "a@test.local", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

(async () => {
  const results = [];
  const pass = (m) => { results.push(m); console.log("PASS " + m); };
  const browser = await chromium.launch();

  // ---- fixtures: a real PDF, a real DOCX, and an image-only "scan" PDF
  const fx = await browser.newPage();
  const textHtml = `<html><body style="font-family:Arial;font-size:11pt">${resumeTextLines.map((l) => `<p>${l}</p>`).join("")}</body></html>`;
  await fx.setContent(textHtml);
  await fx.pdf({ path: path.join(OUT, "resume.pdf"), format: "A4" });
  await fx.setViewportSize({ width: 800, height: 1100 });
  const png = await fx.screenshot({ fullPage: false });
  await fx.setContent(`<html><body style="margin:0"><img style="width:100%" src="data:image/png;base64,${png.toString("base64")}"></body></html>`);
  await fx.pdf({ path: path.join(OUT, "scan.pdf"), format: "A4" });
  await fx.close();
  execFileSync("python3", ["-c", `import docx,sys,json
d=docx.Document()
for l in json.loads(sys.argv[2]): d.add_paragraph(l)
d.save(sys.argv[1])`, path.join(OUT, "resume.docx"), JSON.stringify(resumeTextLines)]);

  // ---- the site, with network mocks
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls = { otp: 0, verify: 0, generate: [], tweak: [], undo: 0 };
  let tweakCount = 0;

  await ctx.route("**/*", async (route) => {
    const url = route.request().url();
    if (CDN[url]) return route.fulfill({ path: path.join(DEPS, CDN[url]), contentType: "text/javascript" });
    if (url.startsWith(SITE)) {
      const rel = url.slice(SITE.length).split("?")[0] || "index.html";
      if (rel === "config.js") {
        return route.fulfill({ contentType: "text/javascript", body: `window.APP_CONFIG={SUPABASE_URL:"${SB}",SUPABASE_ANON_KEY:"anon-test"};` });
      }
      return route.fulfill({ path: path.join(ROOT, "web", rel), contentType: TYPES[path.extname(rel)] || "application/octet-stream" });
    }
    if (url.startsWith(SB)) {
      const req = route.request();
      const cors = { "access-control-allow-origin": "http://localhost:5500", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
      if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: cors });
      const json = (status, body) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (url.includes("/auth/v1/otp")) { calls.otp++; return json(200, {}); }
      if (url.includes("/auth/v1/verify")) {
        calls.verify++;
        const body = JSON.parse(req.postData());
        if (body.token !== "123456") return json(403, { error_code: "otp_expired", msg: "Token has expired or is invalid" });
        return json(200, { access_token: fakeJwt(), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: "r1", user: { id: "u1", aud: "authenticated", role: "authenticated", email: "a@test.local" } });
      }
      if (url.endsWith("/functions/v1/generate")) {
        calls.generate.push({ headers: req.headers(), body: JSON.parse(req.postData()) });
        if (calls.generate.length === 2) return json(429, { error: "daily_session_limit", message: "x" });
        return json(200, { session_id: "11111111-1111-1111-1111-111111111111", resume: tailored, tweaks_left: 10,
          notes: { keywords_found: ["Python", "Django"], keywords_missing: ["Kubernetes"], gaps: ["The JD asks for Kubernetes; the resume does not show it"] } });
      }
      if (url.endsWith("/functions/v1/tweak")) {
        const body = JSON.parse(req.postData());
        calls.tweak.push(body);
        if (body.instruction === "fail please") return json(503, { error: "llm_busy", message: "The AI service is busy. Try again in a minute. You were not charged a tweak." });
        if (body.instruction === "add 5 years of Kubernetes") return json(422, { error: "refused", message: "I can only use what is in your resume." });
        tweakCount++;
        const r = { ...tailored, order: ["portfolio", "experience"], summary: ["Shorter summary about Django and Python."] };
        return json(200, { resume: r, tweaks_left: 10 - tweakCount, notes: { keywords_found: ["Python"], keywords_missing: [] } });
      }
      if (url.endsWith("/rest/v1/rpc/undo_version")) { calls.undo++; return json(200, tailored); }
      return json(404, {});
    }
    return route.abort();
  });

  await page.goto(SITE);
  await page.waitForSelector("#screen-signin:not([hidden])");
  assert.equal(await page.isHidden("#setup-warning"), true);
  pass("sign-in screen gates everything (input and result hidden)");
  assert.equal(await page.isHidden("#screen-input"), true);

  // ---- sign in with an email code
  await page.fill("#email", "a@test.local");
  await page.click("#email-form button[type=submit]");
  await page.waitForSelector("#code-form:not([hidden])");
  await page.fill("#code", "000000");
  await page.click("#code-form button[type=submit]");
  await page.waitForSelector("#error:not([hidden])");
  assert.match(await page.textContent("#error"), /code did not work/);
  await page.fill("#code", "123456");
  await page.click("#code-form button[type=submit]");
  await page.waitForSelector("#screen-input:not([hidden])");
  assert.equal(calls.otp, 1);
  pass("email one-time code: wrong code shows plain error, right code opens the input screen");

  // ---- files become text in the browser
  await page.setInputFiles("#file", path.join(OUT, "resume.pdf"));
  await page.waitForFunction(() => document.getElementById("resume-text").value.length > 200);
  const fromPdf = await page.inputValue("#resume-text");
  assert(fromPdf.includes("Persistent Systems") && fromPdf.includes("Fixed 23 bugs"), "PDF text extracted");
  assert.match(await page.textContent("#resume-count"), /^[\d,]+ \/ 20,000 characters$/);
  pass(`PDF extracted in the browser with pdf.js (${fromPdf.length} chars), count shown`);

  await page.fill("#resume-text", "");
  await page.setInputFiles("#file", path.join(OUT, "resume.docx"));
  await page.waitForFunction(() => document.getElementById("resume-text").value.length > 200);
  assert((await page.inputValue("#resume-text")).includes("Sahyadri Analytics"));
  pass("DOCX extracted in the browser with mammoth");

  await page.setInputFiles("#file", path.join(OUT, "scan.pdf"));
  await page.waitForSelector("#error:not([hidden])");
  assert.equal(await page.textContent("#error"), "This looks like a scan. Paste your resume text instead.");
  pass("image-only PDF: 'This looks like a scan. Paste your resume text instead.' (no OCR)");

  // ---- edit the text, then generate
  await page.fill("#resume-text", fromPdf + "\nEdited by me.");
  await page.fill("#jd-text", fs.readFileSync(path.join(ROOT, "tests/samples/jd_fresher.txt"), "utf8"));
  assert.match(await page.textContent(".small"), /Sessions are deleted after 7 days/);
  await page.click("#generate");
  await page.waitForSelector("#screen-result:not([hidden])");
  await page.waitForFunction(() => /page/.test(document.getElementById("fit-status").textContent));
  const g = calls.generate[0];
  assert.deepEqual(Object.keys(g.body).sort(), ["jd_text", "resume_text"]);
  assert(g.body.resume_text.endsWith("Edited by me."), "edited text is what gets sent");
  assert(!/data:|base64|%PDF|PK\u0003\u0004/.test(JSON.stringify(g.body)), "no file data in the request");
  assert.match(g.headers.authorization, /^Bearer ey/);
  pass("generate sends text only (resume_text, jd_text) with the user's JWT; edited text is sent");

  const frame = page.frameLocator("#preview");
  assert.equal(await frame.locator("h1").textContent(), "Ananya Rao");
  assert.equal(await page.evaluate(() => document.getElementById("preview").contentDocument.title), tailored.file_name);
  assert.match(await page.textContent("#fit-status"), /^1 page, A4$/);
  assert.equal(await page.textContent("#tweaks-left"), "10 of 10 tweaks left");
  assert.equal(await page.isDisabled("#undo"), true);
  assert.match(await page.textContent("#kw-missing"), /Kubernetes/);
  assert.match(await page.textContent("#gaps"), /Kubernetes/);
  pass("result: live preview in Sameer's template, notes panel, 10 of 10 tweaks, undo disabled");
  await page.screenshot({ path: path.join(OUT, "desktop_result.png") });

  // ---- tweaks
  await page.fill("#tweak-text", "Shorten the summary and put projects first");
  await page.click("#tweak");
  await page.waitForFunction(() => document.getElementById("tweaks-left").textContent === "9 of 10 tweaks left");
  assert.equal(await frame.locator("h2").nth(3).textContent(), "Portfolio");
  assert.equal(await page.isDisabled("#undo"), false);
  pass("tweak updates the preview and the counter (9 of 10)");

  await page.fill("#tweak-text", "add 5 years of Kubernetes");
  await page.click("#tweak");
  await page.waitForSelector("#error:not([hidden])");
  assert.equal(await page.textContent("#error"), "I can only use what is in your resume.");
  assert.equal(await page.textContent("#tweaks-left"), "9 of 10 tweaks left");
  await page.fill("#tweak-text", "fail please");
  await page.click("#tweak");
  await page.waitForFunction(() => /not charged/.test(document.getElementById("error").textContent));
  assert.equal(await page.textContent("#tweaks-left"), "9 of 10 tweaks left");
  pass("refused and failed tweaks show plain words and leave the counter alone");

  await page.click("#undo");
  await page.waitForFunction(() => document.getElementById("undo").disabled);
  assert.equal(calls.undo, 1);
  assert.equal(await frame.locator("h2").nth(3).textContent(), "Experience");
  assert.equal(await page.textContent("#tweaks-left"), "9 of 10 tweaks left");
  pass("undo calls the undo_version RPC directly, restores the previous version, counter unchanged");

  // ---- download: print the iframe; body measuring width removed while printing
  await page.evaluate(() => {
    const w = document.getElementById("preview").contentWindow;
    window.__printed = null;
    w.print = () => { window.__printed = { style: w.document.body.getAttribute("style"), title: w.document.title, outer: document.title }; };
  });
  await page.click("#download");
  const printed = await page.evaluate(() => window.__printed);
  assert.equal(printed.style, null, "measuring width removed for print");
  assert.equal(printed.title, tailored.file_name);
  assert.equal(printed.outer, tailored.file_name);
  assert.match(await page.textContent(".preview p.small"), /Save as PDF, margins None/);
  pass("Download PDF prints the iframe with document.title = file_name and the hint shown");

  // ---- daily limit message
  await page.click("#start-over");
  await page.fill("#jd-text", "Another job description text.");
  await page.click("#generate");
  await page.waitForSelector("#error:not([hidden])");
  assert.equal(await page.textContent("#error"), "You have used today's 3 sessions. Try again tomorrow.");
  pass("daily_session_limit shown as 'You have used today's 3 sessions. Try again tomorrow.'");

  // ---- mobile width: 16px gutters, no horizontal page scroll
  await page.setViewportSize({ width: 375, height: 800 });
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, pad: getComputedStyle(document.querySelector("main")).paddingLeft,
    banner: document.getElementById("error").getBoundingClientRect().left }));
  assert.equal(Math.round(m.banner), 16, "error banner keeps the 16px gutter");
  assert(m.sw <= 375, `page scrolls sideways (${m.sw}px)`);
  assert.equal(m.pad, "16px");
  pass("mobile 375px: no horizontal page scroll, 16px gutters");
  await page.screenshot({ path: path.join(OUT, "mobile_input.png"), fullPage: true });

  assert.deepEqual(errors, [], "no page errors");
  pass("no JavaScript errors on the page");
  await browser.close();
  console.log(`\n${results.length} checks passed`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
