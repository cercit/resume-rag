// Quality signals for the weekly review (0004_feedback.sql, docs/feedback-and-weekly-review-plan.md).
// Only numbers, JD keywords, the role title and a tweak's category are kept: never resume or JD text.
// A tweak's own words are kept scrubbed and short, and the database drops them after 30 days.
import type { Resume } from "./schema.ts";

export interface GenerateSignal {
  role: string;
  keywords_missing: string[];
  keywords_dropped: string[];
  jobs: number;
  bullets: number;
  removed: number;
  ms: number;
}

export type TweakCategory = "remove" | "shorten" | "lengthen" | "reorder" | "format" | "tone" | "add_keyword" | "other";
export type TweakOutcome = "applied" | "refused" | "no_change" | "failed";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (term: string, text: string) =>
  new RegExp(`(^|[^a-z0-9])${esc(term.toLowerCase())}($|[^a-z0-9])`).test(text.toLowerCase());

// The role is the last part of the file name the model builds: Resume_<Name>_<Company>_<Role>.
// Live run 30 Oct 2026: the model sometimes drops the spaces ("JuniorSoftwareDeveloper"), so split on capitals.
export function roleOf(r: Resume): string {
  const parts = String(r.file_name ?? "").split("_").filter(Boolean);
  const role = parts.length >= 3 ? parts[parts.length - 1] : "";
  return role.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
}

// keywords_dropped = JD keywords the visitor's resume already has but the tailored one lost: our misses.
export function signalsFromGenerate(sourceText: string, final: Resume, keywordsMissing: string[], removed: number, ms: number): GenerateSignal {
  const missing = keywordsMissing.slice(0, 30).map((k) => k.slice(0, 60));
  return {
    role: roleOf(final),
    keywords_missing: missing,
    keywords_dropped: missing.filter((k) => hasWord(k, sourceText)),
    jobs: final.experience.length,
    bullets: final.experience.reduce((n, e) => n + e.bullets.length, 0),
    removed,
    ms: Math.round(ms),
  };
}

// Order matters: "remove the long bullet" is a removal, not a shortening.
const CATEGORIES: [TweakCategory, RegExp][] = [
  ["remove", /\b(remove|delete|drop|cut out|take out|get rid of|without)\b/i],
  ["shorten", /\b(short(en|er)?|trim|concise|brief|condense|less|fewer|one (line|sentence|page)|reduce)\b/i],
  ["lengthen", /\b(long(er)?|expand|elaborate|more detail|add more|lengthen|fill)\b/i],
  ["reorder", /\b(first|top|before|after|move|reorder|order|swap|up front|last)\b/i],
  ["format", /\b(bold|font|bullet points?|format|heading|capital|spacing|layout|page|pdf|date format)\b/i],
  ["tone", /\b(tone|formal|professional|confident|simple|plain|active voice|wording|reword|rephrase|rewrite)\b/i],
  ["add_keyword", /\b(add|include|mention|emphasi[sz]e|highlight|keyword|show)\b/i],
];

export function tweakCategory(instruction: string): TweakCategory {
  for (const [name, re] of CATEGORIES) if (re.test(instruction)) return name;
  return "other";
}

// Emails, URLs, phone numbers and any number of 4+ digits become [x]; capped at 200 characters.
export function scrub(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[x]")
    .replace(/\b(https?:\/\/|www\.)\S+/gi, "[x]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[x]")
    .replace(/\d{4,}/g, "[x]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function tweakSignal(instruction: string, outcome: TweakOutcome, ms: number) {
  return { category: tweakCategory(instruction), outcome, text: scrub(instruction), ms: Math.round(ms) };
}
