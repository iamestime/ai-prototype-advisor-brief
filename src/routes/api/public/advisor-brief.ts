// Advisor Brief: one endpoint that streams a cited stock briefing over Server Sent Events.
// GET /api/public/advisor-brief?q=NVDA
//
// Data: SEC EDGAR (filings, XBRL company facts), Yahoo Finance chart endpoint (prototype quote source).
// Intelligence: Lovable AI gateway (no vendor API key), one streamed NDJSON call, citation validation.
// Env: LOVABLE_API_KEY (provided by Lovable AI), AI_MODEL (optional), EDGAR_USER_AGENT (recommended).
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Env is injected per request on the server runtime, so it is read inside the handler.
type Cfg = { EDGAR_UA: string; AI_MODEL: string };
let CFG: Cfg = { EDGAR_UA: "AdvisorBrief prototype contact@example.com", AI_MODEL: "google/gemini-2.5-pro" };
function readEnv(): Cfg {
  const e = process.env;
  return {
    EDGAR_UA: e["EDGAR_USER_AGENT"] ?? "AdvisorBrief prototype contact@example.com",
    AI_MODEL: e["AI_MODEL"] ?? AI_MODEL_DEFAULT,
  };
}

const DISCLAIMER =
  "For internal advisor preparation only. Not investment advice, not a recommendation, not for distribution to clients. " +
  "Generated from public SEC filings and market data as of the timestamps shown. Verify against the cited filing before relying on any statement.";

const SECTION_CHAR_BUDGET: Record<string, number> = { "Item 1": 18000, "Item 1A": 30000, "Item 7": 45000, "Item 2": 45000, "8-K": 6000 };

// ---------- small in-memory cache (per warm instance) ----------
const memo = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

// ---------- EDGAR ----------
let lastEdgar = 0;
async function edgarGet(url: string, asJson = true): Promise<any> {
  const wait = 120 - (Date.now() - lastEdgar); // under 10 requests per second
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastEdgar = Date.now();
  const r = await fetch(url, { headers: { "User-Agent": CFG.EDGAR_UA, "Accept-Encoding": "gzip, deflate" } });
  if (!r.ok) throw new Error(`EDGAR ${r.status} for ${url}`);
  return asJson ? r.json() : r.text();
}

type Company = { cik: number; ticker: string; name: string; [k: string]: unknown };
async function resolve(query: string): Promise<Company> {
  const q = query.trim();
  if (!q) throw new Error("Empty query");
  const table = await cached("tickers", 24 * 3600e3, () => edgarGet("https://www.sec.gov/files/company_tickers.json"));
  const rows = Object.values(table) as Array<{ cik_str: number; ticker: string; title: string }>;
  const qu = q.toUpperCase();
  const exact = rows.find((r) => r.ticker.toUpperCase() === qu);
  if (exact) return { cik: Number(exact.cik_str), ticker: exact.ticker, name: exact.title };
  const ql = q.toLowerCase();
  const hits = rows.filter((r) => r.title.toLowerCase().includes(ql))
    .sort((a, b) => Number(!a.title.toLowerCase().startsWith(ql)) - Number(!b.title.toLowerCase().startsWith(ql)) || a.title.length - b.title.length);
  if (hits.length) return { cik: Number(hits[0].cik_str), ticker: hits[0].ticker, name: hits[0].title };
  throw new Error(`No SEC registrant matches '${query}'`);
}

async function submissions(cik: number): Promise<any> {
  return cached(`sub_${cik}`, 3600e3, async () => {
    const pad = String(cik).padStart(10, "0");
    const data = await edgarGet(`https://data.sec.gov/submissions/CIK${pad}.json`);
    const rec = data.filings.recent;
    for (const extra of data.filings.files ?? []) {
      if (rec.form.includes("10-K") && rec.form.includes("10-Q")) break;
      const page = await edgarGet("https://data.sec.gov/submissions/" + extra.name);
      for (const [k, v] of Object.entries(page)) if (Array.isArray(v) && Array.isArray(rec[k])) rec[k].push(...(v as unknown[]));
    }
    return data;
  });
}

