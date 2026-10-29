// The generate and tweak flows, written against small interfaces so tests can swap in a fake LLM
// and a local database. index.ts files wire in the real Supabase client and LLM.
import { LLMError, type LLMFn } from "./llm.ts";
import { parseJsonObject, type Profile, ProfileSchema, type Resume, ResumeSchema, zodMessage } from "./schema.ts";
import {
  bannedHits, findUngrounded, keywordNotes, lockFacts, removeUngrounded, replaceBanned, stripEmDashes,
  allText, canonical, cleanAllChars, fillExperience, fixLigatures, placesIntoDates, type Ungrounded,
} from "./guards.ts";
import { EXTRACT_SYSTEM, extractUser, TAILOR_SYSTEM, tailorUser, TWEAK_SYSTEM, tweakUser } from "./prompts.ts";

export interface Chunk { id: number; source: string; heading: string; content: string; similarity: number }

export interface Db {
  sessionsToday(): Promise<number>;
  startSession(jd: string, profileJson: unknown): Promise<string>;
  saveVersion(session: string, json: unknown, tweak: string | null): Promise<{ version: number; tweaks_used: number }>;
  beginWork(session: string): Promise<boolean>;
  endWork(session: string): Promise<void>;
  getSession(session: string): Promise<
    { tweaks_used: number; max_tweaks: number; current_version: number; profile_json: StoredProfile; jd_text: string } | null
  >;
  getVersion(session: string, version: number): Promise<Resume | null>;
}

export interface Rag {
  search(query: string, count: number, topic: string | null): Promise<Chunk[]>;
}

export interface Deps {
  llm: LLMFn;
  db: Db;
  rag: Rag;
  models: { generate: string; tweak: string };
}

// What is stored in resume_sessions.profile_json: the extracted facts plus the resume text they came from.
export interface StoredProfile { profile: Profile; source_text: string }

export interface Result { status: number; body: Record<string, unknown> }

export const LIMITS = { resume: 20_000, jd: 12_000, instruction: 300, minResume: 200 };
const DAILY_SESSIONS = 3;

// DB errors raised by the SQL functions (raise exception 'daily_session_limit' etc.)
export class DbError extends Error {}

const ok = (body: Record<string, unknown>): Result => ({ status: 200, body });
const fail = (status: number, error: string, message: string): Result => ({ status, body: { error, message } });

// ---------- guarded LLM call ----------

interface Problems { schema?: string; ungrounded: Ungrounded[]; banned: string[] }

function describe(p: Problems): string {
  const lines: string[] = [];
  if (p.schema) lines.push(`Your JSON did not match the schema: ${p.schema}. Return valid JSON with the same keys.`);
  if (p.ungrounded.length) {
    lines.push("These items are not in the candidate's resume text. Remove them (do not replace them with other " +
      "invented items): " + p.ungrounded.map((u) => `"${u.item}" (in ${u.path})`).join(", ") + ".");
  }
  if (p.banned.length) lines.push(`Do not use these words: ${p.banned.join(", ")}. Use plain words instead.`);
  return lines.join("\n");
}

// Supabase stops a function at about 150 s. Each request gets one 140 s budget; every LLM call is
// given only the time left. Live run 2026-10-28: a long resume on slow free models hit the 150 s wall.
export interface Budget { left(): number }
export const budget = (ms = 140_000): Budget => {
  const end = Date.now() + ms;
  return { left: () => Math.max(1000, end - Date.now()) };
};
const RETRY_NEEDS_MS = 30_000;

