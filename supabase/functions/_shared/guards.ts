// Code-level guards on every resume the LLM returns. The prompt asks for the same things,
// but these checks are what actually stop invented facts, banned words and em dashes.
import type { Profile, Resume } from "./schema.ts";

// ---------- text helpers ----------

const MONTHS: Record<string, string> = {
  january: "jan", february: "feb", march: "mar", april: "apr", june: "jun", july: "jul",
  august: "aug", september: "sep", sept: "sep", october: "oct", november: "nov", december: "dec",
};
// Capitalised words that carry no facts on their own.
const ALLOW = new Set(["i", "present", "current", "now", "today", "ongoing", "jan", "feb", "mar", "apr", "may",
  "jun", "jul", "aug", "sep", "oct", "nov", "dec"]);

export function norm(text: string): string {
  let t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/(\d),(?=\d{3}\b)/g, "$1");
  t = t.replace(/[^\p{L}\p{N}+#]+/gu, " ");
  t = t.replace(/\b[a-z]+\b/g, (w) => MONTHS[w] ?? w);
  return ` ${t.replace(/\s+/g, " ").trim()} `;
}

function contains(normSource: string, phrase: string): boolean {
  const p = norm(phrase).trim();
  return p === "" || normSource.includes(` ${p} `);
}

function digitRuns(text: string): string[] {
  return text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d{2,}/g) ?? [];
}

