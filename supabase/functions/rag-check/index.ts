// Ingestion sanity test, called by `python ingest/ingest.py --check` with the service-role key.
// Embeds a stored chunk's own text with the runtime's gte-small and checks match_documents returns
// that same chunk with similarity above 0.95 (proves ingest and query use the same embeddings).
import { embed, serviceClient } from "../_shared/supabase.ts";

// The caller must hold an admin key. Asking Auth's admin endpoint works for both the legacy
// service_role JWT and the newer sb_secret_ keys, where a string compare against the injected
// SUPABASE_SERVICE_ROLE_KEY can fail even for a valid key.
async function isAdminKey(token: string): Promise<boolean> {
  if (!token) return false;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/admin/users?per_page=1`, {
    headers: { apikey: token, Authorization: `Bearer ${token}` },
  });
  await r.body?.cancel();
  return r.status === 200;
}

Deno.serve(async (req) => {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await isAdminKey(token))) return new Response("forbidden", { status: 403 });
  const { text, content_hash } = await req.json();
  const svc = serviceClient();
  const { data: row } = await svc.from("documents").select("id").eq("content_hash", content_hash).maybeSingle();
  const { data, error } = await svc.rpc("match_documents", {
    query_embedding: JSON.stringify(await embed(text)), match_count: 3, min_similarity: 0, filter_topic: null,
  });
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  const top = data?.[0];
  const ok = !!row && top?.id === row.id && top.similarity > 0.95;
  return Response.json({ ok, expected_id: row?.id ?? null, top_id: top?.id, top_similarity: top?.similarity });
});
