// SEC EDGAR data layer: registrant lookup, submissions, filing documents, XBRL company facts, quote adapter,
// and section extraction (10-K Items 1, 1A, 7; 10-Q Item 2 MD&A and Item 1A; 8-K bodies).
// Every section carries the accession number, the sec.gov URL, and the time it was fetched.
import type { Cfg } from "./config";

let EDGAR_UA = "AdvisorBrief prototype contact@example.com";
export function configureEdgar(cfg: Cfg) {
  EDGAR_UA = cfg.EDGAR_UA;
}

const SECTION_CHAR_BUDGET: Record<string, number> = { "Item 1": 18000, "Item 1A": 30000, "Item 7": 45000, "Item 2": 45000, "8-K": 6000 };

// ---------- small in-memory cache (per warm instance) ----------
const memo = new Map<string, { at: number; value: unknown }>();
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

// ---------- EDGAR ----------
let lastEdgar = 0;
export async function edgarGet(url: string, asJson = true): Promise<any> {
  const wait = 120 - (Date.now() - lastEdgar); // under 10 requests per second
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastEdgar = Date.now();
  const r = await fetch(url, { headers: { "User-Agent": EDGAR_UA, "Accept-Encoding": "gzip, deflate" } });
  if (!r.ok) throw new Error(`EDGAR ${r.status} for ${url}`);
  return asJson ? r.json() : r.text();
}

export type Company = { cik: number; ticker: string; name: string; [k: string]: unknown };
export async function resolve(query: string): Promise<Company> {
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
  if (hits.length) return { cik: Number(hits[0]!.cik_str), ticker: hits[0]!.ticker, name: hits[0]!.title };
  throw new Error(`No SEC registrant matches '${query}'`);
}