// Seniority words are checked even when they start a sentence ("Director with 7 years ...").
const TITLE_WORDS = /^(director|manager|head|lead|senior|principal|chief|president|vp|founder|cofounder|co-founder|architect|staff|partner|owner|executive|supervisor)$/i;

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}+#&.'’\/-]*/gu;
const isCap = (t: string) => /^\p{Lu}/u.test(t) || /\p{Lu}/u.test(t.slice(1));
const isPlainTitle = (t: string) => /^\p{Lu}[\p{Ll}'’-]*$/u.test(t);

// Capitalised phrases in a string, with a flag for "starts a sentence".
export function properPhrases(text: string): { phrase: string; atStart: boolean }[] {
  const out: { phrase: string; atStart: boolean }[] = [];
  for (const sentence of text.split(/(?<=[.!?;:])\s+|\n+|^\s*[-*•]\s+/m)) {
    const toks = [...sentence.matchAll(TOKEN)].map((m) => m[0].replace(/[.'’]+s?$|[.\-\/]+$/u, ""));
    let i = 0;
    while (i < toks.length) {
      if (!toks[i] || !isCap(toks[i])) { i++; continue; }
      const start = i;
      while (i < toks.length && toks[i] && isCap(toks[i])) i++;
      out.push({ phrase: toks.slice(start, i).join(" "), atStart: start === 0 });
    }
  }
  return out;
}

// ---------- grounding ----------

export interface Ungrounded { path: string; item: string }

// Text fields that state facts about the candidate. file_name, order and jd_keywords are not facts.
export function factFields(r: Resume): { path: string; text: string }[] {
  const f: { path: string; text: string }[] = [{ path: "role_line", text: r.role_line }];
  r.summary.forEach((t, i) => f.push({ path: `summary.${i}`, text: t }));
  r.skills.forEach(([label, text], i) => {
    f.push({ path: `skills.${i}.0`, text: label });
    f.push({ path: `skills.${i}.1`, text });
  });
  f.push({ path: "tools", text: r.tools });
  r.experience.forEach((e, i) => {
    f.push({ path: `experience.${i}.company`, text: e.company }, { path: `experience.${i}.title`, text: e.title },
      { path: `experience.${i}.dates`, text: e.dates });
    if (e.intro) f.push({ path: `experience.${i}.intro`, text: e.intro });
    e.bullets.forEach((b, j) => f.push({ path: `experience.${i}.bullets.${j}`, text: b }));
  });
  r.portfolio.forEach((p, i) => {
    f.push({ path: `portfolio.${i}.name`, text: p.name }, { path: `portfolio.${i}.date`, text: p.date ?? "" },
      { path: `portfolio.${i}.link`, text: p.link ?? "" });
    p.bullets.forEach((b, j) => f.push({ path: `portfolio.${i}.bullets.${j}`, text: b }));
  });
  const c = r.contact;
  f.push({ path: "contact.name", text: c.name }, { path: "contact.location", text: c.location },
    { path: "contact.phone", text: c.phone }, { path: "contact.email", text: c.email });
  c.links.forEach((l, i) => f.push({ path: `contact.links.${i}`, text: `${l.label} ${l.url}` }));
  r.education.forEach((e, i) => f.push({ path: `education.${i}`, text: `${e.title}\n${e.dates}\n${e.place}` }));
  f.push({ path: "certifications", text: r.certifications }, { path: "languages", text: r.languages },
    { path: "hobbies", text: r.hobbies });
  return f.filter((x) => x.text);
}

// Every 2+ digit number and every capitalised name in the output must appear in the source text.
// Skill labels may also use the JD's own wording (they name categories, not facts).
export function findUngrounded(r: Resume, source: string, jd = ""): Ungrounded[] {
  const src = norm(source);
  const srcDigits = source.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const labelSrc = norm(source + "\n" + jd);
  const bad: Ungrounded[] = [];
  const seen = new Set<string>();
  const add = (path: string, item: string) => {
    if (!seen.has(path + "|" + item)) { seen.add(path + "|" + item); bad.push({ path, item }); }
  };
  for (const { path, text } of factFields(r)) {
    const pool = /^skills\.\d+\.0$/.test(path) ? labelSrc : src;
    for (const run of digitRuns(text)) {
      if (!new RegExp(`(?<!\\d)${run}(?!\\d)`).test(srcDigits)) add(path, run);
    }
    for (const { phrase, atStart } of properPhrases(text)) {
      const words = phrase.split(" ");
      if (words.every((w) => ALLOW.has(norm(w).trim()) || w.length < 2)) continue;
      if (atStart && words.length === 1 && isPlainTitle(words[0]) && !TITLE_WORDS.test(words[0])) continue; // "Led", "Built"
      if (contains(pool, phrase)) continue;
      if (atStart && !TITLE_WORDS.test(words[0]) && contains(pool, words.slice(1).join(" "))) continue;
      // a phrase can still pass word by word when each capitalised word is in the source
      // and the phrase is just a list ("Excel SQL"), so check the words one at a time
      const missing = words.filter((w, k) => !(atStart && k === 0 && isPlainTitle(w) && !TITLE_WORDS.test(w)) && !ALLOW.has(norm(w).trim()) &&
        w.length > 1 && !contains(pool, w));
      if (missing.length) add(path, phrase);
    }
  }
  // tools must each be named in the source
  for (const tool of r.tools.split(/[,;·|]/)) {
    const name = tool.replace(/\(.*?\)/g, "").trim();
    if (name && !contains(src, name)) add("tools", name);
  }
  return bad;
}

// ---------- removing what could not be grounded ----------

const splitSentences = (t: string) => t.split(/(?<=[.!?])\s+/);
const has = (text: string, item: string) => norm(text).includes(` ${norm(item).trim()} `) || text.includes(item);

export function removeUngrounded(r: Resume, bad: Ungrounded[], profile: Profile): Resume {
  const out: Resume = structuredClone(r);
  const dropBullets = new Map<string, Set<number>>();
  const dropSkills = new Set<number>();
  for (const { path, item } of bad) {
    const p = path.split(".");
    if (p[2] === "bullets") {
      const key = `${p[0]}.${p[1]}`;
      if (!dropBullets.has(key)) dropBullets.set(key, new Set());
      dropBullets.get(key)!.add(Number(p[3]));
    } else if (p[0] === "summary") {
      out.summary[+p[1]] = splitSentences(out.summary[+p[1]]).filter((s) => !has(s, item)).join(" ");
    } else if (p[0] === "experience" && p[2] === "intro") {
      const e = out.experience[+p[1]];
      e.intro = splitSentences(e.intro ?? "").filter((s) => !has(s, item)).join(" ") || undefined;
    } else if (p[0] === "skills") {
      if (p[2] === "0") dropSkills.add(+p[1]);
      else out.skills[+p[1]][1] = out.skills[+p[1]][1].split(/,\s*/).filter((s) => !has(s, item)).join(", ");
    } else if (p[0] === "tools") {
      out.tools = out.tools.split(/,\s*/).filter((s) => !has(s, item)).join(", ");
    } else if (p[0] === "role_line") {
      out.role_line = profile.role_line || profile.experience[0]?.title || "";
    }
  }
  for (const [key, idx] of dropBullets) {
    const [sec, i] = key.split(".");
    const list = sec === "experience" ? out.experience[+i] : out.portfolio[+i];
    list.bullets = list.bullets.filter((_, j) => !idx.has(j));
  }
  out.skills = out.skills.filter(([, text], i) => !dropSkills.has(i) && text.trim());
  out.summary = out.summary.filter((s) => s.trim());
  if (!out.summary.length) out.summary = profile.summary.slice(0, 2);
  if (!out.skills.length) out.skills = profile.skills.slice(0, 6);
  return out;
}

// ---------- facts copied from the profile, never from the LLM ----------

const key = (s: string) => norm(s).trim();

// Contact, education, certifications, languages and hobbies come straight from the profile.
// Job titles, companies and dates are reset to the profile's own wording; unknown entries are dropped.
export function lockFacts(r: Resume, profile: Profile): Resume {
  const out: Resume = structuredClone(r);
  out.contact = structuredClone(profile.contact);
  out.education = structuredClone(profile.education);
  out.certifications = profile.certifications;
  out.languages = profile.languages;
  out.hobbies = profile.hobbies;
  // the line under the name must be one of the visitor's own titles, as written
  const titles = [profile.role_line, ...profile.experience.map((e) => e.title)].filter(Boolean);
  if (!titles.some((t) => key(t) === key(out.role_line))) out.role_line = titles[0] ?? "";
  const used = new Set<number>();
  out.experience = r.experience.flatMap((e) => {
    let i = profile.experience.findIndex((p, k) => !used.has(k) && key(p.title) === key(e.title) && key(p.company) === key(e.company));
    if (i < 0) i = profile.experience.findIndex((p, k) => !used.has(k) && key(p.dates) === key(e.dates) && key(p.company) === key(e.company));
    if (i < 0) i = profile.experience.findIndex((p, k) => !used.has(k) && key(p.dates) === key(e.dates));
    if (i < 0) return [];
    used.add(i);
    const p = profile.experience[i];
    return [{ ...e, title: p.title, company: p.company, dates: p.dates }];
  });
  const usedP = new Set<number>();
  out.portfolio = r.portfolio.flatMap((e) => {
    const i = profile.portfolio.findIndex((p, k) => !usedP.has(k) && key(p.name) === key(e.name));
    if (i < 0) return [];
    usedP.add(i);
    const p = profile.portfolio[i];
    return [{ ...e, name: p.name, date: p.date, link: p.link }];
  });
  if (!out.portfolio.length && out.order[0] === "portfolio") out.order = ["experience", "portfolio"];
  return out;
}

// Same JSON regardless of key order (jsonb stores keys in its own order).
export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort)
    : x && typeof x === "object"
    ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => a < b ? -1 : 1).map(([k, y]) => [k, sort(y)]))
    : x;
  return JSON.stringify(sort(v));
}

