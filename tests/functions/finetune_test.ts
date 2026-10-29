// Fixes from the first real resume (29 Oct 2026): ligatures, places under job titles, thinned jobs.
import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { fillExperience, fixLigatures, placesIntoDates } from "../../supabase/functions/_shared/guards.ts";
import type { Profile, Resume } from "../../supabase/functions/_shared/schema.ts";

function profile(): Profile {
  return {
    file_name: "Resume_Asha_Verma", role_line: "Manager", summary: ["Ten years in lending."],
    contact: { name: "Asha Verma", location: "Pune", phone: "", email: "", links: [] },
    skills: [["Skills", "Excel"]], tools: "Excel", order: ["experience", "portfolio"],
    experience: [
      { company: "Acme Finance", title: "Manager", dates: "Apr 2024 – Present", intro: "Chennai", bullets: [
        "Built the market share pack for all branches", "Cut report turnaround from days to hours",
        "Trained branch teams on the new lead platform", "Mapped dealers and pincodes to branches"] },
      { company: "Acme Finance", title: "Officer", dates: "2018 – 2024", intro: "Retail lending team covering the north region.",
        bullets: ["Moved cash borrowers to digital repayment", "Ran video KYC during lockdowns", "Tracked NPA accounts weekly"] },
      { company: "Acme Finance", title: "Executive", dates: "2015 – 2018", intro: "| Bengaluru, India", bullets: ["Processed loans"] },
    ],
    portfolio: [], education: [], certifications: "", languages: "", hobbies: "", jd_keywords: [],
  } as Profile;
}

Deno.test("fixLigatures turns ligature glyphs into letters", () => {
  assertEquals(fixLigatures("cercit.github.io/ﬁnstack and staﬀ"), "cercit.github.io/finstack and staff");
});

Deno.test("placesIntoDates moves a place-only intro next to the dates and keeps real intros", () => {
  const p = placesIntoDates(profile());
  assertEquals(p.experience[0].dates, "Apr 2024 – Present | Chennai");
  assertEquals(p.experience[0].intro, undefined);
  assertEquals(p.experience[1].intro, "Retail lending team covering the north region.");
  assertEquals(p.experience[2].dates, "2015 – 2018 | Bengaluru, India");
});

Deno.test("fillExperience keeps every job, tops up thinned jobs, puts experience first", () => {
  const p = placesIntoDates(profile());
  const r = {
    ...p, order: ["portfolio", "experience"],
    experience: [{ ...p.experience[0], bullets: ["Built a market share pack covering all branches, flagging shifts early"] }],
    portfolio: [1, 2, 3, 4].map((n) => ({ name: `P${n}`, bullets: [] })),
  } as unknown as Resume;
  const out = fillExperience(r, p);
  assertEquals(out.experience.map((e) => e.title), ["Manager", "Officer", "Executive"]);
  // the rewritten first bullet already covers source bullet 1, so 3 more are added (4 in the source)
  assertEquals(out.experience[0].bullets.length, 4);
  assertEquals(out.experience[0].bullets[0], r.experience[0].bullets[0]);
  assert(!out.experience[0].bullets.includes("Built the market share pack for all branches"));
  assertEquals(out.experience[1].bullets.length, 3);
  assertEquals(out.experience[1].intro, "Retail lending team covering the north region.");
  assertEquals(out.portfolio.length, 3);
  assertEquals(out.order, ["experience", "portfolio"]);
});
