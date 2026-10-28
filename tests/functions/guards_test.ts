import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import {
  bannedHits, findUngrounded, keywordNotes, lockFacts, removeUngrounded, replaceBanned, stripEmDash,
} from "../../supabase/functions/_shared/guards.ts";
import { ResumeSchema } from "../../supabase/functions/_shared/schema.ts";
import { load, resumeText, tailored } from "./harness.ts";

Deno.test("grounding: a clean tailored resume passes for all three samples", async () => {
  for (const name of ["fresher", "engineer", "changer"]) {
    const p = await load(name);
    const r = ResumeSchema.parse(tailored(p, []));
    assertEquals(findUngrounded(r, resumeText(p)), [], name);
  }
});

Deno.test("grounding: invented numbers, tools, employers and titles are caught", async () => {
  const p = await load("engineer");
  const r = ResumeSchema.parse(tailored(p, []));
  r.experience[0].bullets.push("Ran Kubernetes clusters at Google that cut costs by 45%.");
  r.summary[0] += " Promoted to Director of Engineering in 2024.";
  r.tools += ", Kubernetes";
  const items = findUngrounded(r, resumeText(p)).map((u) => u.item);
  for (const x of ["Kubernetes", "Google", "45", "Director", "2024"]) assert(items.some((i) => i.includes(x)), `missed ${x}: ${items}`);
});

Deno.test("grounding: sentence-start verbs, months and number formats do not false-alarm", async () => {
  const p = await load("engineer");
  const r = ResumeSchema.parse(tailored(p, []));
  r.experience[0].bullets = ["Mentored 3 junior engineers.", "Brought duplicate payouts down from about 30 a month to 2."];
  r.experience[0].dates = "March 2022 – Present | Bengaluru";
  assertEquals(findUngrounded(r, resumeText(p)), []);
});

Deno.test("grounding: a seniority word at the start of a sentence is still checked", async () => {
  const p = await load("fresher");
  const r = ResumeSchema.parse(tailored(p, []));
  r.summary = ["Director with deep backend skills.", "Lead developer on two projects."];
  const items = findUngrounded(r, resumeText(p)).map((u) => u.item);
  assert(items.includes("Director") && items.includes("Lead"), String(items));
  r.summary = ["Built a Django app."];
  assertEquals(findUngrounded(r, resumeText(p)), []);
});

Deno.test("removeUngrounded drops the offending bullet, sentence and tool only", async () => {
  const p = await load("engineer");
  const r = ResumeSchema.parse(tailored(p, []));
  const before = r.experience[0].bullets.length;
  r.experience[0].bullets.push("Ran Kubernetes at scale.");
  r.summary[0] += " Worked at Google.";
  r.tools += ", Kubernetes";
  const out = removeUngrounded(r, findUngrounded(r, resumeText(p)), p);
  assertEquals(out.experience[0].bullets.length, before);
  assert(!out.summary[0].includes("Google") && out.summary[0].includes("Razorpay"));
  assert(!out.tools.includes("Kubernetes") && out.tools.includes("Kafka"));
  assertEquals(findUngrounded(out, resumeText(p)), []);
});

Deno.test("lockFacts restores titles, contact and education; drops unknown jobs", async () => {
  const p = await load("engineer");
  const r = ResumeSchema.parse(tailored(p, []));
  r.experience[0].title = "Staff Engineer";
  r.contact.email = "fake@x.com";
  r.education = [];
  r.experience.push({ company: "Google", title: "Director", dates: "2010 – 2012", bullets: ["x"] });
  const out = lockFacts(r, p);
  assertEquals(out.experience[0].title, "Senior Software Engineer");
  assertEquals(out.contact.email, p.contact.email);
  assertEquals(out.education, p.education);
  assertEquals(out.experience.length, p.experience.length);
});

Deno.test("banned words: same list as build_resume.py, replaced with plain words", async () => {
  const p = await load("engineer");
  const r = ResumeSchema.parse(tailored(p, []));
  r.summary[0] = "Leveraged Kafka to build robust, innovative systems and spearheaded a crucial migration.";
  assertEquals(bannedHits(r.summary[0]).sort(), ["crucial", "innovative", "leveraged", "robust", "spearheaded"]);
  const out = replaceBanned(r);
  assertEquals(bannedHits(out.summary[0]), []);
  assertEquals(out.summary[0], "Used Kafka to build solid, new systems and led a key migration.");
});

Deno.test("em dashes become commas (pairs) or a colon (single); en dash ranges stay", () => {
  assertEquals(stripEmDash("Moved to Go — it was faster — and cheaper"), "Moved to Go, it was faster, and cheaper");
  assertEquals(stripEmDash("One goal — speed"), "One goal: speed");
  assertEquals(stripEmDash("Apr 2024 – Present"), "Apr 2024 – Present");
});

Deno.test("keyword notes use case-insensitive substring, like build_resume.py", async () => {
  const p = await load("engineer");
  const r = ResumeSchema.parse(tailored(p, ["Kafka", "postgresql", "Kubernetes", "on-call"]));
  const n = keywordNotes(r);
  assertEquals(n.keywords_found, ["Kafka", "postgresql", "on-call"]);
  assertEquals(n.keywords_missing, ["Kubernetes"]);
});

Deno.test("grounding: the example resume (base/resume.example.json) raises no false alarms", async () => {
  const ex = JSON.parse(await Deno.readTextFile(new URL("../../base/resume.example.json", import.meta.url)));
  const p = ResumeSchema.parse({
    ...ex,
    contact: { name: "Asha Verma", location: "Bengaluru", phone: "+91 90000 00000", email: "asha.verma@example.com",
      links: [{ label: "linkedin.com/in/asha-verma-example", url: "https://linkedin.com/in/asha-verma-example" }] },
    experience: ex.experience.map((e: object) => ({ ...e, company: "Northwind Finance Ltd" })),
    education: [{ title: "Bachelor of Commerce (B.Com)", dates: "2014 – 2017, First Class",
      place: "Example College of Commerce, Mysuru" }],
    jd_keywords: [],
  });
  const items = findUngrounded(p, resumeText(p));
  assertEquals(items, []);
});