// ---------- banned words and em dashes ----------

// BANNED from base/build_resume.py, plus the /human skill's banned words.
export const BANNED = new RegExp(
  "\\b(delve\\w*|leverag\\w*|utili[sz]\\w*|facilitat\\w*|comprehensive|robust|seamless\\w*|cutting-edge|" +
    "innovative|game-changer|revolutioni[sz]\\w*|empower\\w*|harness\\w*|paradigm|synerg\\w*|foster\\w*|" +
    "spearhead\\w*|bolster\\w*|crucial|vital|pivotal|showcas\\w*|tapestry|testament|underscor\\w*|" +
    "passionate|dynamic|results-driven|go-getter|proven track record|" +
    // extra words from the /human rules, plus "actionable" (seen in OpenRouter model output)
    "actionable|intricate|enhanc\\w*|boast\\w*|vibrant|profound|exemplif\\w*|groundbreaking|renowned|nestled)\\b",
  "gi",
);

export function allText(r: Resume): string {
  return factFields(r).map((f) => f.text).join("\n");
}

export function bannedHits(text: string): string[] {
  return [...new Set([...text.matchAll(BANNED)].map((m) => m[0].toLowerCase()))];
}

// Plain replacements, used only if a retry still leaves a banned word in.
const VERBS: [RegExp, [string, string, string, string]][] = [
  // stem, [base, past, -ing, -s]
  [/^delv/, ["look into", "looked into", "looking into", "looks into"]],
  [/^leverag/, ["use", "used", "using", "uses"]],
  [/^utili[sz]/, ["use", "used", "using", "uses"]],
  [/^facilitat/, ["help", "helped", "helping", "helps"]],
  [/^seamless/, ["smooth", "smoothly", "smooth", "smooth"]],
  [/^revolutioni[sz]/, ["change", "changed", "changing", "changes"]],
  [/^empower/, ["enable", "enabled", "enabling", "enables"]],
  [/^harness/, ["use", "used", "using", "uses"]],
  [/^synerg/, ["joint work", "joint work", "joint work", "joint work"]],
  [/^foster/, ["build", "built", "building", "builds"]],
  [/^spearhead/, ["lead", "led", "leading", "leads"]],
  [/^bolster/, ["strengthen", "strengthened", "strengthening", "strengthens"]],
  [/^showcas/, ["show", "showed", "showing", "shows"]],
  [/^underscor/, ["show", "showed", "showing", "shows"]],
  [/^enhanc/, ["improve", "improved", "improving", "improves"]],
  [/^boast/, ["have", "had", "having", "has"]],
  [/^exemplif/, ["show", "showed", "showing", "shows"]],
];
const WORDS: Record<string, string> = {
  comprehensive: "full", robust: "solid", "cutting-edge": "modern", innovative: "new", "game-changer": "big change",
  paradigm: "model", crucial: "key", vital: "key", pivotal: "key", tapestry: "mix", testament: "proof",
  passionate: "keen", dynamic: "active", "results-driven": "focused on results", "go-getter": "self-starter",
  "proven track record": "track record", actionable: "practical", intricate: "detailed", vibrant: "lively",
  profound: "deep", groundbreaking: "new", renowned: "well-known", nestled: "set",
};

