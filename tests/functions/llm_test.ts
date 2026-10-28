import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import { callLLM, LLMError } from "../../supabase/functions/_shared/llm.ts";
import { cleanChars } from "../../supabase/functions/_shared/guards.ts";

const call = { model: "m", system: "s", user: "u", maxTokens: 2500 };
const realFetch = globalThis.fetch;

function stub(responses: (() => Response)[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more stub responses");
    return Promise.resolve(next());
  }) as typeof fetch;
  return seen;
}
const ok = (content: unknown, extra = {}) => () =>
  Response.json({ choices: [{ message: { content, reasoning: "thinking out loud...", ...extra }, finish_reason: "stop" }] });

Deno.env.set("LLM_API_KEY", "test-key");
Deno.env.set("ALLOWED_ORIGIN", "https://cercit.github.io");
Deno.env.delete("LLM_PROVIDER");

Deno.test("openrouter: request shape, answer from content, reasoning ignored", async () => {
  const seen = stub([ok('{"a":1}')]);
  assertEquals(await callLLM(call), '{"a":1}');
  assertEquals(seen[0].url, "https://openrouter.ai/api/v1/chat/completions");
  const h = seen[0].init.headers as Record<string, string>;
  assertEquals(h["Authorization"], "Bearer test-key");
  assertEquals(h["HTTP-Referer"], "https://cercit.github.io");
  assertEquals(h["X-Title"], "resume-rag");
  const body = JSON.parse(seen[0].init.body as string);
  assertEquals(body.max_tokens, 2500);
  assertEquals(body.reasoning, { enabled: false });
  assertEquals(body.messages.map((m: { role: string }) => m.role), ["system", "user"]);
  globalThis.fetch = realFetch;
});

Deno.test("openrouter: 429 then 200 succeeds after one retry (about 2 s)", async () => {
  const seen = stub([() => new Response("rate limited", { status: 429 }), ok("fine")]);
  const t = Date.now();
  assertEquals(await callLLM(call), "fine");
  assert(Date.now() - t >= 1900, "waited about 2 s");
  assertEquals(seen.length, 2);
  globalThis.fetch = realFetch;
});

Deno.test("openrouter: 503 twice gives a busy error (no third call)", async () => {
  const seen = stub([() => new Response("down", { status: 503 }), () => new Response("down", { status: 503 })]);
  const e = await assertRejects(() => callLLM(call), LLMError);
  assertEquals((e as LLMError).kind, "busy");
  assertEquals(seen.length, 2);
  globalThis.fetch = realFetch;
});

Deno.test("openrouter: 400 is not retried; empty content (max_tokens used up by reasoning) is an error", async () => {
  let seen = stub([() => new Response("bad", { status: 400 })]);
  assertEquals(((await assertRejects(() => callLLM(call), LLMError)) as LLMError).kind, "http");
  assertEquals(seen.length, 1);
  seen = stub([ok("", { }), ]);
  assertEquals(((await assertRejects(() => callLLM(call), LLMError)) as LLMError).kind, "empty");
  globalThis.fetch = realFetch;
});

Deno.test("character cleanup: non-ASCII hyphens, odd spaces and curly quotes; en dash kept", () => {
  assertEquals(cleanChars("data‑driven team ‘ok’ “yes” 2019 – 2022 co­op"),
    "data-driven team 'ok' \"yes\" 2019 – 2022 coop");
});
