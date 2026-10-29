import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { generate } from "../../supabase/functions/_shared/pipeline.ts";
import { allText, bannedHits, findUngrounded } from "../../supabase/functions/_shared/guards.ts";
import { ResumeSchema } from "../../supabase/functions/_shared/schema.ts";
import { deps, fakeLLM, jd, load, newUser, resumeText, sql, tailored } from "./harness.ts";

// the shared DB pool outlives single tests, so the leak checks are off
const test = (name: string, fn: () => Promise<void>) => Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const KEYWORDS: Record<string, string[]> = {
  fresher: ["Python", "Django", "REST APIs", "unit tests", "SQL", "PostgreSQL", "Git", "code reviews", "React", "Agile", "Kubernetes"],
  engineer: ["Go", "Java", "Kafka", "PostgreSQL", "latency", "on-call", "AWS", "mentoring", "design reviews", "payments", "Kubernetes"],
  changer: ["user interviews", "usability tests", "affinity mapping", "Figma", "surveys", "reports", "SQL", "education", "Maze"],
};

// First answer: what a model might do if it followed the injected JD line or got carried away.
function contaminate(r: ReturnType<typeof tailored>) {
  const bad = structuredClone(r);
  bad.experience[0].title = "Lead " + bad.experience[0].title;
  bad.experience[0].bullets.unshift("Leveraged Kubernetes for 3 years to cut cloud costs by 45% — a robust win.");
  bad.summary[0] += " Worked closely with Accenture on cloud migration.";
  bad.tools += ", Kubernetes";
  return bad;
}

for (const name of ["fresher", "engineer", "changer"]) {
  test(`generate: ${name} sample, invented facts caught and removed, saved as version 1`, async () => {
    const profile = await load(name);
    const text = resumeText(profile);
    const jdText = await jd(name);
    const good = tailored(profile, KEYWORDS[name]);
    // engineer: the model repeats the invented bullet on the retry, so the guard must drop it
    const f = fakeLLM({
      extract: () => JSON.stringify(profile),
      tailor: (_c, n) => JSON.stringify({ resume: n === 0 || name === "engineer" ? contaminate(good) : good, gaps: ["Kubernetes"] }),
    });
    const uid = await newUser();
    const res = await generate({ resume_text: text, jd_text: jdText }, deps(uid, f.llm));
    assertEquals(res.status, 200, JSON.stringify(res.body));
    const out = ResumeSchema.parse(res.body.resume);
    assertEquals(findUngrounded(out, text), [], "grounding guard");
    assertEquals(bannedHits(allText(out)), [], "banned words");
    assert(!allText(out).includes("—"), "em dash");
    assert(!allText(out).includes("Kubernetes"), "injected JD fact leaked");
    assertEquals(out.experience.map((e) => e.title), profile.experience.map((e) => e.title), "official titles kept");
    assertEquals(out.contact, profile.contact);
    assertEquals(f.count.tailor, 2, "one retry with the problems listed");
    const retryMsg = f.calls.filter((c) => c.user.includes("previous answer had problems")).at(-1)!.user;
    for (const x of ['"Kubernetes"', '"45"', "leveraged", "robust", '"Accenture"']) assert(retryMsg.includes(x), `retry message lacks ${x}: ${retryMsg}`);
    assertEquals(res.body.tweaks_left, 10);
    const notes = res.body.notes as { keywords_found: string[]; keywords_missing: string[]; gaps: string[] };
    if (KEYWORDS[name].includes("Kubernetes")) assert(notes.keywords_missing.includes("Kubernetes"));
    assert(notes.gaps.length > 0);
    assert(notes.keywords_found.length >= 5, `found ${notes.keywords_found}`);
    const [s] = await sql`select current_version, tweaks_used, jd_text, profile_json from resume_sessions where id = ${res.body.session_id as string}`;
    assertEquals([s.current_version, s.tweaks_used], [1, 0]);
    assertEquals(s.profile_json.source_text, text.trim());
    await Deno.mkdir(new URL("../out/", import.meta.url), { recursive: true });
    await Deno.writeTextFile(new URL(`../out/${name}.resume.json`, import.meta.url), JSON.stringify(out, null, 2));
  });
}

test("generate: extraction that invents a fact is cleaned against the resume text", async () => {
  const profile = await load("fresher");
  const text = resumeText(profile);
  const invented = structuredClone(profile);
  invented.experience[0].bullets.push("Deployed services on Kubernetes for 50,000 users.");
  let seenProfile = "";
  const f = fakeLLM({
    extract: () => JSON.stringify(invented),
    tailor: (c) => { seenProfile = c.user; return JSON.stringify({ resume: tailored(profile, []), gaps: [] }); },
  });
  const res = await generate({ resume_text: text, jd_text: await jd("fresher") }, deps(await newUser(), f.llm));
  assertEquals(res.status, 200);
  assertEquals(f.count.extract, 2, "extraction retried once");
  assert(!seenProfile.split("</profile>")[0].includes("Kubernetes"), "invented fact reached the tailoring step");
});

test("generate: input checks", async () => {
  const f = fakeLLM({});
  const d = deps(await newUser(), f.llm);
  assertEquals((await generate({ resume_text: "", jd_text: "x" }, d)).status, 400);
  assertEquals((await generate({ resume_text: "short scan text", jd_text: "x" }, d)).body.message,
    "This looks like a scan. Paste your resume text instead.");
  assertEquals((await generate({ resume_text: "x".repeat(20001), jd_text: "x" }, d)).body.error, "resume_too_long");
  assertEquals((await generate({ resume_text: "x".repeat(300), jd_text: "x".repeat(12001) }, d)).body.error, "jd_too_long");
  assertEquals(f.calls.length, 0, "no LLM call for bad input");
});

test("generate: invalid JSON twice is an error, nothing saved", async () => {
  const profile = await load("changer");
  const f = fakeLLM({ extract: () => JSON.stringify(profile), tailor: () => "Here is your resume! (no json)" });
  const uid = await newUser();
  let threw = false;
  try { await generate({ resume_text: resumeText(profile), jd_text: await jd("changer") }, deps(uid, f.llm)); }
  catch { threw = true; }
  assert(threw);
  assertEquals(f.count.tailor, 2);
  assertEquals(Number((await sql`select count(*) as n from resume_sessions where user_id = ${uid}`)[0].n), 0);
});

test("generate: 4th session in 24 hours is refused before any LLM call", async () => {
  const profile = await load("changer");
  const uid = await newUser();
  const f = fakeLLM({ extract: () => JSON.stringify(profile), tailor: () => JSON.stringify({ resume: tailored(profile, []), gaps: [] }) });
  for (let i = 0; i < 3; i++) {
    assertEquals((await generate({ resume_text: resumeText(profile), jd_text: await jd("changer") }, deps(uid, f.llm))).status, 200);
  }
  const before = f.calls.length;
  const res = await generate({ resume_text: resumeText(profile), jd_text: await jd("changer") }, deps(uid, f.llm));
  assertEquals(res.status, 429);
  assertEquals(res.body.message, "You have used today's 3 resumes. Try again tomorrow.");
  assertEquals(f.calls.length, before);
});

test("close db", async () => { await sql.end(); });