type Filing = { form: string; filingDate: string; reportDate: string; accession: string; primaryDocument: string; items: string; url: string; indexUrl: string };
function selectFilings(sub: any, cik: number, days8k = 90) {
  const rec = sub.filings.recent;
  const n = rec.accessionNumber.length;
  const table: Filing[] = [];
  for (let i = 0; i < n; i++) {
    const acc = rec.accessionNumber[i];
    const accNo = acc.replace(/-/g, "");
    table.push({
      form: rec.form[i], filingDate: rec.filingDate[i], reportDate: rec.reportDate?.[i] ?? "", accession: acc,
      primaryDocument: rec.primaryDocument[i], items: rec.items?.[i] ?? "",
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accNo}/${rec.primaryDocument[i]}`,
      indexUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accNo}/`,
    });
  }
  const cutoff = new Date(Date.now() - days8k * 864e5).toISOString().slice(0, 10);
  return {
    company: { cik, name: sub.name, sic: sub.sic, sicDescription: sub.sicDescription, fiscalYearEnd: sub.fiscalYearEnd, stateOfIncorporation: sub.stateOfIncorporation, exchanges: sub.exchanges, tickers: sub.tickers },
    "10-K": table.find((f) => f.form === "10-K") ?? null,
    "10-Q": table.find((f) => f.form === "10-Q") ?? null,
    "8-K": table.filter((f) => f.form === "8-K" && f.filingDate >= cutoff),
  };
}

