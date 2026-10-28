// 1. Web path PDF (render.js document, printed by Chromium) vs build_resume.py's PDF: pixel compare.
// 2. render.js page counter vs Chromium's real page count, for Sameer's resume and the 3 samples.
// 3. fit() in an iframe picks a step that really prints on 2 pages.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { sameer } from "./sameer.mjs";
const R = createRequire(import.meta.url)("../../web/render.js");
const OUT = new URL("../out/render/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

async function printPdf(html, path) {
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path, format: "A4", printBackground: true, preferCSSPageSize: true });
  return Number(execFileSync("python3", ["-c", `import pymupdf,sys;print(len(pymupdf.open(sys.argv[1])))`, path]).toString());
}

async function counted(html, step) {
  await page.setContent(html.replace("<body>", "<body style='width:180mm'>"), { waitUntil: "load" });
  await page.addScriptTag({ path: new URL("../../web/render.js", import.meta.url).pathname });
  return await page.evaluate((step) => document.fonts.ready.then(() => ResumeRender.countPages(document, step)), step);
}

// ---- 1. pixel compare with build_resume.py's PDF. build_resume.py tightens spacing until the
// resume fits, and leaves the HTML of the step it settled on in resume.html.
const pyPdf = new URL("../out/sameer_job/Resume_Asha_Verma_Example_Analyst.pdf", import.meta.url).pathname;
assert(existsSync(pyPdf), "run: python3 base/build_resume.py tests/out/sameer_job first");
const pyHtml = readFileSync(new URL("../out/sameer_job/resume.html", import.meta.url), "utf8");
const pyStep = R.STEPS.findIndex((s) => R.render(sameer, s) === pyHtml);
assert(pyStep >= 0, "no JS step reproduces build_resume.py's final HTML");
console.log(`build_resume.py settled on step ${pyStep}; JS HTML for that step is identical`);
// what print() sends to the printer: the fitted document with the measuring width removed
const webHtml = R.render(sameer, R.STEPS[pyStep]);
const webPdf = OUT + "sameer_web.pdf";
const webPages = await printPdf(webHtml, webPdf);
const diff = JSON.parse(execFileSync("python3", ["-c", `
import pymupdf, sys, json, numpy as np
a, b = pymupdf.open(sys.argv[1]), pymupdf.open(sys.argv[2])
res = {"pages": [len(a), len(b)], "diff": []}
for pa, pb in zip(a, b):
    x, y = pa.get_pixmap(dpi=100), pb.get_pixmap(dpi=100)
    if (x.width, x.height) != (y.width, y.height):
        res["diff"].append(1.0); continue
    ax = np.frombuffer(x.samples, np.uint8).reshape(-1, x.n); ay = np.frombuffer(y.samples, np.uint8).reshape(-1, y.n)
    res["diff"].append(float((ax != ay).any(axis=1).mean()))
print(json.dumps(res))`, pyPdf, webPdf]).toString());
console.log("pixel compare", JSON.stringify(diff));
assert.deepEqual(diff.pages, [2, 2]);
diff.diff.forEach((d, i) => assert(d === 0, `page ${i + 1}: ${(d * 100).toFixed(3)}% of pixels differ`));
console.log(`PASS web print matches build_resume.py PDF (${diff.diff.map((d) => (d * 100).toFixed(4) + "%").join(", ")} pixels differ)`);

// ---- 2. page counter vs real print, every step, 4 resumes
const samples = { sameer };
for (const n of ["fresher", "engineer", "changer"]) {
  const p = new URL(`../out/${n}.resume.json`, import.meta.url).pathname;
  if (existsSync(p)) samples[n] = JSON.parse(readFileSync(p, "utf8"));
}
// a long resume so the counter is also checked above 2 pages
samples.long = { ...sameer, experience: [...sameer.experience, ...sameer.experience] };
let mismatches = 0;
for (const [name, d] of Object.entries(samples)) {
  for (let i = 0; i < R.STEPS.length; i++) {
    const html = R.render(d, R.STEPS[i]);
    const real = await printPdf(html, `${OUT}${name}_${i}.pdf`);
    const est = await counted(html, R.STEPS[i]);
    if (real !== est) { mismatches++; console.log(`  MISMATCH ${name} step ${i}: counter ${est}, print ${real}`); }
  }
  console.log(`checked ${name}`);
}
assert.equal(mismatches, 0, `${mismatches} counter mismatches`);
console.log("PASS page counter agrees with Chromium print on every step");

// ---- 3. fit() in an iframe, as the web page does it
await page.setContent(`<iframe id="f" style="width:900px;height:1200px"></iframe><script>${readFileSync(new URL("../../web/render.js", import.meta.url), "utf8")}</script>`);
for (const [name, d] of Object.entries(samples)) {
  const r = await page.evaluate((d) => ResumeRender.fit(document.getElementById("f"), d), d);
  const html = (await page.evaluate(() => document.getElementById("f").srcdoc)).replace("<body style='width:180mm'>", "<body>");
  const real = await printPdf(html, `${OUT}${name}_fit.pdf`);
  await page.setContent(`<iframe id="f" style="width:900px;height:1200px"></iframe><script>${readFileSync(new URL("../../web/render.js", import.meta.url), "utf8")}</script>`);
  console.log(`  ${name}: fit step ${r.step}, counter ${r.pages}, print ${real}, fits=${r.fits}`);
  assert.equal(real, r.pages);
  if (name !== "long") assert(real <= 2, `${name} does not fit on 2 pages`);
  writeFileSync(`${OUT}${name}_fit.json`, JSON.stringify(r));
}
console.log("PASS fit() picks a step that prints on 2 pages (long resume correctly reported as over 2)");
await browser.close();
