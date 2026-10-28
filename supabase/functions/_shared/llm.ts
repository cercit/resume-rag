// One place that talks to the LLM provider. Text in, text out. No files, no images.
// Provider is OpenRouter (OpenAI-compatible chat completions, INSTRUCTIONS.md section 2b).
// LLM_PROVIDER=anthropic switches to the Anthropic Messages API. Key in LLM_API_KEY.

export interface LLMCall {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  effort?: "low" | "medium" | "high";
  timeoutMs?: number; // time left in the request budget; default 110 s
}

export type LLMFn = (c: LLMCall) => Promise<string>;

export class LLMError extends Error {
  constructor(message: string, public kind: "refusal" | "http" | "empty" | "busy" = "http") {
    super(message);
  }
}

export const MODEL_GENERATE = () => Deno.env.get("LLM_MODEL_GENERATE") ?? "nvidia/nemotron-3-ultra-550b-a55b:free";
export const MODEL_TWEAK = () => Deno.env.get("LLM_MODEL_TWEAK") ?? "nvidia/nemotron-3.5-lightning:free";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 429 and 5xx get one retry after 2 seconds; after that the caller shows "busy, try again".
async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 110_000): Promise<Response> {
  const until = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1000, until - Date.now())) });
    } catch (e) {
      if (attempt === 0 && until - Date.now() > 20_000) { await sleep(2000); continue; }
      throw new LLMError(`LLM network error: ${(e as Error).message}`, "busy");
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt === 0 && until - Date.now() > 20_000) {
      await res.body?.cancel();
      await sleep(2000);
      continue;
    }
    const text = (await res.text()).slice(0, 300);
    throw new LLMError(`LLM HTTP ${res.status}: ${text}`, res.status === 429 || res.status >= 500 ? "busy" : "http");
  }
}

function key(): string {
  const k = Deno.env.get("LLM_API_KEY");
  if (!k) throw new LLMError("LLM_API_KEY is not set");
  return k;
}

async function openrouter(c: LLMCall): Promise<string> {
  const base = (Deno.env.get("LLM_BASE_URL") ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const res = await post(`${base}/chat/completions`, {
    "Authorization": `Bearer ${key()}`,
    "Content-Type": "application/json",
    "HTTP-Referer": Deno.env.get("ALLOWED_ORIGIN")?.split(",")[0] ?? "https://cercit.github.io",
    "X-Title": "resume-rag",
  }, {
    model: c.model,
    max_tokens: c.maxTokens,
    messages: [{ role: "system", content: c.system }, { role: "user", content: c.user }],
    // Thinking off by default. Live run 2026-10-28: with thinking on, Nemotron used the whole token budget
    // and returned no answer (finish_reason length, 93 s). Off: valid JSON in 10-13 s on both models.
    // Set the LLM_REASONING secret to "on" to let the model think again.
    reasoning: { enabled: (Deno.env.get("LLM_REASONING") ?? "off") === "on" },
  }, c.timeoutMs);
  let data;
  try {
    data = await res.json(); // the timeout also covers reading the reply body
  } catch (e) {
    throw new LLMError(`LLM reply not read: ${(e as Error).name}`, "busy");
  }
  if (data.error) throw new LLMError(`LLM error: ${JSON.stringify(data.error).slice(0, 300)}`, "busy");
  // reasoning models also return a `reasoning` field; only the answer is used
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new LLMError(`LLM returned no text (finish_reason ${data.choices?.[0]?.finish_reason})`, "empty");
  }
  return text;
}

async function anthropic(c: LLMCall): Promise<string> {
  const body: Record<string, unknown> = {
    model: c.model,
    max_tokens: c.maxTokens,
    system: c.system,
    messages: [{ role: "user", content: [{ type: "text", text: c.user }] }],
  };
  if (c.effort) body.output_config = { effort: c.effort };
  const res = await post("https://api.anthropic.com/v1/messages",
    { "x-api-key": key(), "anthropic-version": "2023-06-01", "content-type": "application/json" }, body);
  const data = await res.json();
  if (data.stop_reason === "refusal") throw new LLMError("LLM refused the request", "refusal");
  const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text).join("");
  if (!text.trim()) throw new LLMError("LLM returned no text", "empty");
  return text;
}

export const callLLM: LLMFn = (c) => {
  const provider = Deno.env.get("LLM_PROVIDER") ?? "openrouter";
  if (provider === "openrouter") return openrouter(c);
  if (provider === "anthropic") return anthropic(c);
  throw new LLMError(`Unknown LLM_PROVIDER ${provider}`);
};
