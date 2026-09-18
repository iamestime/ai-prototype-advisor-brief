// Memory: what the system remembers between requests.
//
//   Briefing memory   the finished briefing for a company (blocks, validations, digest, quote, filings). A repeat
//                     request replays it in under a second instead of re reading the filings and re paying for
//                     the model. Keyed by ticker plus the accession numbers that were read, so a new filing
//                     invalidates the memory automatically. TTL applies on top.
//   Conversation      the advisor's follow up questions and the grounded answers, per session and company, so
//                     "and what about margins?" is understood in context. Capped at the last 12 turns.
//   Retrieval index   the chunked, embedded filing text for a company (see retrieval.ts), reused by every
//                     question about that company.
//
// The default store is in process (per warm instance). MEMORY_BACKEND=supabase switches briefing and
// conversation memory to Postgres through the Supabase service client, which survives restarts and is shared
// across instances. The SQL for those tables is in deploy/sql/advisor_memory.sql. The interface is the same
// either way, so an AWS deployment can back it with DynamoDB or ElastiCache without touching the routes.
import type { VectorIndex } from "./retrieval";

export type BriefingRecord = {
  key: string;
  ticker: string;
  name: string;
  cik: number;
  generatedAt: string;
  accessions: string[];
  events: Array<{ event: string; data: unknown }>; // the SSE events replayed on a memory hit
  summary: { status: string | null; claims: number; supported: number; researchFailed: boolean; price: number | null; changePct: number | null };
};

export type Turn = { role: "user" | "assistant"; content: string; at: string; citations?: string[]; verdict?: string };

export interface MemoryStore {
  kind: "memory" | "supabase";
  getBriefing(key: string): Promise<BriefingRecord | null>;
  putBriefing(rec: BriefingRecord, ttlMs: number): Promise<void>;
  recentBriefings(limit: number): Promise<Array<Omit<BriefingRecord, "events">>>;
  latestBriefingFor(ticker: string): Promise<BriefingRecord | null>;
  getTurns(session: string, ticker: string): Promise<Turn[]>;
  appendTurns(session: string, ticker: string, turns: Turn[], cap: number): Promise<void>;
  getIndex(key: string): VectorIndex | null;
  putIndex(index: VectorIndex): void;
}

class InMemoryStore implements MemoryStore {
  kind: "memory" | "supabase" = "memory";
  private briefings = new Map<string, { rec: BriefingRecord; expires: number }>();
  private turns = new Map<string, Turn[]>();
  private indexes = new Map<string, VectorIndex>();

  async getBriefing(key: string) {
    const hit = this.briefings.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) { this.briefings.delete(key); return null; }
    return hit.rec;
  }
  async putBriefing(rec: BriefingRecord, ttlMs: number) {
    this.briefings.set(rec.key, { rec, expires: Date.now() + ttlMs });
    if (this.briefings.size > 100) {
      const oldest = [...this.briefings.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
      if (oldest) this.briefings.delete(oldest[0]);
    }
  }
  async recentBriefings(limit: number) {
    const now = Date.now();
    return [...this.briefings.values()]
      .filter((x) => x.expires > now)
      .map((x) => x.rec)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
      .slice(0, limit)
      .map(({ events: _e, ...rest }) => rest);
  }
  async latestBriefingFor(ticker: string) {
    const now = Date.now();
    const rows = [...this.briefings.values()].filter((x) => x.expires > now && x.rec.ticker === ticker).map((x) => x.rec).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    return rows[0] ?? null;
  }
  async getTurns(session: string, ticker: string) {
    return this.turns.get(`${session}|${ticker}`) ?? [];
  }
  async appendTurns(session: string, ticker: string, turns: Turn[], cap: number) {
    const k = `${session}|${ticker}`;
    const all = [...(this.turns.get(k) ?? []), ...turns].slice(-cap);
    this.turns.set(k, all);
    if (this.turns.size > 2000) this.turns.clear();
  }
  getIndex(key: string) { return this.indexes.get(key) ?? null; }
  putIndex(index: VectorIndex) {
    this.indexes.set(index.key, index);
    if (this.indexes.size > 40) { const first = this.indexes.keys().next().value; if (first) this.indexes.delete(first); }
  }
}

/** Postgres backed briefing and conversation memory through the Supabase service client. Indexes stay in process. */
class SupabaseStore extends InMemoryStore implements MemoryStore {
  override kind: "memory" | "supabase" = "supabase";
  private client: any;
  constructor(client: any) { super(); this.client = client; }
  override async getBriefing(key: string) {
    const { data } = await this.client.from("advisor_briefings").select("*").eq("key", key).gt("expires_at", new Date().toISOString()).maybeSingle();
    return data ? (data.record as BriefingRecord) : null;
  }
  override async putBriefing(rec: BriefingRecord, ttlMs: number) {
    await this.client.from("advisor_briefings").upsert({ key: rec.key, ticker: rec.ticker, generated_at: rec.generatedAt, expires_at: new Date(Date.now() + ttlMs).toISOString(), summary: rec.summary, record: rec });
  }
  override async recentBriefings(limit: number) {
    const { data } = await this.client.from("advisor_briefings").select("key,ticker,generated_at,summary,record").gt("expires_at", new Date().toISOString()).order("generated_at", { ascending: false }).limit(limit);
    return (data ?? []).map((r: any) => { const { events: _e, ...rest } = r.record as BriefingRecord; return rest; });
  }
  override async latestBriefingFor(ticker: string) {
    const { data } = await this.client.from("advisor_briefings").select("record").eq("ticker", ticker).gt("expires_at", new Date().toISOString()).order("generated_at", { ascending: false }).limit(1);
    return data?.[0]?.record ?? null;
  }
  override async getTurns(session: string, ticker: string) {
    const { data } = await this.client.from("advisor_conversations").select("turns").eq("session_id", session).eq("ticker", ticker).maybeSingle();
    return (data?.turns as Turn[]) ?? [];
  }
  override async appendTurns(session: string, ticker: string, turns: Turn[], cap: number) {
    const all = [...(await this.getTurns(session, ticker)), ...turns].slice(-cap);
    await this.client.from("advisor_conversations").upsert({ session_id: session, ticker, turns: all, updated_at: new Date().toISOString() });
  }
}

let store: MemoryStore | null = null;

export async function getStore(): Promise<MemoryStore> {
  if (store) return store;
  const backend = (typeof process !== "undefined" ? process.env["MEMORY_BACKEND"] : "") ?? "";
  if (backend === "supabase") {
    try {
      const { supabaseAdmin } = await import("../../integrations/supabase/client.server");
      // probe once; fall back to in process memory if the tables are not there
      const { error } = await (supabaseAdmin as any).from("advisor_briefings").select("key").limit(1);
      if (!error) { store = new SupabaseStore(supabaseAdmin); return store; }
      console.warn(`[advisor-brief] MEMORY_BACKEND=supabase but the tables are not reachable (${error.message}); using in process memory`);
    } catch (e) {
      console.warn(`[advisor-brief] Supabase memory unavailable: ${(e as Error).message}; using in process memory`);
    }
  }
  store = new InMemoryStore();
  return store;
}

export function briefingKey(ticker: string, accessions: string[]): string {
  return `${ticker.toUpperCase()}|${[...accessions].sort().join(",")}`;
}
