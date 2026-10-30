// Real dependencies for the Edge Functions: a Supabase client that acts as the visitor (their JWT,
// so auth.uid() and RLS apply), a service-role client used only for match_documents, gte-small
// embeddings from the Supabase runtime, and the LLM.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { callLLM, MODEL_GENERATE, MODEL_TWEAK } from "./llm.ts";
import { type Chunk, type Db, DbError, type Deps, type Rag } from "./pipeline.ts";
import type { Resume } from "./schema.ts";

const URL = () => Deno.env.get("SUPABASE_URL")!;

export function userClient(req: Request): SupabaseClient {
  return createClient(URL(), Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
}

function serviceClient(): SupabaseClient {
  return createClient(URL(), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

// Signed-in user or null. Anonymous sign-ins do not count.
export async function currentUser(client: SupabaseClient) {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user || data.user.is_anonymous) return null;
  return data.user;
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new DbError(res.error.message);
  return res.data;
}

export function makeDb(c: SupabaseClient): Db {
  return {
    async sessionsToday() {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count, error } = await c.from("resume_sessions").select("id", { count: "exact", head: true })
        .gte("created_at", since).eq("via_extra", false);
      if (error) throw new DbError(error.message);
      return count ?? 0;
    },
    async dailyLimit() {
      // falls back to the default 3 if the database does not have my_daily_limit yet
      const { data, error } = await c.rpc("my_daily_limit");
      return error || typeof data !== "number" ? 3 : data;
    },
    async startSession(jd, profileJson) {
      return check(await c.rpc("start_session", { p_jd: jd, p_profile: profileJson })) as string;
    },
    async saveVersion(session, json, tweak) {
      const rows = check(await c.rpc("save_version", { p_session: session, p_json: json, p_tweak: tweak })) as
        { out_version: number; out_tweaks_used: number }[];
      return { version: rows[0].out_version, tweaks_used: rows[0].out_tweaks_used };
    },
    async beginWork(session) {
      return check(await c.rpc("begin_work", { p_session: session })) as boolean;
    },
    async endWork(session) {
      check(await c.rpc("end_work", { p_session: session }));
    },
    async getSession(session) {
      return check(await c.from("resume_sessions")
        .select("tweaks_used, max_tweaks, current_version, profile_json, jd_text").eq("id", session).maybeSingle());
    },
    async getVersion(session, version) {
      const row = check(await c.from("resume_versions").select("resume_json").eq("session_id", session)
        .eq("version", version).maybeSingle()) as { resume_json: Resume } | null;
      return row?.resume_json ?? null;
    },
    async recordSignal(kind, session, data) {
      // a lost signal must never cost the visitor their resume
      try {
        const { error } = await c.rpc("record_signal", { p_kind: kind, p_session: session, p_data: data });
        if (error) console.warn(`record_signal ${kind}: ${error.message}`);
      } catch (e) {
        console.warn(`record_signal ${kind}: ${(e as Error).message}`);
      }
    },
  };
}

// Supabase.ai is a global of the Edge Runtime (gte-small, 384 dims).
type AiSession = { run(text: string, opts: { mean_pool: boolean; normalize: boolean }): Promise<unknown> };
const runtime = globalThis as unknown as { Supabase: { ai: { Session: new (model: string) => AiSession } } };
let embedder: AiSession | null = null;

export async function embed(text: string): Promise<number[]> {
  embedder ??= new runtime.Supabase.ai.Session("gte-small");
  return await embedder.run(text, { mean_pool: true, normalize: true }) as number[];
}

export function makeRag(): Rag {
  const svc = serviceClient();
  return {
    async search(query, count, topic) {
      const embedding = await embed(query);
      const rows = check(await svc.rpc("match_documents", {
        query_embedding: JSON.stringify(embedding),
        match_count: count,
        min_similarity: 0.25,
        filter_topic: topic,
      })) as Chunk[];
      return rows ?? [];
    },
  };
}

export function makeDeps(req: Request): { deps: Deps; client: SupabaseClient } {
  const client = userClient(req);
  return {
    client,
    deps: { llm: callLLM, db: makeDb(client), rag: makeRag(), models: { generate: MODEL_GENERATE(), tweak: MODEL_TWEAK() } },
  };
}

export { serviceClient };
