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

function cited(text: string, sectionId: string) {
  return { text, citations: sectionId ? [sectionId] : [] };
}

function filingSentences(section: Section | undefined, limit: number): string[] {
  if (!section) return [];
  return section.text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence.length >= 70 &&
        sentence.length <= 320 &&
        /\b(?:risk|could|may|depend|constraint|competition|regulatory|supply)\b/i.test(sentence),
    )
    .slice(0, limit);
}

/**
 * Provider-independent narrative used only when Gemini cannot serve the request. Every sentence is
 * either composed from structured XBRL/submissions data or copied from a fetched filing section.
 */
export function buildDeterministicBrief(company: any, digest: any, sections: Section[]) {
  const quarter =
    sections.find((section) => section.form === "10-Q" && /Item 2/i.test(section.item)) ??
    sections.find((section) => section.form === "10-K" && /Item 7/i.test(section.item)) ??
    sections[0];
  const business =
    sections.find((section) => section.form === "10-K" && /Item 1(?!A)/i.test(section.item)) ??
    quarter;
  const risk =
    sections.find((section) => section.form === "10-K" && /Item 1A/i.test(section.item)) ??
    sections.find((section) => /risk/i.test(section.title));
  const facts = (digest.facts ?? []).map((fact: any) => cited(fact.text, quarter?.id ?? ""));
  const riskQuotes = filingSentences(risk, 4);
  const events = (digest.events ?? []).map((event: any) => {
    const section = sections.find(
      (candidate) => candidate.form === "8-K" && candidate.filingDate === event.date,
    );
    return {
      date: event.date,
      headline: (event.labels ?? []).slice(0, 2).join("; ") || "Recent SEC filing",
      why_it_matters: `The company filed Form 8-K covering ${(event.labels ?? []).join(", ") || "the listed event"}.`,
      citations: section ? [section.id] : [],
    };
  });
  const latest = facts[0]?.text ?? "The latest SEC filing set was retrieved successfully.";
  const income = facts[1]?.text;
  return {
    summary: {
      paragraphs: [
        cited(
          `${company.name} (${company.ticker}) is summarized here from its latest SEC filing set. ${latest}${income ? ` ${income}` : ""}`,
          quarter?.id ?? business?.id ?? "",
        ),
        cited(
          "This source-derived briefing remains available when the AI narrative service is temporarily capacity constrained; each point links to the filing section used.",
          business?.id ?? quarter?.id ?? "",
        ),
      ],
      sourceMode: "deterministic",
    },
    what_changed: { items: facts.slice(0, 5), sourceMode: "deterministic" },
    risks: {
      items: (riskQuotes.length
        ? riskQuotes
        : ["The filing's risk-factor section should be reviewed for company-specific uncertainties before relying on this briefing."]).map((text, index) => ({
        title: `Filed risk factor ${index + 1}`,
        severity: "medium",
        text,
        citations: risk ? [risk.id] : [],
      })),
      sourceMode: "deterministic",
    },
    events: { items: events, sourceMode: "deterministic" },
    talking_points: {
      items: [
        ...facts.slice(0, 3),
        ...riskQuotes.slice(0, 2).map((text) => cited(text, risk?.id ?? "")),
      ],
      sourceMode: "deterministic",
    },
    questions: {
      items: [
        {
          question: "What changed in the latest reported quarter?",
          answer: latest,
          citations: quarter ? [quarter.id] : [],
        },
        ...(income
          ? [{
              question: "What did the company report for profitability?",
              answer: income,
              citations: quarter ? [quarter.id] : [],
            }]
          : []),
        {
          question: "What risks should the client understand?",
          answer:
            riskQuotes[0] ??
            "The linked filing risk-factor section should be reviewed before relying on this briefing.",
          citations: risk ? [risk.id] : [],
        },
      ],
      sourceMode: "deterministic",
    },
  };
}
