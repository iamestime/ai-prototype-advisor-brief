// Memory read endpoints.
// GET /api/public/advisor-memory                      recent briefings (what the system remembers)
// GET /api/public/advisor-memory?ticker=NVDA&session= the conversation turns for a session and company
import { createFileRoute } from "@tanstack/react-router";
import { CORS, readEnv } from "../../../server/advisor/config";
import { getStore } from "../../../server/advisor/memory";
import { validateQuery } from "../../../server/advisor/guardrails";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" } });
}

async function handleMemory(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const cfg = readEnv();
  const store = await getStore();
  const url = new URL(request.url);
  const ticker = url.searchParams.get("ticker");
  if (ticker) {
    const v = validateQuery(ticker);
    if (!v.ok) return json(400, { error: v.message });
    const session = String(url.searchParams.get("session") ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "anon";
    const turns = await store.getTurns(session, v.value.toUpperCase());
    return json(200, { ticker: v.value.toUpperCase(), turns, backend: store.kind });
  }
  const recent = await store.recentBriefings(8);
  return json(200, { recent, backend: store.kind, ttlMs: cfg.MEMORY_TTL_MS, aiConfigured: cfg.providers.length > 0 });
}

export const Route = createFileRoute("/api/public/advisor-memory")({
  server: {
    handlers: {
      GET: async ({ request }) => handleMemory(request),
      OPTIONS: async () => new Response(null, { headers: CORS }),
    },
  },
});
