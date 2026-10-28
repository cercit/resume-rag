// The JS port must produce exactly the HTML build_resume.py produces, at every spacing step.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { sameer } from "./sameer.mjs";
const R = createRequire(import.meta.url)("../../web/render.js");

const py = JSON.parse(execFileSync("python3", [new URL("./dump_python.py", import.meta.url).pathname], { encoding: "utf8" }));
assert.equal(py.length, R.STEPS.length, "same number of spacing steps");
py.forEach((html, i) => {
  const js = R.render(sameer, R.STEPS[i]);
  if (js !== html) {
    const at = [...js].findIndex((ch, k) => ch !== html[k]);
    console.log("PY:", JSON.stringify(html.slice(at - 80, at + 80)));
    console.log("JS:", JSON.stringify(js.slice(at - 80, at + 80)));
  }
  assert.equal(js, html, `step ${i} differs`);
  console.log(`PASS step ${i}: identical HTML (${html.length} chars)`);
});
