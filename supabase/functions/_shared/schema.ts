// Resume JSON schema: the shape web/render.js draws. Same as base/resume.example.json,
// with personal details turned into data (contact, education, certifications, ...).
import { z } from "npm:zod@3.23.8";

const str = z.string().max(2000);

export const ResumeSchema = z.object({
  file_name: z.string().min(1).max(120),
  role_line: z.string().max(200),
  contact: z.object({
    name: z.string().max(120),
    location: z.string().max(120).default(""),
    phone: z.string().max(60).default(""),
    email: z.string().max(120).default(""),
    links: z.array(z.object({ label: z.string().max(120), url: z.string().max(300) })).max(6).default([]),
  }),
  summary: z.array(str).min(1).max(2),
  skills: z.array(z.tuple([z.string().max(80), z.string().max(600)])).min(1).max(6),
  tools: z.string().max(800),
  order: z.union([z.tuple([z.literal("experience"), z.literal("portfolio")]),
                  z.tuple([z.literal("portfolio"), z.literal("experience")])]),
  experience: z.array(z.object({
    company: z.string().max(160),
    title: z.string().max(200),
    dates: z.string().max(120),
    intro: z.string().max(800).optional(),
    bullets: z.array(str).max(10),
  })).max(15),
  portfolio: z.array(z.object({
    name: z.string().max(200),
    date: z.string().max(80).optional(),
    link: z.string().max(300).optional(),
    bullets: z.array(str).max(8),
  })).max(10).default([]),
  education: z.array(z.object({ title: z.string().max(200), dates: z.string().max(120), place: z.string().max(200) })).max(8),
  certifications: z.string().max(1500).default(""),
  languages: z.string().max(400).default(""),
  hobbies: z.string().max(400).default(""),
  jd_keywords: z.array(z.string().max(80)).max(25).default([]),
});

export type Resume = z.infer<typeof ResumeSchema>;

// The extraction step uses the same shape, but nothing is required to be filled in.
export const ProfileSchema = ResumeSchema.extend({
  file_name: z.string().max(120).default("Resume"),
  role_line: z.string().max(200).default(""),
  summary: z.array(str).max(4).default([]),
  skills: z.array(z.tuple([z.string().max(80), z.string().max(600)])).max(12).default([]),
  tools: z.string().max(800).default(""),
  order: ResumeSchema.shape.order.default(["experience", "portfolio"]),
  experience: ResumeSchema.shape.experience.default([]),
  education: ResumeSchema.shape.education.default([]),
});

export type Profile = z.infer<typeof ProfileSchema>;

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
