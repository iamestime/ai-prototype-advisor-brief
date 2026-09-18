// Model provider chain. Every call tries the configured providers in order (Gemini, then OpenAI).
// A 402, 429, or 5xx moves to the next provider. The caller learns which provider served the call.
// Vendor detail never reaches the browser: `clientReason` returns a neutral sentence for advisors,
// and the full attempt list goes to the server log (or to the client only when DEBUG_ERRORS is on).
import type { Cfg, Provider } from "./config";

export class AiUnavailable extends Error {
  attempts: string[];
  constructor(attempts: string[]) {
    super(attempts.length ? `AI unavailable: ${attempts.join("; ")}` : "No model provider is configured (set GEMINI_API_KEY or OPENAI_API_KEY).");
    this.name = "AiUnavailable";
    this.attempts = attempts;
  }
}

export type ServedResponse = Response & { provider: Provider["name"]; timer: ReturnType<typeof setTimeout> };

/** Neutral, client safe wording for a failed model call. Never names a vendor or a billing state. */
export function clientReason(e: unknown, cfg: Cfg, subject = "The narrative briefing"): { message: string; code: string } {
  const err = e as Error & { attempts?: string[] };
  if (!cfg.providers.length) return { code: "no_provider", message: `${subject} is not configured for this environment yet.` };
  if (err?.name === "AbortError" || /no response within/.test(String(err?.message))) {
    return { code: "timeout", message: `${subject} took longer than expected and was stopped.` };
  }
  return { code: "unavailable", message: `${subject} could not be generated for this request.` };
}

/** Log the real reason server side. This is the only place vendor detail is written. */
export function logAiFailure(where: string, e: unknown) {
  const err = e as Error & { attempts?: string[] };
  console.error(`[advisor-brief] ${where}: ${err?.message ?? e}${err?.attempts?.length ? ` | attempts: ${err.attempts.join(" | ")}` : ""}`);
}

async function tryProviders<T>(
  cfg: Cfg,
  timeoutMs: number,
  attempt: (p: Provider, signal: AbortSignal) => Promise<{ ok: true; value: T } | { ok: false; status: number; text: string }>,
): Promise<{ value: T; provider: Provider["name"]; timer: ReturnType<typeof setTimeout> }> {
  const attempts: string[] = [];
  for (const p of cfg.providers) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await attempt(p, ctl.signal);
      if (r.ok) return { value: r.value, provider: p.name, timer };
      clearTimeout(timer);
      if (r.status === 402) attempts.push(`${p.name}: billing (402)`);
      else if (r.status === 429) attempts.push(`${p.name}: rate limited (429)`);
      else attempts.push(`${p.name}: ${r.status} ${r.text.slice(0, 200)}`);
      // 4xx other than 402 and 429 is a request problem that another provider is unlikely to fix, but the
      // fallback is cheap and the second provider may accept the request shape. Continue.
    } catch (e) {
      clearTimeout(timer);
      const err = e as Error;
      attempts.push(`${p.name}: ${err.name === "AbortError" ? `no response within ${Math.round(timeoutMs / 1000)}s` : String(err.message ?? e)}`);
    }
  }
  throw new AiUnavailable(attempts);
}

/** Chat completion. Returns the raw Response so streaming callers can read the body. */
export async function chat(cfg: Cfg, body: Record<string, unknown>, timeoutMs: number): Promise<ServedResponse> {
  const out = await tryProviders<Response>(cfg, timeoutMs, async (p, signal) => {
    const r = await fetch(p.chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ ...body, model: p.mapChatModel(String(body["model"])) }),
      signal,
    });
    if (r.ok) return { ok: true, value: r };
    return { ok: false, status: r.status, text: await r.text().catch(() => "") };
  });
  const r = out.value as ServedResponse;
  r.provider = out.provider;
  r.timer = out.timer;
  return r;
}

/** Non streaming chat that returns the assistant text. */
export async function chatText(cfg: Cfg, body: Record<string, unknown>, timeoutMs: number): Promise<{ text: string; usage: any; provider: Provider["name"] }> {
  const r = await chat(cfg, body, timeoutMs);
  try {
    const resp = await r.json();
    return { text: resp.choices?.[0]?.message?.content ?? "", usage: resp.usage, provider: r.provider };
  } finally {
    clearTimeout(r.timer);
  }
}

/** Embeddings for a batch of texts. Returns null when no provider can embed (retrieval falls back to lexical). */
export async function embed(cfg: Cfg, texts: string[], timeoutMs: number): Promise<{ vectors: number[][]; provider: Provider["name"]; model: string } | null> {
  if (!cfg.providers.length || !texts.length) return null;
  try {
    const out = await tryProviders<{ vectors: number[][]; model: string }>(cfg, timeoutMs, async (p, signal) => {
      const model = p.mapEmbedModel(cfg.EMBED_MODEL);
      const r = await fetch(p.embedUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
        body: JSON.stringify({ model, input: texts }),
        signal,
      });
      if (!r.ok) return { ok: false, status: r.status, text: await r.text().catch(() => "") };
      const j = await r.json();
      const rows: Array<{ index: number; embedding: number[] }> = j.data ?? [];
      const vectors = rows.sort((a, b) => a.index - b.index).map((x) => x.embedding);
      return { ok: true, value: { vectors, model } };
    });
    clearTimeout(out.timer);
    return { vectors: out.value.vectors, provider: out.provider, model: out.value.model };
  } catch (e) {
    logAiFailure("embed", e);
    return null;
  }
}