// Run the LLM, parse, validate and guard. One retry with the exact problems listed,
// skipped when the time budget is nearly used up.
async function guarded(
  attempt: (feedback: string) => Promise<string>,
  toResume: (raw: unknown) => Resume,
  check: (r: Resume) => Problems,
  time?: Budget,
): Promise<{ resume: Resume; problems: Problems; raw: unknown }> {
  let feedback = "";
  let last: { resume: Resume; problems: Problems; raw: unknown } | null = null;
  for (let i = 0; i < 2; i++) {
    if (i === 1 && time && time.left() < RETRY_NEEDS_MS) {
      console.warn(`skipping retry: ${Math.round(time.left() / 1000)} s left`);
      if (!last) throw new LLMError("Out of time before a valid answer", "busy");
      break;
    }
    const text = await attempt(feedback);
    let raw: unknown;
    try {
      raw = parseJsonObject(text);
    } catch (e) {
      // Log the shape of the failure (length and how the reply ends), never the reply itself.
      console.warn(`attempt ${i + 1}: not JSON (${(e as Error).message}); reply ${text.length} chars, ends with "}": ${text.trimEnd().endsWith("}")}`);
      feedback = describe({ schema: `not valid JSON (${(e as Error).message})`, ungrounded: [], banned: [] });
      continue;
    }
    let resume: Resume;
    try {
      resume = toResume(raw);
    } catch (e) {
      const msg = (e as { issues?: unknown }).issues ? zodMessage(e as never) : (e as Error).message;
      console.warn(`attempt ${i + 1}: schema: ${msg.slice(0, 400)}`);
      feedback = describe({ schema: msg, ungrounded: [], banned: [] });
      continue;
    }
    const problems = check(resume);
    last = { resume, problems, raw };
    if (!problems.ungrounded.length && !problems.banned.length) return last;
    feedback = describe(problems);
  }
  if (!last) throw new LLMError("The model did not return valid JSON twice", "empty");
  return last;
}

function withFeedback(user: string, feedback: string): string {
  return feedback ? `${user}\n\nYour previous answer had problems. Fix them:\n${feedback}` : user;
}

function finish(r: Resume): Resume {
  return stripEmDashes(replaceBanned(cleanAllChars(r)));
}

// Reasoning models spend part of max_tokens on thinking; below these floors they return nothing.
const TOKENS = { extract: 6000, generate: 8000, tweak: 4000 };

// ---------- extraction ----------

export async function extractProfile(resumeText: string, deps: Deps, time: Budget = budget()): Promise<Profile> {
  const { resume } = await guarded(
    (fb) => deps.llm({ model: deps.models.tweak, system: EXTRACT_SYSTEM, user: withFeedback(extractUser(resumeText), fb),
      maxTokens: TOKENS.extract, effort: "low", timeoutMs: time.left() }),
    (raw) => ProfileSchema.parse(raw) as Resume,
    (r) => ({ ungrounded: findUngrounded(r, resumeText), banned: [] }),
    time,
  );
  const profile = ProfileSchema.parse(resume);
  // whatever is still not in the resume text after the retry is dropped
  const left = findUngrounded(profile as Resume, resumeText);
  return placesIntoDates(left.length ? ProfileSchema.parse(removeUngrounded(profile as Resume, left, profile)) : profile);
}

// ---------- retrieval ----------

async function guidanceFor(query: string, deps: Deps): Promise<Chunk[]> {
  const [general, bullets] = await Promise.all([
    deps.rag.search(query, 8, null),
    deps.rag.search(query, 3, "bullets"),
  ]);
  const seen = new Set<number>();
  return [...general, ...bullets].filter((c) => !seen.has(c.id) && seen.add(c.id));
}

// ---------- generate ----------

export async function generate(input: { resume_text?: unknown; jd_text?: unknown }, deps: Deps): Promise<Result> {
  const resumeText = typeof input.resume_text === "string" ? fixLigatures(input.resume_text).trim() : "";
  const jd = typeof input.jd_text === "string" ? input.jd_text.trim() : "";
  if (!resumeText || !jd) return fail(400, "empty_input", "Add your resume text and the job description.");
  if (resumeText.length > LIMITS.resume) return fail(400, "resume_too_long", "Resume text is over 20,000 characters.");
  if (jd.length > LIMITS.jd) return fail(400, "jd_too_long", "Job description is over 12,000 characters.");
  if (resumeText.length < LIMITS.minResume) {
    return fail(400, "resume_too_short", "This looks like a scan. Paste your resume text instead.");
  }
  // cheap early check so a 4th session does not spend LLM calls; start_session enforces it for real
  if ((await deps.db.sessionsToday()) >= DAILY_SESSIONS) {
    return fail(429, "daily_session_limit", "You have used today's 3 sessions. Try again tomorrow.");
  }

  const time = budget();
  const profile = await extractProfile(resumeText, deps, time);
  const guidance = await guidanceFor(jd, deps);
  let gaps: string[] = [];
  const { resume, problems } = await guarded(
    (fb) => deps.llm({ model: deps.models.generate, system: TAILOR_SYSTEM,
      user: withFeedback(tailorUser(profile, jd, guidance), fb), maxTokens: TOKENS.generate, effort: "medium",
      timeoutMs: time.left() }),
    (raw) => {
      const obj = raw as { resume?: unknown; gaps?: unknown };
      gaps = Array.isArray(obj.gaps) ? obj.gaps.filter((g): g is string => typeof g === "string").slice(0, 10) : [];
      return lockFacts(ResumeSchema.parse(obj.resume ?? raw), profile);
    },
    (r) => ({ ungrounded: findUngrounded(r, resumeText, jd), banned: bannedHits(allText(r)) }),
    time,
  );
  // still not clean after the retry: drop what cannot be grounded, swap leftover banned words
  let final = problems.ungrounded.length ? removeUngrounded(resume, problems.ungrounded, profile) : resume;
  // every job kept, thinned jobs topped up with the visitor's own bullets, experience first
  final = ResumeSchema.parse(finish(fillExperience(final, profile)));
  const stored: StoredProfile = { profile, source_text: resumeText };

  let sessionId: string;
  try {
    sessionId = await deps.db.startSession(jd, stored);
  } catch (e) {
    if (e instanceof DbError && e.message === "daily_session_limit") {
      return fail(429, "daily_session_limit", "You have used today's 3 sessions. Try again tomorrow.");
    }
    throw e;
  }
  await deps.db.saveVersion(sessionId, final, null);
  return ok({
    session_id: sessionId,
    resume: final,
    tweaks_left: 10,
    notes: { ...keywordNotes(final), gaps: stripGaps(gaps), removed: problems.ungrounded.map((u) => u.item) },
  });
}