function replaceWord(w: string): string {
  const lw = w.toLowerCase();
  let rep = WORDS[lw];
  if (!rep) {
    const v = VERBS.find(([re]) => re.test(lw));
    if (!v) return w;
    const [base, past, ing, s] = v[1];
    rep = /ed$/.test(lw) ? past : /ing$/.test(lw) ? ing : /(es|s)$/.test(lw) && !/ss$/.test(lw) ? s : /ly$/.test(lw) ? past : base;
  }
  return /^\p{Lu}/u.test(w) ? rep[0].toUpperCase() + rep.slice(1) : rep;
}

export function mapStrings(r: Resume, fn: (s: string) => string): Resume {
  const walk = (v: unknown): unknown =>
    typeof v === "string" ? fn(v) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "url" || k === "link" || k === "email" ? x : walk(x)]))
    : v;
  return walk(r) as Resume;
}

export function replaceBanned(r: Resume): Resume {
  return mapStrings(r, (s) => s.replace(BANNED, replaceWord));
}

// Odd characters reasoning models emit: non-ASCII hyphens, soft hyphens, odd spaces, curly quotes.
// En dashes stay (they mark ranges such as "2019 – 2022").
export function cleanChars(s: string): string {
  return s.replace(/[\u2010\u2011\u2012\u2043\u2212\uFE63\uFF0D]/g, "-").replace(/\u00AD|\u200B|\u200C|\u200D|\uFEFF/g, "")
    .replace(/[\u00A0\u2007\u202F\u2009\u200A]/g, " ").replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D\u201F]/g, '"');
}