const document_ = (f: Filing) => cached(`doc_${f.accession}`, 6 * 3600e3, () => edgarGet(f.url, false) as Promise<string>);
const companyFacts = (cik: number) => cached(`facts_${cik}`, 3600e3, () => edgarGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`));

// ---------- XBRL financials ----------
const REVENUE_TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax", "InterestAndDividendIncomeOperating", "TotalRevenuesAndOtherIncome"];
const NET_INCOME_TAGS = ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"];
const EPS_TAGS = ["EarningsPerShareDiluted", "EarningsPerShareBasic"];
const DIVIDEND_TAGS = ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"];

function quarterlySeries(facts: any, tags: string[], units = ["USD"], quarters = 8) {
  const gaap = facts?.facts?.["us-gaap"] ?? {};
  let tag: string | null = null, vals: any[] = [];
  outer: for (const t of tags) for (const u of units) { const v = gaap[t]?.units?.[u]; if (v?.length) { tag = t; vals = v; break outer; } }
  if (!vals.length) return { tag: null, points: [] as any[] };
  const q = new Map<string, any>(), y = new Map<number, any>();
  for (const v of vals) {
    const fr: string = v.frame ?? "";
    let m = /^CY(\d{4})Q([1-4])$/.exec(fr);
    if (m) { q.set(`${m[1]}-${m[2]}`, v); continue; }
    m = /^CY(\d{4})$/.exec(fr);
    if (m) y.set(Number(m[1]), v);
  }
  for (const [year, yv] of y) {
    if (!q.has(`${year}-4`) && [1, 2, 3].every((i) => q.has(`${year}-${i}`))) {
      const q4 = yv.val - [1, 2, 3].reduce((a, i) => a + q.get(`${year}-${i}`).val, 0);
      q.set(`${year}-4`, { val: q4, end: yv.end, form: yv.form, filed: yv.filed, derived: true });
    }
  }
  const keys = [...q.keys()].sort().slice(-quarters);
  return {
    tag,
    points: keys.map((k) => { const [yr, qq] = k.split("-"); const v = q.get(k); return { frame: `CY${yr}Q${qq}`, label: `Q${qq} ${yr}`, periodEnd: v.end, value: v.val, form: v.form, filed: v.filed, derived: !!v.derived }; }),
  };
}

function financials(facts: any) {
  const revenue = quarterlySeries(facts, REVENUE_TAGS);
  const netIncome = quarterlySeries(facts, NET_INCOME_TAGS);
  const eps = quarterlySeries(facts, EPS_TAGS, ["USD/shares"]);
  const dividends = quarterlySeries(facts, DIVIDEND_TAGS, ["USD/shares"], 4);
  const sh = facts?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares as any[] | undefined;
  const best = sh?.length ? sh.reduce((a, b) => ((b.end ?? "") + (b.filed ?? "") > (a.end ?? "") + (a.filed ?? "") ? b : a)) : null;
  const sharesOutstanding = best ? { tag: "EntityCommonStockSharesOutstanding", value: best.val, asOf: best.end, filed: best.filed, form: best.form } : null;
  const latestEnd = revenue.points.at(-1)?.periodEnd;
  const recent = (s: { points: any[] }) => {
    if (s.points.length < 4 || !latestEnd) return false;
    const gap = (Date.parse(latestEnd) - Date.parse(s.points.at(-1).periodEnd)) / 864e5;
    return Number.isFinite(gap) && gap <= 100;
  };
  const sum4 = (s: { points: any[] }) => s.points.slice(-4).reduce((a, p) => a + p.value, 0);
  return {
    revenue, netIncome, eps, dividends, sharesOutstanding,
    ttmEps: recent(eps) ? sum4(eps) : null,
    ttmDividend: recent(dividends) ? sum4(dividends) : null,
    source: "SEC XBRL company facts API",
  };
}

// ---------- quotes (prototype source; swap for a licensed feed in production) ----------
async function getQuote(ticker: string) {
  const base: Record<string, unknown> = { ticker, name: null, price: null, previousClose: null, change: null, changePct: null, dayLow: null, dayHigh: null, week52Low: null, week52High: null, volume: null, exchange: null, currency: "USD", asOf: null, source: "unavailable", stale: false };
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0 (AdvisorBrief prototype)" } });
    if (!r.ok) throw new Error(`chart ${r.status}`);
    const m = (await r.json()).chart.result[0].meta;
    Object.assign(base, {
      name: m.longName ?? m.shortName ?? null, price: m.regularMarketPrice ?? null, previousClose: m.chartPreviousClose ?? null,
      dayLow: m.regularMarketDayLow ?? null, dayHigh: m.regularMarketDayHigh ?? null, week52Low: m.fiftyTwoWeekLow ?? null, week52High: m.fiftyTwoWeekHigh ?? null,
      volume: m.regularMarketVolume ?? null, exchange: m.exchangeName ?? null, currency: m.currency ?? "USD",
      asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null, source: "Yahoo Finance (chart endpoint)",
    });
    if (base.price != null && base.previousClose) {
      base.change = Number(((base.price as number) - (base.previousClose as number)).toFixed(4));
      base.changePct = Number((100 * (base.change as number) / (base.previousClose as number)).toFixed(3));
    }
  } catch (e) {
    base.errors = [String(e)];
  }
  return base;
}

function derived(quote: any, fin: any) {
  const out: Record<string, unknown> = {};
  const price = quote.price, shares = fin.sharesOutstanding?.value;
  if (price && shares) { out.marketCap = price * shares; out.marketCapBasis = `price x ${shares.toLocaleString()} shares (dei:EntityCommonStockSharesOutstanding as of ${fin.sharesOutstanding.asOf})`; }
  if (price && fin.ttmEps) { out.trailingPE = fin.ttmEps > 0 ? price / fin.ttmEps : null; out.ttmEps = fin.ttmEps; }
  if (price && fin.ttmDividend != null) { out.dividendYield = fin.ttmDividend / price; out.ttmDividend = fin.ttmDividend; }
  return out;
}

// ---------- extraction ----------
const EIGHT_K_ITEMS: Record<string, string> = { "1.01": "Entry into a material agreement", "1.02": "Termination of a material agreement", "1.05": "Material cybersecurity incident", "2.01": "Completion of acquisition or disposition", "2.02": "Results of operations (earnings release)", "2.03": "Creation of a direct financial obligation", "2.05": "Costs associated with exit or disposal", "2.06": "Material impairment", "3.01": "Delisting or failure to satisfy listing rule", "3.02": "Unregistered sale of equity", "4.01": "Change in auditor", "4.02": "Non reliance on prior financials", "5.01": "Change in control", "5.02": "Officer or director change, compensation", "5.03": "Amendment to articles or bylaws", "5.07": "Shareholder vote results", "7.01": "Regulation FD disclosure", "8.01": "Other events", "9.01": "Financial statements and exhibits" };
const ITEM_TITLES: Record<string, string> = { "Item 1": "Business", "Item 1A": "Risk Factors", "Item 7": "Management's Discussion and Analysis", "Item 2": "Management's Discussion and Analysis (10-Q)" };

type Section = { id: string; form: string; filingDate: string; item: string; title: string; text: string; url: string; chars: number; truncated: boolean; meta: Record<string, unknown> };

function htmlToText(html: string): string {
  let t = html.replace(/<ix:header[\s\S]*?<\/ix:header>/gi, "").replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "");
  t = t.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h[1-6]|table|td|th|span)>/gi, "\n").replace(/<[^>]+>/g, "");
  t = t.replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#8217;|&rsquo;/g, "’").replace(/&#8220;|&ldquo;/g, "“").replace(/&#8221;|&rdquo;/g, "”").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  return t.replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function itemPositions(text: string): Array<[string, number, string]> {
  const out: Array<[string, number, string]> = [];
  const re = /^\s*item[\s  ]*(\d{1,2}[a-c]?)\s*[.:\-–—]?\s*(.*)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const tail = m[2].trim();
    if (/^(of|in|to|and|through)\b/i.test(tail)) continue;
    out.push([`Item ${m[1].toUpperCase()}`, m.index, tail]);
  }
  return out;
}

function extractItem(text: string, item: string, prefer?: string): string | null {
  const pos = itemPositions(text);
  let best: string | null = null;
  pos.forEach(([name, start, tail], i) => {
    if (name !== item) return;
    if (prefer && !tail.toLowerCase().includes(prefer.toLowerCase())) return;
    const end = i + 1 < pos.length ? pos[i + 1][1] : text.length;
    const body = text.slice(start, end);
    if (best === null || body.length > best.length) best = body;
  });
  return best && (best as string).trim().length > 400 ? (best as string).trim() : null;
}

function budget(text: string, key: string): [string, boolean] {
  const limit = SECTION_CHAR_BUDGET[key] ?? 20000;
  return text.length <= limit ? [text, false] : [text.slice(0, limit) + "\n[... section truncated for the prototype token budget ...]", true];
}

function section(form: string, f: Filing, item: string, title: string, body: string, key: string, meta: Record<string, unknown> = {}): Section {
  const [text, truncated] = budget(body, key);
  return { id: `${form}|${f.filingDate}|${item}`, form, filingDate: f.filingDate, item, title, text, url: f.url, chars: text.length, truncated, meta };
}

function sections10k(html: string, f: Filing): Section[] {
  const text = htmlToText(html);
  const out: Section[] = [];
  for (const item of ["Item 1", "Item 1A", "Item 7"]) { const b = extractItem(text, item); if (b) out.push(section("10-K", f, item, ITEM_TITLES[item], b, item, { reportDate: f.reportDate })); }
  if (!out.length) out.push(section("10-K", f, "Document", "Annual report (unsectioned)", text, "Item 7"));
  return out;
}
function sections10q(html: string, f: Filing): Section[] {
  const text = htmlToText(html);
  const out: Section[] = [];
  const mdna = extractItem(text, "Item 2", "Management") ?? extractItem(text, "Item 2");
  if (mdna) out.push(section("10-Q", f, "Item 2", ITEM_TITLES["Item 2"], mdna, "Item 2", { reportDate: f.reportDate }));
  const ra = extractItem(text, "Item 1A");
  if (ra) out.push(section("10-Q", f, "Item 1A", "Risk Factors (quarterly update)", ra, "Item 1A"));
  if (!out.length) out.push(section("10-Q", f, "Document", "Quarterly report (unsectioned)", text, "Item 2"));
  return out;
}
function section8k(html: string, f: Filing): Section {
  let text = htmlToText(html);
  const pos = itemPositions(text);
  if (pos.length) text = text.slice(pos[0][1]);
  const codes = (f.items ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const labels = codes.map((c) => `${c} ${EIGHT_K_ITEMS[c] ?? ""}`.trim());
  return section("8-K", f, "Items " + codes.join(","), labels.join("; ") || "Current report", text, "8-K", { itemCodes: codes, itemLabels: labels });
}

// ---------- Intelligence layer: Lovable AI gateway, one streamed call, no vendor API key ----------
// Intelligence layer (SYSTEM, BLOCKS, BLOCK_ORDER, buildContext, validateCitations, Usage, streamBriefing,
// regenerateBlock). No vendor API key: the Lovable AI gateway is called with LOVABLE_API_KEY.
//
// Design:
// - One request carries the filing context once and asks for all six blocks as NDJSON: one JSON object per line,
//   each a complete block. The response is streamed, so each block is validated and sent to the browser the
//   moment its line closes. One call instead of six cuts input tokens by roughly 6x and needs no prompt cache.
// - Any block that is missing or malformed after the stream ends is regenerated with a small targeted call.
// - Citations are validated against the section ids that were sent. Anything else is dropped and counted.
// - Model is configurable (AI_MODEL). Default is Gemini 2.5 Pro for reasoning quality over long filings;
//   google/gemini-2.5-flash is the fast, cheap option for a live room.

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const AI_MODEL_DEFAULT = "google/gemini-2.5-pro";

const SYSTEM = `You are a senior equity research associate preparing a private briefing for a wealth management advisor who has a client call in ten minutes.

Rules you never break:
1. Use only the filing sections provided between <sections> tags. No outside knowledge about the company, its stock price, or events after the filings.
2. Every claim carries citations: the exact section ids given in the id attribute. Never invent an id.
3. Do not state a financial figure unless it appears in the sections. Quote figures as the filing states them, with the period.
4. Plain, direct American English. No hedging filler. No investment advice, no buy or sell language, no price targets.
5. Output format is NDJSON: exactly one JSON object per line, one line per block, in the order requested, nothing else. No markdown fences, no commentary, no blank lines between objects.`;

const BLOCKS: Record<string, { title: string; spec: string }> = {
  summary: {
    title: "60 second summary",
    spec: `The 60 second summary an advisor reads before the call. Four to five sentences across two or three paragraphs: what the company does, how it makes money, how the most recent quarter went in the filing's own terms, and the one thing management says it is focused on.
Shape: {"block":"summary","paragraphs":[{"text":"...","citations":["<section id>"]}]}`,
  },
  what_changed: {
    title: "What changed since last quarter",
    spec: `From the most recent 10-Q MD&A (and the 10-K for comparison), the four to six most important changes an advisor should know: growth drivers, margin moves, guidance or outlook language, capital return, balance sheet, segment shifts. Each item one or two sentences with the specific figures the filing gives.
Shape: {"block":"what_changed","items":[{"text":"...","citations":["<section id>"]}]}`,
  },
  risks: {
    title: "Top risks",
    spec: `From the risk factor sections, the four or five risks that matter most to a long term shareholder right now, ranked. Prefer risks specific to this company over generic boilerplate. Title of five words or fewer, then two sentences in plain English on why it matters.
Shape: {"block":"risks","items":[{"title":"...","severity":"high|medium|low","text":"...","citations":["<section id>"]}]}`,
  },
  events: {
    title: "Recent 8-K events",
    spec: `For every 8-K section provided, one timeline entry: filing date, a headline of ten words or fewer, and one or two sentences on why an advisor would care. If an 8-K is routine (earnings release notice, exhibit only), say so in one short sentence. Newest first. If there are no 8-K sections, items is an empty list.
Shape: {"block":"events","items":[{"date":"YYYY-MM-DD","headline":"...","why_it_matters":"...","citations":["<section id>"]}]}`,
  },
  talking_points: {
    title: "Talking points for the client conversation",
    spec: `Five talking points an advisor can say out loud to a client today. Each one sentence, conversational, specific, grounded in the filings, no jargon. Cover the business, the latest quarter, a risk to acknowledge, capital return or balance sheet, and what to watch next quarter.
Shape: {"block":"talking_points","items":[{"text":"...","citations":["<section id>"]}]}`,
  },
  questions: {
    title: "Questions the client may ask",
    spec: `Four questions a sharp client is likely to ask, each with a two sentence answer the advisor can give from the filings. Include at least one uncomfortable question.
Shape: {"block":"questions","items":[{"question":"...","answer":"...","citations":["<section id>"]}]}`,
  },
};
const BLOCK_ORDER = ["summary", "what_changed", "risks", "events", "talking_points", "questions"];

function buildContext(sections: Section[], company: Company): string {
  const parts = [`<company name="${company.name}" ticker="${company.ticker}" fiscalYearEnd="${company["fiscalYearEnd"] ?? ""}" />`, "<sections>"];
  for (const s of sections) parts.push(`<section id="${s.id}" form="${s.form}" filed="${s.filingDate}" title="${s.title}">\n${s.text}\n</section>`);
  parts.push("</sections>");
  return parts.join("\n");
}

function briefingRequest(names: string[]): string {
  const specs = names.map((n, i) => `${i + 1}. ${n}\n${BLOCKS[n]!.spec}`).join("\n\n");
  return `Write these ${names.length} briefing blocks, one JSON object per line, in this order:\n\n${specs}\n\nSection ids you may cite are exactly the id attributes in <sections>. Begin with the first line now.`;
}

function validateCitations(block: any, valid: Set<string>): [any, number] {
  let dropped = 0;
  for (const key of ["paragraphs", "items"])
    for (const item of block?.[key] ?? []) {
      const c: string[] = Array.isArray(item.citations) ? item.citations : [];
      const kept = c.filter((x) => valid.has(x));
      dropped += c.length - kept.length;
      item.citations = kept;
    }
  return [block, dropped];
}

function tryParseBlock(line: string): any | null {
  const t = line.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").replace(/^[\-\*\d\.\)\s]+(?=\{)/, "");
  if (!t.startsWith("{")) return null;
  try {
    const obj = JSON.parse(t);
    return obj && typeof obj.block === "string" && BLOCKS[obj.block] ? obj : null;
  } catch {
    return null;
  }
}

class Usage {
  calls = 0;
  input = 0;
  output = 0;
  model = "";
  add(u: any) {
    this.calls++;
    this.input += u?.prompt_tokens ?? 0;
    this.output += u?.completion_tokens ?? 0;
  }
  toDict() {
    return { calls: this.calls, inputTokens: this.input, outputTokens: this.output, cacheWriteTokens: 0, cacheReadTokens: 0, model: this.model, mode: "live" };
  }
}

async function aiFetch(body: Record<string, unknown>): Promise<Response> {
  const key = process.env["LOVABLE_API_KEY"] ?? "";
  if (!key) throw new Error("LOVABLE_API_KEY is not available. Enable Lovable AI for this project.");
  const r = await fetch(AI_GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (r.status === 429) throw new Error("AI gateway rate limit reached. Try again in a moment.");
  if (r.status === 402) throw new Error("AI gateway credits exhausted for this workspace.");
  if (!r.ok) throw new Error(`AI gateway ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}