function stripGaps(g: string[]): string[] {
  return g.map((s) => s.replace(/\s*—\s*/g, ", "));
}

// ---------- tweak ----------

const REFUSAL = "I can only use what is in your resume.";

// An instruction may not bring in facts the visitor's resume does not have. Checked in code, so the
// refusal is certain and free. Live run 2026-10-28: "add 5 years of Kubernetes experience" got past the
// prompt-level refusal because the retry dropped Kubernetes but kept another small edit, which was charged.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inText = (term: string, text: string) =>
  new RegExp(`(^|[^a-z0-9])${esc(term.toLowerCase())}($|[^a-z0-9])`).test(text.toLowerCase());
const META_WORDS = new Set(("add make put move show use include emphasize emphasise highlight rewrite shorten remove " +
  "please more less shorter longer first last sentence line lines bullet bullets section summary skills skill " +
  "experience resume project projects role roles years year job description keywords words").split(" "));

// Before the LLM: "N years" claims and capitalised names (tools, employers, titles) that are not in the resume.
// The first word of a sentence is skipped because it is capitalised anyway.
export function unbackedClaims(instruction: string, resumeText: string): string[] {
  const out: string[] = [];
  for (const m of instruction.matchAll(/\b(\d+)\s*\+?\s*(?:years?|yrs?)\b/gi)) {
    if (!new RegExp(`\\b${m[1]}\\s*\\+?\\s*(years?|yrs?)\\b`, "i").test(resumeText)) out.push(m[0]);
  }
  const tokens = instruction.split(/\s+/);
  tokens.forEach((raw, i) => {
    const w = raw.replace(/^[^\w+#]+|[^\w+#]+$/g, "");
    const sentenceStart = i === 0 || /[.!?]$/.test(tokens[i - 1]);
    if (w.length < 2 || sentenceStart || META_WORDS.has(w.toLowerCase())) return;
    if (/^[A-Z]/.test(w) && !inText(w, resumeText)) out.push(w);
  });
  return out;
}

// After the LLM: words from the instruction that the edit newly put into the resume but the resume never had.
export function smuggledTerms(instruction: string, resumeText: string, before: string, after: string): string[] {
  const words = [...new Set((instruction.match(/[A-Za-z][A-Za-z0-9+#]{3,}/g) ?? []))]
    .filter((w) => !META_WORDS.has(w.toLowerCase()));
  return words.filter((w) => !inText(w, resumeText) && inText(w, after) && !inText(w, before));
}
const LOCKED = new Set(["contact", "education", "certifications", "languages", "hobbies", "file_name"]);
const NEEDS_RAG = /\b(add|include|emphasi[sz]e|rewrite)\b/i;
// Instructions that are plainly not resume edits are refused before any LLM call (and never charged).
const OFF_TOPIC = /(ignore|disregard|forget)\b.{0,40}\b(instructions?|rules?|prompt)|system prompt|\bpoem\b|\bsong\b|\bjoke\b|\bstory\b|write (me )?code/i;

export async function tweak(input: { session_id?: unknown; instruction?: unknown }, deps: Deps): Promise<Result> {
  const session = typeof input.session_id === "string" ? input.session_id : "";
  const instruction = typeof input.instruction === "string" ? input.instruction.trim() : "";
  if (!session || !/^[0-9a-f-]{36}$/i.test(session)) return fail(400, "bad_session", "Missing session.");
  if (!instruction) return fail(400, "empty_input", "Type what you want changed.");
  if (instruction.length > LIMITS.instruction) return fail(400, "instruction_too_long", "Keep it under 300 characters.");
  if (OFF_TOPIC.test(instruction)) return fail(422, "refused", REFUSAL);

  if (!(await deps.db.beginWork(session))) {
    // false means busy, or not this visitor's session (RLS hides other people's rows)
    if (!(await deps.db.getSession(session))) return fail(404, "session_not_found", "Session not found.");
    return fail(409, "busy", "Still working on the last change.");
  }
  try {
    const s = await deps.db.getSession(session);
    if (!s) {
      await deps.db.endWork(session);
      return fail(404, "session_not_found", "Session not found.");
    }
    if (s.tweaks_used >= s.max_tweaks) {
      await deps.db.endWork(session);
      return fail(429, "tweak_limit_reached", "No tweaks left in this session.");
    }
    const current = await deps.db.getVersion(session, s.current_version);
    if (!current) throw new Error("current version missing");
    const { profile, source_text } = s.profile_json;
    if (unbackedClaims(instruction, source_text).length) {
      await deps.db.endWork(session);
      return fail(422, "refused", REFUSAL);
    }
    const guidance = NEEDS_RAG.test(instruction) ? await guidanceFor(`${instruction}\n${s.jd_text}`, deps) : [];

    let refused = false;
    const time = budget();
    const { resume, problems } = await guarded(
      (fb) => deps.llm({ model: deps.models.tweak, system: TWEAK_SYSTEM,
        user: withFeedback(tweakUser(current, profile, instruction, guidance), fb), maxTokens: TOKENS.tweak, effort: "low",
        timeoutMs: time.left() }),
      (raw) => {
        const obj = raw as Record<string, unknown>;
        if (typeof obj.refused === "string") { refused = true; return current; }
        const patch = Object.fromEntries(Object.entries(obj).filter(([k]) => k in current && !LOCKED.has(k)));
        return lockFacts(ResumeSchema.parse({ ...current, ...patch }), profile);
      },
      (r) => (refused ? { ungrounded: [], banned: [] }
        : { ungrounded: findUngrounded(r, source_text, s.jd_text), banned: bannedHits(allText(r)) }),
      time,
    );
    if (refused) {
      console.warn("tweak refused by model");
      await deps.db.endWork(session);
      return fail(422, "refused", REFUSAL);
    }
    // Requests for new facts are already refused above (unbackedClaims), so anything still ungrounded
    // after the retry is model drift: remove it, as generate does, instead of refusing a plain edit.
    if (problems.ungrounded.length) console.warn(`tweak: removed ungrounded at ${problems.ungrounded.map((u) => u.path).join(", ")}`);
    const cleaned = problems.ungrounded.length ? removeUngrounded(resume, problems.ungrounded, profile) : resume;
    const final = ResumeSchema.parse(finish(cleaned));
    if (smuggledTerms(instruction, source_text, allText(ResumeSchema.parse(current)), allText(final)).length) {
      await deps.db.endWork(session);
      return fail(422, "refused", REFUSAL);
    }
    if (canonical(final) === canonical(ResumeSchema.parse(current))) {
      await deps.db.endWork(session);
      return fail(422, "no_change", "That did not change anything. Try saying it another way.");
    }
    let saved;
    try {
      saved = await deps.db.saveVersion(session, final, instruction);
    } catch (e) {
      if (e instanceof DbError && e.message === "tweak_limit_reached") {
        await deps.db.endWork(session);
        return fail(429, "tweak_limit_reached", "No tweaks left in this session.");
      }
      throw e;
    }
    return ok({ resume: final, tweaks_left: s.max_tweaks - saved.tweaks_used, notes: { ...keywordNotes(final) } });
  } catch (e) {
    await deps.db.endWork(session).catch(() => {});
    throw e;
  }
}
