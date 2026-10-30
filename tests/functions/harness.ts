// Test harness: the real pipeline (supabase/functions/_shared/pipeline.ts) against the local
// Postgres test database (tests/sql/reset_local_db.sh), with a scripted fake LLM and fake RAG.
import postgres from "npm:postgres@3.4.4";
import { type Db, DbError, type Deps } from "../../supabase/functions/_shared/pipeline.ts";
import type { LLMCall } from "../../supabase/functions/_shared/llm.ts";
import { EXTRACT_SYSTEM, TAILOR_SYSTEM, TWEAK_SYSTEM } from "../../supabase/functions/_shared/prompts.ts";
import type { Profile, Resume } from "../../supabase/functions/_shared/schema.ts";

export const sql = postgres({
  path: `${Deno.env.get("PGHOST") ?? "/tmp/pg"}/.s.PGSQL.${Deno.env.get("PGPORT") ?? "54329"}`,
  username: "postgres", database: "t1", max: 10, onnotice: () => {},
});

export async function newUser(): Promise<string> {
  const [row] = await sql`insert into auth.users (email) values (${crypto.randomUUID() + "@test.local"}) returning id`;
  return row.id;
}

async function asUser<T>(uid: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claim.sub', ${uid}, true)`;
      await tx.unsafe("set local role authenticated");
      return await fn(tx);
    }) as T;
  } catch (e) {
    throw new DbError((e as Error).message);
  }
}

export function pgDb(uid: string): Db {
  return {
    sessionsToday: () => asUser(uid, async (tx) =>
      Number((await tx`select count(*) as n from resume_sessions where created_at > now() - interval '24 hours' and not via_extra`)[0].n)),
    dailyLimit: () => asUser(uid, async (tx) => Number((await tx`select my_daily_limit() as n`)[0].n)),
    startSession: (jd, p) => asUser(uid, async (tx) => (await tx`select start_session(${jd}, ${tx.json(p as never)}) as id`)[0].id),
    saveVersion: (s, j, t) => asUser(uid, async (tx) => {
      const [r] = await tx`select * from save_version(${s}::uuid, ${tx.json(j as never)}, ${t})`;
      return { version: r.out_version, tweaks_used: r.out_tweaks_used };
    }),
    beginWork: (s) => asUser(uid, async (tx) => (await tx`select begin_work(${s}::uuid) as ok`)[0].ok),
    endWork: (s) => asUser(uid, async (tx) => { await tx`select end_work(${s}::uuid)`; }),
    getSession: (s) => asUser(uid, async (tx) =>
      // deno-lint-ignore no-explicit-any
      ((await tx`select tweaks_used, max_tweaks, current_version, profile_json, jd_text from resume_sessions where id = ${s}::uuid`)[0] ?? null) as any),
    getVersion: (s, v) => asUser(uid, async (tx) =>
      (await tx`select resume_json from resume_versions where session_id = ${s}::uuid and version = ${v}`)[0]?.resume_json ?? null),
    recordSignal: (k, s, d) => asUser(uid, async (tx) => { await tx`select record_signal(${k}, ${s}::uuid, ${tx.json(d as never)})`; })
      .catch(() => {}),
  };
}

export const fakeRag = {
  calls: 0,
  async search(_q: string, count: number, topic: string | null) {
    this.calls++;
    return [{ id: topic ? 100 : 1, source: topic ? "Intro.md" : "huntr.md", heading: "Bullets", similarity: 0.5,
      content: "Start bullets with what you did and the result, measured by a number." }].slice(0, count);
  },
};

// Plain text the way pdf.js would give it from a resume file.
export function resumeText(p: Profile): string {
  const c = p.contact;
  const lines = [c.name, p.role_line, [c.location, c.phone, c.email, ...c.links.map((l) => l.label)].join(" | "), "",
    "SUMMARY", ...p.summary, "", "SKILLS", ...p.skills.map(([k, v]) => `${k}: ${v}`), "", "TOOLS", p.tools, "", "EXPERIENCE"];
  for (const e of p.experience) lines.push(`${e.title}, ${e.company}  ${e.dates}`, ...(e.intro ? [e.intro] : []), ...e.bullets.map((b) => `• ${b}`), "");
  if (p.portfolio.length) lines.push("PROJECTS");
  for (const x of p.portfolio) lines.push(`${x.name}  ${x.date ?? ""}`, x.link ?? "", ...x.bullets.map((b) => `• ${b}`), "");
  lines.push("EDUCATION", ...p.education.map((e) => `${e.title}, ${e.place}, ${e.dates}`), "",
    "CERTIFICATIONS", p.certifications, "LANGUAGES", p.languages, "HOBBIES", p.hobbies);
  return lines.join("\n");
}

export type Script = (call: LLMCall, n: number) => string | Promise<string>;

// Fake LLM: routes by system prompt, counts calls per kind.
export function fakeLLM(handlers: { extract?: Script; tailor?: Script; tweak?: Script }) {
  const count = { extract: 0, tailor: 0, tweak: 0 };
  const calls: LLMCall[] = [];
  const llm = async (c: LLMCall) => {
    calls.push(c);
    const kind = c.system === EXTRACT_SYSTEM ? "extract" : c.system === TAILOR_SYSTEM ? "tailor" : c.system === TWEAK_SYSTEM ? "tweak" : null;
    if (!kind || !handlers[kind]) throw new Error(`unexpected LLM call ${kind}`);
    return await handlers[kind]!(c, count[kind]++);
  };
  return { llm, count, calls };
}

export function deps(uid: string, llm: Deps["llm"]): Deps {
  return { llm, db: pgDb(uid), rag: fakeRag, models: { generate: "fake-generate", tweak: "fake-tweak" } };
}

export async function load(name: string): Promise<Profile> {
  return JSON.parse(await Deno.readTextFile(new URL(`../samples/${name}.json`, import.meta.url)));
}

export async function jd(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`../samples/jd_${name}.txt`, import.meta.url));
}

// A tailored resume the way a good model would write it: same facts, reordered, keywords picked.
export function tailored(p: Profile, keywords: string[]): Resume {
  const r = structuredClone(p) as Resume;
  r.file_name = p.file_name + "_Tailored";
  r.experience = r.experience.map((e) => ({ ...e, bullets: [...e.bullets].reverse() }));
  r.jd_keywords = keywords;
  return r;
}