/** Streams all blocks in one call. Calls onBlock as each validated block line closes. Returns the set of block names delivered. */
async function streamBriefing(
  context: string,
  valid: Set<string>,
  usage: Usage,
  model: string,
  onBlock: (name: string, data: any) => void,
): Promise<Set<string>> {
  const delivered = new Set<string>();
  const r = await aiFetch({
    model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `${context}\n\n${briefingRequest(BLOCK_ORDER)}` },
    ],
  });
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let sseBuf = "";
  let textBuf = "";
  const consumeLines = (final = false) => {
    let idx;
    while ((idx = textBuf.indexOf("\n")) >= 0) {
      const line = textBuf.slice(0, idx);
      textBuf = textBuf.slice(idx + 1);
      const obj = tryParseBlock(line);
      if (obj && !delivered.has(obj.block)) {
        const [block, dropped] = validateCitations(obj, valid);
        block.droppedCitations = dropped;
        delivered.add(obj.block);
        onBlock(obj.block, block);
      }
    }
    if (final && textBuf.trim()) {
      const obj = tryParseBlock(textBuf);
      textBuf = "";
      if (obj && !delivered.has(obj.block)) {
        const [block, dropped] = validateCitations(obj, valid);
        block.droppedCitations = dropped;
        delivered.add(obj.block);
        onBlock(obj.block, block);
      }
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    sseBuf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = sseBuf.indexOf("\n")) >= 0) {
      let raw = sseBuf.slice(0, nl);
      sseBuf = sseBuf.slice(nl + 1);
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      if (!raw.startsWith("data: ")) continue;
      const payload = raw.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.usage) usage.add(evt.usage);
        const delta = evt.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          textBuf += delta;
          consumeLines();
        }
      } catch {
        /* partial frame; wait for more */
      }
    }
  }
  consumeLines(true);
  return delivered;
}

