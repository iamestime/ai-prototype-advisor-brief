// Filing digest: what the advisor gets even when no model is available.
// Built from structured data only (EDGAR submissions feed, XBRL company facts, section extraction). No model, no
// inference, every line traceable to a filing or a data point. This is the safe failure state: the page never
// shows an empty briefing, and nothing here can be a hallucination.
import { EIGHT_K_ITEMS, type Section } from "./edgar";

export function buildDigest(sel: any, fin: any, sections: Section[]) {
  const fmt = (v: number | null | undefined) => (v == null ? "n/a" : (v < 0 ? "-$" : "$") + (Math.abs(v) >= 1e9 ? (Math.abs(v) / 1e9).toFixed(1) + "B" : (Math.abs(v) / 1e6).toFixed(0) + "M"));
  const rev = fin?.revenue?.points ?? [], ni = fin?.netIncome?.points ?? [];
  const facts: Array<{ text: string; source: string }> = [];
  if (rev.length) {
    const last = rev[rev.length - 1], prev = rev.length > 1 ? rev[rev.length - 2] : null, yago = rev.length > 4 ? rev[rev.length - 5] : null;
    facts.push({ text: `Revenue ${fmt(last.value)} for ${last.label} (period end ${last.periodEnd})${prev ? `, ${last.value >= prev.value ? "up" : "down"} ${Math.abs(((last.value / prev.value) - 1) * 100).toFixed(0)}% from ${prev.label}` : ""}${yago ? ` and ${last.value >= yago.value ? "up" : "down"} ${Math.abs(((last.value / yago.value) - 1) * 100).toFixed(0)}% from ${yago.label}` : ""}.`, source: `SEC XBRL company facts, us-gaap:${fin.revenue.tag}, ${last.form} filed ${last.filed}` });
    const n = ni.find((p: any) => p.frame === last.frame);
    if (n) facts.push({ text: `Net income ${fmt(n.value)} for ${last.label}, a ${((n.value / last.value) * 100).toFixed(1)}% net margin.`, source: `SEC XBRL company facts, us-gaap:${fin.netIncome.tag}, ${n.form} filed ${n.filed}` });
  }
  if (fin?.sharesOutstanding) facts.push({ text: `${Number(fin.sharesOutstanding.value).toLocaleString()} shares outstanding as of ${fin.sharesOutstanding.asOf}.`, source: `SEC XBRL, dei:EntityCommonStockSharesOutstanding, ${fin.sharesOutstanding.form} filed ${fin.sharesOutstanding.filed}` });
  const events = (sel["8-K"] ?? []).map((f: any) => {
    const codes = String(f.items ?? "").split(",").map((c: string) => c.trim()).filter(Boolean);
    return { date: f.filingDate, items: codes, labels: codes.map((c: string) => EIGHT_K_ITEMS[c] ?? `Item ${c}`), url: f.url, accession: f.accession };
  });
  const filings = ["10-K", "10-Q"].filter((k) => sel[k]).map((k) => ({ form: k, filingDate: sel[k].filingDate, reportDate: sel[k].reportDate, accession: sel[k].accession, url: sel[k].url }));
  return {
    generatedAt: new Date().toISOString(),
    facts,
    events,
    filings,
    sectionsRead: sections.map((x) => ({ id: x.id, title: x.title, chars: x.chars, truncated: x.truncated, url: x.url, fetchedAt: x.fetchedAt })),
  };
}
