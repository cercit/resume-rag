import { assertEquals } from "jsr:@std/assert@1.0.8";
import { corsHeaders, preflight } from "../../supabase/functions/_shared/cors.ts";

Deno.env.set("ALLOWED_ORIGIN", "https://cercit.github.io");
const req = (origin: string | null, method = "POST") =>
  new Request("http://x/generate", { method, headers: origin ? { Origin: origin } : {} });

Deno.test("cors: Pages origin and localhost allowed, others refused", () => {
  assertEquals(corsHeaders(req("https://cercit.github.io"))["Access-Control-Allow-Origin"], "https://cercit.github.io");
  assertEquals(corsHeaders(req("http://localhost:8000"))["Access-Control-Allow-Origin"], "http://localhost:8000");
  assertEquals(corsHeaders(req("https://evil.example"))["Access-Control-Allow-Origin"], undefined);
  assertEquals(preflight(req("https://evil.example"))?.status, 403);
  assertEquals(preflight(req("https://cercit.github.io", "OPTIONS"))?.status, 200);
  assertEquals(preflight(req("https://cercit.github.io", "GET"))?.status, 405);
  assertEquals(preflight(req("https://cercit.github.io")), null);
});