export function cleanAllChars(r: Resume): Resume {
  return mapStrings(r, cleanChars);
}

// Em dashes: a pair around an aside becomes commas, a single one becomes a colon.
export function stripEmDash(s: string): string {
  if (!s.includes("—")) return s;
  const n = (s.match(/—/g) ?? []).length;
  let out = n >= 2 ? s.replace(/\s*—\s*/g, ", ") : s.replace(/\s*—\s*/, ": ");
  out = out.replace(/,\s*([.,;:])/g, "$1").replace(/:\s*$/, "").replace(/,\s*$/, "");
  return out;
}

export function stripEmDashes(r: Resume): Resume {
  return mapStrings(r, stripEmDash);
}

// ---------- JD keyword notes (same rule as build_resume.py: case-insensitive substring) ----------

export function keywordNotes(r: Resume) {
  const flat = allText(r).replace(/\s+/g, " ").toLowerCase();
  const found = r.jd_keywords.filter((k) => flat.includes(k.toLowerCase()));
  const missing = r.jd_keywords.filter((k) => !flat.includes(k.toLowerCase()));
  return { keywords_found: found, keywords_missing: missing };
}

// ---------- fine-tune from the first real resume (29 Oct 2026) ----------

// Ligature glyphs from PDF text: "ﬁ" becomes "fi". Live run: "cercit.github.io/ ﬁ nstack/" in the output.
const LIGATURES: Record<string, string> = {
  "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi", "\uFB04": "ffl", "\uFB05": "st", "\uFB06": "st",
};
export function fixLigatures(s: string): string {
  return s.replace(/[\uFB00-\uFB06]/g, (l) => LIGATURES[l]);
}

// A job "intro" that is only a place ("Chennai") belongs next to the dates, as the visitor's resume shows it.
// Live run: the place ended up on its own line under every job title.
const PLACE = /^[|•·]?\s*(\p{Lu}[\p{L}.'-]*)(,?\s+\p{Lu}[\p{L}.'-]*){0,3}$/u;
export function placesIntoDates(p: Profile): Profile {
  const out = structuredClone(p);
  for (const e of out.experience) {
    const intro = (e.intro ?? "").trim();
    if (!intro || intro.length > 40 || /\d/.test(intro) || !PLACE.test(intro)) continue;
    const place = intro.replace(/^[|•·]\s*/, "");
    if (!e.dates.includes(place)) e.dates = e.dates ? `${e.dates} | ${place}` : place;
    e.intro = undefined;
  }
  return out;
}

// Bullets per job by recency: the model cut a 4-bullet role to 2 and older roles to 1, leaving half
// of page 2 empty. Every job from the profile is kept, in the profile's order; a job the model thinned
// gets back the visitor's own bullets (as written) that it does not already cover.
const TARGET = [6, 4, 3];
const sig = (s: string) => new Set(norm(s).trim().split(" ").filter((w) => w.length >= 4));
function covered(bullet: string, list: string[]): boolean {
  const a = sig(bullet);
  if (!a.size) return true;
  return list.some((b) => {
    const bw = sig(b);
    let n = 0;
    a.forEach((w) => { if (bw.has(w)) n++; });
    return n / a.size >= 0.5;
  });
}
export function fillExperience(r: Resume, profile: Profile): Resume {
  const out: Resume = structuredClone(r);
  out.experience = profile.experience.map((p, i) => {
    const e = r.experience.find((x) => key(x.title) === key(p.title) && key(x.company) === key(p.company));
    const want = Math.min(p.bullets.length, TARGET[Math.min(i, TARGET.length - 1)]);
    const job = e ? structuredClone(e) : { ...structuredClone(p), bullets: [] as string[] };
    if (!job.intro && p.intro) job.intro = p.intro;
    for (const b of p.bullets) {
      if (job.bullets.length >= want) break;
      if (!covered(b, job.bullets)) job.bullets.push(b);
    }
    return job;
  });
  out.portfolio = out.portfolio.slice(0, 3);
  if (out.experience.length) out.order = ["experience", "portfolio"];
  return out;
}
