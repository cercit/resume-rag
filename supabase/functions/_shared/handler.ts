// Shared request handling: CORS, sign-in check, JSON body, and error to plain words.
import { json, preflight } from "./cors.ts";
import { LLMError } from "./llm.ts";
import type { Deps, Result } from "./pipeline.ts";
import { currentUser, makeDeps } from "./supabase.ts";

export function serve(run: (body: Record<string, unknown>, deps: Deps) => Promise<Result>, failMessage: string) {
  Deno.serve(async (req) => {
    const early = preflight(req);
    if (early) return early;
    try {
      const { deps, client } = makeDeps(req);
      if (!(await currentUser(client))) return json(req, { error: "not_signed_in", message: "Please sign in again." }, 401);
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return json(req, { error: "bad_json", message: "Bad request." }, 400);
      }
      const r = await run(body, deps);
      return json(req, r.body, r.status);
    } catch (e) {
      console.error(e instanceof LLMError ? `LLM ${e.kind}: ${e.message}` : e);
      // A timeout means the AI was too slow for the 150 s function limit: treat it as busy, not broken.
      if ((e instanceof LLMError && e.kind === "busy") || (e as Error)?.name === "TimeoutError") {
        return json(req, { error: "llm_busy", message: `The AI service is busy. Try again in a minute. ${failMessage.includes("tweak") ? "You were not charged a tweak." : ""}`.trim() }, 503);
      }
      return json(req, { error: "server_error", message: failMessage }, 502);
    }
  });
}