/** Targeted regeneration for any block the stream did not deliver. */
async function regenerateBlock(context: string, name: string, valid: Set<string>, usage: Usage, model: string): Promise<any> {
  const r = await aiFetch({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `${context}\n\n${briefingRequest([name])}` },
    ],
  });
  const resp = await r.json();
  usage.add(resp.usage);
  const text: string = resp.choices?.[0]?.message?.content ?? "";
  for (const line of text.split("\n")) {
    const obj = tryParseBlock(line);
    if (obj && obj.block === name) {
      const [block, dropped] = validateCitations(obj, valid);
      block.droppedCitations = dropped;
      return block;
    }
  }
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const [block, dropped] = validateCitations(JSON.parse(m[0]), valid);
      block.droppedCitations = dropped;
      return block;
    } catch {
      /* fall through */
    }
  }
  return { items: [], error: `The model did not return a valid ${name} block.` };
}


// ---------- handler ----------
async function handleBrief(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  CFG = readEnv();
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return new Response(JSON.stringify({ error: "q is required" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const t0 = Date.now();
      try {
        const company = await resolve(q);
        send("resolved", company);
        const [sub, quote, factsRes] = await Promise.all([
          submissions(company.cik),
          getQuote(company.ticker),
          companyFacts(company.cik).catch((e) => ({ error: String(e) })),
        ]);
        const sel = selectFilings(sub, company.cik);
        Object.assign(company, Object.fromEntries(Object.entries(sel.company).filter(([k]) => k !== "name")));
        send("filings", { "10-K": sel["10-K"], "10-Q": sel["10-Q"], "8-K": sel["8-K"], company: sel.company });
        const fin = (factsRes as any).error
          ? { revenue: { points: [] }, netIncome: { points: [] }, eps: { points: [] }, dividends: { points: [] }, error: (factsRes as any).error }
          : financials(factsRes);
        (quote as any).derived = derived(quote, fin);
        send("quote", quote);
        send("financials", fin);

        const jobs: Array<[string, Filing]> = [];
        if (sel["10-K"]) jobs.push(["10-K", sel["10-K"]]);
        if (sel["10-Q"]) jobs.push(["10-Q", sel["10-Q"]]);
        for (const f of sel["8-K"]) jobs.push(["8-K", f]);
        const htmls = await Promise.allSettled(jobs.map(([, f]) => document_(f)));
        const sections: Section[] = [];
        htmls.forEach((h, i) => {
          if (h.status !== "fulfilled") return;
          const [form, f] = jobs[i]!;
          try {
            if (form === "10-K") sections.push(...sections10k(h.value, f));
            else if (form === "10-Q") sections.push(...sections10q(h.value, f));
            else sections.push(section8k(h.value, f));
          } catch {
            /* skip a filing that will not parse */
          }
        });
        send("sections", { sections: sections.map(({ text: _t, ...rest }) => rest), dataLatencyMs: Date.now() - t0 });

        const model = CFG.AI_MODEL;
        send("status", { message: `Reading filings with ${model.split("/").pop()}` });
        const context = buildContext(sections, company);
        const valid = new Set(sections.map((s) => s.id));
        const usage = new Usage();
        usage.model = model;
        const started = Date.now();
        const delivered = await streamBriefing(context, valid, usage, model, (name, data) =>
          send("block", { name, title: BLOCKS[name]!.title, data, elapsedMs: Date.now() - started }),
        );
        const missing = BLOCK_ORDER.filter((n) => !delivered.has(n));
        if (missing.length) send("status", { message: `Regenerating ${missing.length} block${missing.length > 1 ? "s" : ""}` });
        await Promise.all(
          missing.map(async (n) => {
            const data = await regenerateBlock(context, n, valid, usage, model).catch((e) => ({ items: [], error: String(e) }));
            send("block", { name: n, title: BLOCKS[n]!.title, data, elapsedMs: Date.now() - started });
          }),
        );
        send("usage", { data: { ...usage.toDict(), elapsedMs: Date.now() - started } });
        send("done", { totalMs: Date.now() - t0, disclaimer: DISCLAIMER });
      } catch (e) {
        send("error", { message: String((e as Error).message ?? e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}

export const Route = createFileRoute("/api/public/advisor-brief")({
  server: {
    handlers: {
      GET: async ({ request }) => handleBrief(request),
      OPTIONS: async () => new Response(null, { headers: CORS }),
    },
  },
});
