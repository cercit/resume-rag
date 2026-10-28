// The schema accepts the messy shapes models return for real, long resumes (live failure 2026-10-28).
import { assertEquals } from "jsr:@std/assert@1.0.8";
import { parseJsonObject, ProfileSchema, ResumeSchema } from "../../supabase/functions/_shared/schema.ts";

Deno.test("parseJsonObject: stops at the first complete object, even with text and braces after it", () => {
  const reply = 'Here you go:\n{"a": {"b": "x } y"}, "c": "quote \\" inside"}\n\nNote: I kept it short {see above}.';
  assertEquals(parseJsonObject(reply), { a: { b: "x } y" }, c: 'quote " inside' });
  assertEquals(parseJsonObject('```json\n{"a": 1}\n```\nextra {}'), { a: 1 });
  let msg = "";
  try { parseJsonObject('{"a": [1, 2'); } catch (e) { msg = (e as Error).message; }
  assertEquals(msg, "JSON object is not closed (reply cut off)");
});

Deno.test("schema: bullets and summary lines given as objects become text (live failure 2026-10-28)", () => {
  const r = ResumeSchema.parse({
    file_name: "R", contact: { name: "T" },
    summary: [{ text: "First paragraph." }],
    skills: [["Data", "SQL"]],
    experience: [{ company: "A", title: "Analyst", dates: "2021", bullets: [
      { text: "Cut report time by 50%." }, { bullet: "Built a dashboard." }, { action: "Trained", result: "12 staff" }, "Plain bullet."] }],
  });
  assertEquals(r.summary, ["First paragraph."]);
  assertEquals(r.experience[0].bullets, ["Cut report time by 50%.", "Built a dashboard.", "Trained 12 staff", "Plain bullet."]);
});

const messy = {
  file_name: "Resume_Test",
  role_line: null,
  contact: { name: "Test Person", location: null, phone: 9000000000, email: "t@example.com", links: ["github.com/test"] },
  summary: "One paragraph instead of a list.",
  skills: [{ label: "Data", items: ["SQL", "Excel"] }, "Reporting: monthly packs", ["Tools", "Power BI", "Python"]],
  tools: ["SQL", "Excel"],
  order: ["experience", "projects"],
  experience: [{ company: "A Ltd", title: "Analyst", dates: 2021, intro: null,
    bullets: Array.from({ length: 14 }, (_, i) => `Bullet ${i + 1}`) }, null],
  portfolio: [{ name: "Side project", date: null, link: null, bullets: "Single bullet as text" }],
  education: [{ title: "B.Com", dates: "2014 – 2017", place: "College" }],
  certifications: ["Cert one", "Cert two"],
  languages: null,
  hobbies: ["Running"],
  jd_keywords: "SQL, Excel, reporting",
};

Deno.test("schema: nulls, numbers, strings-for-lists, skill objects and long lists are tidied, not rejected", () => {
  const r = ResumeSchema.parse(messy);
  assertEquals(r.role_line, "");
  assertEquals(r.contact.location, "");
  assertEquals(r.contact.phone, "9000000000");
  assertEquals(r.contact.links, [{ label: "github.com/test", url: "github.com/test" }]);
  assertEquals(r.summary, ["One paragraph instead of a list."]);
  assertEquals(r.skills, [["Data", "SQL, Excel"], ["Reporting", "monthly packs"], ["Tools", "Power BI, Python"]]);
  assertEquals(r.tools, "SQL, Excel");
  assertEquals(r.order, ["experience", "portfolio"]);
  assertEquals(r.experience.length, 1);
  assertEquals(r.experience[0].dates, "2021");
  assertEquals(r.experience[0].bullets.length, 10);
  assertEquals(r.portfolio[0].bullets, ["Single bullet as text"]);
  assertEquals(r.certifications, "Cert one · Cert two");
  assertEquals(r.languages, "");
  assertEquals(r.jd_keywords, ["SQL", "Excel", "reporting"]);
});

Deno.test("schema: parsing is idempotent (stored JSON parses to the same thing)", () => {
  const once = ResumeSchema.parse(messy);
  assertEquals(ResumeSchema.parse(once), once);
});

Deno.test("schema: profile allows empty sections; resume still needs a summary and skills", () => {
  assertEquals(ProfileSchema.parse({ contact: { name: "X" } }).experience, []);
  let failed = false;
  try { ResumeSchema.parse({ ...messy, summary: [] }); } catch { failed = true; }
  assertEquals(failed, true);
});