export async function submissions(cik: number): Promise<any> {
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

export type Filing = { form: string; filingDate: string; reportDate: string; accession: string; primaryDocument: string; items: string; url: string; indexUrl: string };
export function selectFilings(sub: any, cik: number, days8k = 90) {
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

export const document_ = (f: Filing) => cached(`doc_${f.accession}`, 6 * 3600e3, () => edgarGet(f.url, false) as Promise<string>);
export const companyFacts = (cik: number) => cached(`facts_${cik}`, 3600e3, () => edgarGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`));

// ---------- XBRL financials ----------
const REVENUE_TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax", "InterestAndDividendIncomeOperating", "TotalRevenuesAndOtherIncome"];
const NET_INCOME_TAGS = ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"];
const EPS_TAGS = ["EarningsPerShareDiluted", "EarningsPerShareBasic"];
const DIVIDEND_TAGS = ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"];

type Pt = { start: string; end: string; val: number; form: string; filed: string; days: number };
const DAY = 864e5;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/**
 * Fiscal quarters from XBRL facts. Quarterly values are facts with a duration of one quarter (Q4 is derived as the
 * fiscal year minus the three reported quarters). Periods are keyed by end date and the latest filed value wins
 * (restatements). Labels follow SEC convention: FY2026 is the fiscal year that ends in calendar 2026.
 * Among the candidate tags, the one with the most recent quarter wins, so a company that switched tags is not
 * shown with stale data.
 */
function quarterlySeries(facts: any, tags: string[], units = ["USD"], quarters = 8) {
  const gaap = facts?.facts?.["us-gaap"] ?? {};
  let best: { tag: string; points: any[] } | null = null;
  for (const t of tags) for (const u of units) {
    const vals: any[] = gaap[t]?.units?.[u] ?? [];
    if (!vals.length) continue;
    const q = new Map<string, Pt>(), fy = new Map<string, Pt>();
    for (const v of vals) {
      if (!v.start || !v.end || typeof v.val !== "number") continue;
      const days = daysBetween(v.start, v.end);
      const pt: Pt = { start: v.start, end: v.end, val: v.val, form: v.form, filed: v.filed, days };
      const bucket = days >= 80 && days <= 100 ? q : days >= 350 && days <= 380 ? fy : null;
      if (!bucket) continue;
      const prev = bucket.get(v.end);
      if (!prev || (v.filed ?? "") > (prev.filed ?? "")) bucket.set(v.end, pt);
    }
    // derive the fourth quarter of every fiscal year that has the other three reported
    const fyEndsAll = [...fy.keys()].sort();
    const prevFy = (fyEnd: string) => fyEndsAll.filter((x) => x < fyEnd && daysBetween(x, fyEnd) < 400).pop() ?? new Date(Date.parse(fyEnd) - 366 * DAY).toISOString().slice(0, 10);
    for (const [fyEnd, a] of fy) {
      if (q.has(fyEnd)) continue;
      const lo = prevFy(fyEnd);
      const inYear = [...q.values()].filter((p) => p.end > lo && p.end < fyEnd);
      if (inYear.length === 3) q.set(fyEnd, { start: inYear.sort((x, y) => x.end.localeCompare(y.end))[2]!.end, end: fyEnd, val: a.val - inYear.reduce((s, p) => s + p.val, 0), form: a.form, filed: a.filed, days: 91, ...( { derived: true } as any) });
    }
    const ends = [...q.keys()].sort();
    if (ends.length < 2) continue;
    const fyEnds = [...fy.keys()].sort();
    const points = ends.slice(-quarters).map((e) => {
      const p = q.get(e)! as Pt & { derived?: boolean };
      // fiscal year: first FY end on or after this quarter end; otherwise extrapolate one year past the last FY end
      let fyEnd = fyEnds.find((x) => x >= e);
      if (!fyEnd && fyEnds.length) { const last = fyEnds[fyEnds.length - 1]!; const d = new Date(Date.parse(last)); while (d.toISOString().slice(0, 10) < e) d.setFullYear(d.getFullYear() + 1); fyEnd = d.toISOString().slice(0, 10); }
      const fyLabel = fyEnd ? fyEnd.slice(0, 4) : e.slice(0, 4);
      const lo = fyEnd ? prevFy(fyEnd) : "";
      const inYear = fyEnd ? ends.filter((x) => x <= e && x > lo) : [];
      const qn = fyEnd ? Math.min(4, Math.max(1, inYear.length)) : Math.ceil((new Date(Date.parse(e)).getUTCMonth() + 1) / 3);
      return { frame: `FY${fyLabel}Q${qn}`, label: `Q${qn} FY${fyLabel.slice(2)}`, periodEnd: e, value: p.val, form: p.form, filed: p.filed, derived: !!p.derived };
    });
    const cand = { tag: t, points };
    const newest = points[points.length - 1]!.periodEnd;
    const bestNewest = best ? best.points[best.points.length - 1]!.periodEnd : "";
    if (!best || newest > bestNewest || (newest === bestNewest && points.length > best.points.length)) best = cand;
  }
  return best ?? { tag: null, points: [] as any[] };
}

export function financials(facts: any) {
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
export async function getQuote(ticker: string) {
  const base: Record<string, any> = { ticker, name: null, price: null, previousClose: null, change: null, changePct: null, dayLow: null, dayHigh: null, week52Low: null, week52High: null, volume: null, exchange: null, currency: "USD", asOf: null, source: "unavailable", stale: false };
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
    if (base["price"] != null && base["previousClose"]) {
      base["change"] = Number(((base["price"] as number) - (base["previousClose"] as number)).toFixed(4));
      base["changePct"] = Number((100 * (base["change"] as number) / (base["previousClose"] as number)).toFixed(3));
    }
  } catch (e) {
    base["errors"] = [String(e)];
  }
  return base;
}

export function derived(quote: any, fin: any) {
  const out: { marketCap?: number; marketCapBasis?: string; trailingPE?: number | null; ttmEps?: number; dividendYield?: number; ttmDividend?: number } = {};
  const price = quote.price, shares = fin.sharesOutstanding?.value;
  if (price && shares) { out.marketCap = price * shares; out.marketCapBasis = `price x ${shares.toLocaleString()} shares (dei:EntityCommonStockSharesOutstanding as of ${fin.sharesOutstanding.asOf})`; }
  if (price && fin.ttmEps) { out.trailingPE = fin.ttmEps > 0 ? price / fin.ttmEps : null; out.ttmEps = fin.ttmEps; }
  if (price && fin.ttmDividend != null) { out.dividendYield = fin.ttmDividend / price; out.ttmDividend = fin.ttmDividend; }
  return out;
}

// ---------- extraction ----------
export const EIGHT_K_ITEMS: Record<string, string> = { "1.01": "Entry into a material agreement", "1.02": "Termination of a material agreement", "1.05": "Material cybersecurity incident", "2.01": "Completion of acquisition or disposition", "2.02": "Results of operations (earnings release)", "2.03": "Creation of a direct financial obligation", "2.05": "Costs associated with exit or disposal", "2.06": "Material impairment", "3.01": "Delisting or failure to satisfy listing rule", "3.02": "Unregistered sale of equity", "4.01": "Change in auditor", "4.02": "Non reliance on prior financials", "5.01": "Change in control", "5.02": "Officer or director change, compensation", "5.03": "Amendment to articles or bylaws", "5.07": "Shareholder vote results", "7.01": "Regulation FD disclosure", "8.01": "Other events", "9.01": "Financial statements and exhibits" };
export const ITEM_TITLES: Record<string, string> = { "Item 1": "Business", "Item 1A": "Risk Factors", "Item 7": "Management's Discussion and Analysis", "Item 2": "Management's Discussion and Analysis (10-Q)" };

export type Section = { id: string; form: string; filingDate: string; item: string; title: string; text: string; url: string; chars: number; truncated: boolean; accession: string; fetchedAt: string; meta: Record<string, unknown> };

export function htmlToText(html: string): string {
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
    const tail = (m[2] ?? "").trim();
    if (/^(of|in|to|and|through)\b/i.test(tail)) continue;
    out.push([`Item ${(m[1] ?? "").toUpperCase()}`, m.index, tail]);
  }
  return out;
}

function extractItem(text: string, item: string, prefer?: string): string | null {
  const pos = itemPositions(text);
  let best: string | null = null;
  pos.forEach(([name, start, tail], i) => {
    if (name !== item) return;
    if (prefer && !tail.toLowerCase().includes(prefer.toLowerCase())) return;
    const end = i + 1 < pos.length ? pos[i + 1]![1] : text.length;
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
  return { id: `${form}|${f.filingDate}|${item}`, form, filingDate: f.filingDate, item, title, text, url: f.url, chars: text.length, truncated, accession: f.accession, fetchedAt: new Date().toISOString(), meta };
}

export function sections10k(html: string, f: Filing): Section[] {
  const text = htmlToText(html);
  const out: Section[] = [];
  for (const item of ["Item 1", "Item 1A", "Item 7"]) { const b = extractItem(text, item); if (b) out.push(section("10-K", f, item, ITEM_TITLES[item] ?? item, b, item, { reportDate: f.reportDate })); }
  if (!out.length) out.push(section("10-K", f, "Document", "Annual report (unsectioned)", text, "Item 7"));
  return out;
}
export function sections10q(html: string, f: Filing): Section[] {
  const text = htmlToText(html);
  const out: Section[] = [];
  const mdna = extractItem(text, "Item 2", "Management") ?? extractItem(text, "Item 2");
  if (mdna) out.push(section("10-Q", f, "Item 2", ITEM_TITLES["Item 2"]!, mdna, "Item 2", { reportDate: f.reportDate }));
  const ra = extractItem(text, "Item 1A");
  if (ra) out.push(section("10-Q", f, "Item 1A", "Risk Factors (quarterly update)", ra, "Item 1A"));
  if (!out.length) out.push(section("10-Q", f, "Document", "Quarterly report (unsectioned)", text, "Item 2"));
  return out;
}
export function section8k(html: string, f: Filing): Section {
  let text = htmlToText(html);
  const pos = itemPositions(text);
  if (pos.length) text = text.slice(pos[0]![1]);
  const codes = (f.items ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const labels = codes.map((c) => `${c} ${EIGHT_K_ITEMS[c] ?? ""}`.trim());
  return section("8-K", f, "Items " + codes.join(","), labels.join("; ") || "Current report", text, "8-K", { itemCodes: codes, itemLabels: labels });
}
