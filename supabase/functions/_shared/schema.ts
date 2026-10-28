// Resume JSON schema: the shape web/render.js draws. Same as base/resume.example.json,
// with personal details turned into data (contact, education, certifications, ...).
//
// The schema is tolerant on purpose. Live run 2026-10-28: a real 2-page resume failed twice with
// "did not return valid JSON" while short samples passed. Models write null for missing fields, return
// more bullets than the limit, or give skills as objects. tidy() fixes those shapes first, and long
// text or lists are trimmed instead of rejected. Facts are still checked by the guards afterwards.
import { z } from "npm:zod@3.23.8";

// A string field: numbers become text, over-long text is trimmed.
const txt = (max: number) =>
  z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string()).transform((s) => s.slice(0, max));
// A list: over-long lists are trimmed to the limit.
const list = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).transform((a) => a.slice(0, max));

const str = txt(2000);
const skillPair = z.tuple([txt(80), txt(600)]);
const orderSchema = z.union([z.tuple([z.literal("experience"), z.literal("portfolio")]),
                             z.tuple([z.literal("portfolio"), z.literal("experience")])]);
const experienceItem = z.object({
  company: txt(160).default(""),
  title: txt(200).default(""),
  dates: txt(120).default(""),
  intro: txt(800).optional(),
  bullets: list(str, 10).default([]),
});
const educationItem = z.object({ title: txt(200).default(""), dates: txt(120).default(""), place: txt(200).default("") });

const ResumeObject = z.object({
  file_name: txt(120).pipe(z.string().min(1)),
  role_line: txt(200).default(""),
  contact: z.object({
    name: txt(120).default(""),
    location: txt(120).default(""),
    phone: txt(60).default(""),
    email: txt(120).default(""),
    links: list(z.object({ label: txt(120), url: txt(300) }), 6).default([]),
  }),
  summary: list(str, 2).pipe(z.array(z.string()).min(1)),
  skills: list(skillPair, 6).pipe(z.array(z.tuple([z.string(), z.string()])).min(1)),
  tools: txt(800).default(""),
  order: orderSchema.catch(["experience", "portfolio"]),
  experience: list(experienceItem, 15).default([]),
  portfolio: list(z.object({
    name: txt(200).default(""),
    date: txt(80).optional(),
    link: txt(300).optional(),
    bullets: list(str, 8).default([]),
  }), 10).default([]),
  education: list(educationItem, 8).default([]),
  certifications: txt(1500).default(""),
  languages: txt(400).default(""),
  hobbies: txt(400).default(""),
  jd_keywords: list(txt(80), 25).default([]),
});

// Fix common model output shapes before validation. Pure and idempotent, so stored JSON parses again.
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const joinList = (v: unknown, sep: string) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(sep) : v);
const asList = (v: unknown) => (typeof v === "string" ? (v.trim() ? [v] : []) : v);

function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(dropNulls);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, dropNulls(x)]));
  return v;
}

function toSkillPair(s: unknown): [string, string] | null {
  if (Array.isArray(s)) return s.length ? [String(s[0] ?? ""), s.slice(1).map(String).join(", ")] : null;
  if (isObj(s)) {
    const label = s.label ?? s.name ?? s.category ?? s.title ?? "";
    const raw = s.text ?? s.items ?? s.skills ?? s.value ?? s.details ?? "";
    return [String(label), Array.isArray(raw) ? raw.map(String).join(", ") : String(raw)];
  }
  if (typeof s === "string" && s.trim()) {
    const i = s.indexOf(":");
    return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : ["Skills", s.trim()];
  }
  return null;
}

export function tidy(raw: unknown): unknown {
  const r = dropNulls(raw);
  if (!isObj(r)) return r;
  r.summary = asList(r.summary);
  if (Array.isArray(r.skills)) r.skills = r.skills.map(toSkillPair).filter((x) => x !== null);
  for (const k of ["tools", "certifications", "languages", "hobbies"]) r[k] = joinList(r[k], k === "certifications" ? " · " : ", ");
  if (isObj(r.contact) && Array.isArray(r.contact.links)) {
    r.contact.links = r.contact.links.map((l) => (typeof l === "string" ? { label: l, url: l } : l));
  }
  for (const k of ["experience", "portfolio"]) {
    if (Array.isArray(r[k])) r[k] = (r[k] as unknown[]).filter(isObj).map((e) => ({ ...e, bullets: asList(e.bullets) }));
  }
  if (typeof r.jd_keywords === "string") r.jd_keywords = r.jd_keywords.split(",").map((s) => s.trim()).filter(Boolean);
  return r;
}

export const ResumeSchema = z.preprocess(tidy, ResumeObject);
export type Resume = z.output<typeof ResumeObject>;

// The extraction step uses the same shape, but nothing is required to be filled in.
const ProfileObject = ResumeObject.extend({
  file_name: txt(120).default("Resume"),
  summary: list(str, 4).default([]),
  skills: list(skillPair, 12).default([]),
});
export const ProfileSchema = z.preprocess(tidy, ProfileObject);
export type Profile = z.output<typeof ProfileObject>;

// Pull the first JSON object out of a model reply (it may wrap it in a code fence).
export function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in the reply");
  return JSON.parse(raw.slice(start, end + 1));
}

export function zodMessage(err: z.ZodError): string {
  return err.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
