import { assertEquals } from "jsr:@std/assert@1";
import { roleOf, scrub, signalsFromGenerate, tweakCategory, tweakSignal } from "../../supabase/functions/_shared/signals.ts";
import type { Resume } from "../../supabase/functions/_shared/schema.ts";

const resume = {
  file_name: "Resume_Asha_Verma_FinNest Technologies_Credit Manager",
  experience: [{ bullets: ["a", "b", "c"] }, { bullets: ["d"] }],
} as unknown as Resume;

Deno.test("role comes from the file name, lowercase", () => {
  assertEquals(roleOf(resume), "credit manager");
  assertEquals(roleOf({ file_name: "Resume_Asha" } as unknown as Resume), "");
});

Deno.test("dropped keywords: in the visitor's resume but missing from the tailored one", () => {
  const s = signalsFromGenerate("Built dashboards in Power BI and SQL.", resume, ["Power BI", "Kubernetes"], 1, 31234.4);
  assertEquals(s.keywords_dropped, ["Power BI"]);
  assertEquals(s.keywords_missing, ["Power BI", "Kubernetes"]);
  assertEquals([s.jobs, s.bullets, s.removed, s.ms], [2, 4, 1, 31234]);
});

Deno.test("a keyword must match as a whole word to count as present", () => {
  assertEquals(signalsFromGenerate("Javascript developer", resume, ["Java"], 0, 1).keywords_dropped, []);
});

Deno.test("tweak categories", () => {
  assertEquals(tweakCategory("Make the summary shorter"), "shorten");
  assertEquals(tweakCategory("remove the long bullet in my second job"), "remove");
  assertEquals(tweakCategory("put projects first"), "reorder");
  assertEquals(tweakCategory("add SQL to skills"), "add_keyword");
  assertEquals(tweakCategory("sound more confident"), "tone");
  assertEquals(tweakCategory("expand my latest role"), "lengthen");
  assertEquals(tweakCategory("hmm"), "other");
});

Deno.test("scrub removes contact details and long numbers, caps length", () => {
  assertEquals(scrub("call me on 98220 41736 or asha@mail.com"), "call me on [x] or [x]");
  assertEquals(scrub("see https://x.com/me and account 123456"), "see [x] and account [x]");
  assertEquals(scrub("raise 25% to 3 bullets"), "raise 25% to 3 bullets");
  assertEquals(scrub("a".repeat(500)).length, 200);
});

Deno.test("tweak signal has category, outcome, scrubbed text", () => {
  assertEquals(tweakSignal("shorten it, email me at a@b.co", "applied", 5200.7),
    { category: "shorten", outcome: "applied", text: "shorten it, email me at [x]", ms: 5201 });
});
