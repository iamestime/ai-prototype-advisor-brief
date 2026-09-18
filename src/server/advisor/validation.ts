// Validation agent: independent, evidence scoped review of every generated claim.
//
// The research agent writes the briefing. This agent never sees the research prompt or the full filing
// context. For each block it receives only the claims and the exact filing sections those claims cite, and
// it is instructed to assume the claim may be wrong. Three checks combine into one verdict per claim:
//   1. Figure check (deterministic). Every number in the claim must appear in the cited text, allowing for
//      the unit shifts filings use (96,221 in a table headed "in millions" matches $96.2 billion).
//   2. Quote grounding (deterministic). The validator returns a verbatim quote; the server checks that the
//      quote really occurs in the cited text. A verdict without locatable evidence is downgraded.
//   3. Independent reading (model, temperature 0, adversarial system prompt).
// Policy: unsupported claims are excluded from the briefing view and kept in "Held for review" with the
// evidence link; partial and uncited claims stay visible and are flagged; a validator failure marks the
// block "unverified" and never removes content, and no confidence score is shown when the reading did not run.
import type { Cfg } from "./config";
import type { Section } from "./edgar";
import { chatText, logAiFailure } from "./providers";

export type Verdict = "supported" | "partial" | "unsupported" | "uncited" | "unverified";

export type CheckRow = { id: "source" | "citation" | "figures" | "authoritative" | "reading"; label: string; pass: boolean | null; detail: string };
export type SourceRef = { sectionId: string; form: string; item: string; filingDate: string; accession: string; url: string; fetchedAt: string; chars: number };
export type ClaimCheck = {
  index: number;
  verdict: Verdict;
  reason: string;
  quote: string;
  quoteFound: boolean;
  sectionId: string | null;
  url: string | null;
  figures: { checked: number; matched: number; unmatched: string[] };
  modelVerdict: string | null;
  checks: CheckRow[];
  sources: SourceRef[];
};

export type BlockValidation = {
  block: string;
  status: "verified" | "flagged" | "excluded" | "unverified";
  claims: ClaimCheck[];
  counts: Record<Verdict, number>;
  policy: { unsupported: "exclude" | "flag"; partial: "flag"; uncited: "flag"; unverified: "flag" | "hide" };
  elapsedMs: number;
  model: string;
  provider?: string;
  error?: string;
};

export const VALIDATOR_SYSTEM = `You are an independent fact checker for a wealth management compliance desk. You did not write the claims you are reviewing and you should assume any of them may be wrong.

For each claim you receive the exact SEC filing text the writer cited. Judge each claim ONLY against that text.

Verdicts:
- "supported": every fact and figure in the claim is stated in the evidence, in substance. Paraphrase is fine; invention is not.
- "partial": the main point is in the evidence but a figure, date, name, or qualifier is missing, imprecise, or overstated.
- "unsupported": the evidence does not say this, contradicts it, or the claim relies on information outside the evidence.

For every claim, return a verbatim quote of at most 40 words copied exactly from the evidence that best supports (or, for unsupported, most closely relates to) the claim. Do not paraphrase the quote. If nothing in the evidence relates to the claim, return an empty quote.

Output only JSON: {"claims":[{"i":<index>,"verdict":"supported|partial|unsupported","quote":"...","reason":"<one sentence>"}]}`;

// ---- claim extraction ----

export function claimText(block: string, item: any): string {
  if (block === "summary") return String(item.text ?? "");
  if (block === "events") return `${item.date ?? ""}: ${item.headline ?? ""}. ${item.why_it_matters ?? ""}`;
  if (block === "risks") return `${item.title ?? ""}. ${item.text ?? ""}`;
  if (block === "questions") return `${item.question ?? ""} ${item.answer ?? ""}`;
  return String(item.text ?? "");
}

export function claimItems(block: string, data: any): any[] {
  return (block === "summary" ? data?.paragraphs : data?.items) ?? [];
}

// ---- figure check ----

const UNIT_MULT: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, k: 1e3, m: 1e6, b: 1e9, bn: 1e9, mm: 1e6 };

/** Numbers stated in a claim, with the scale a reader would infer from the surrounding word. */
export function claimFigures(text: string): Array<{ raw: string; value: number; scale: number; percent: boolean }> {
  const out: Array<{ raw: string; value: number; scale: number; percent: boolean }> = [];
  const re = /(?<![\w.])\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%|percent|thousand|million|billion|trillion|bn|mm|k|m|b)?(?![\w])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0].trim();
    const numStr = (m[1] + (m[2] ?? "")).replace(/,/g, "");
    const value = Number(numStr);
    if (!Number.isFinite(value)) continue;
    const unit = (m[3] ?? "").toLowerCase();
    const percent = unit === "%" || unit === "percent";
    // Bare 1 to 4 digit integers without a unit are usually years, item numbers, or counts; still checked, but
    // years (1990 to 2039) and single digits are treated as low value and skipped to avoid noise.
    if (!unit && ((value >= 1990 && value <= 2039) || value < 10)) continue;
    out.push({ raw, value, scale: percent ? 1 : (UNIT_MULT[unit] ?? 1), percent });
  }
  return out;
}

/** Every numeric value in the evidence, expanded across the unit interpretations filings use. */
export function evidenceValues(text: string): number[] {
  const vals: number[] = [];
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = Number((m[1] + (m[2] ?? "")).replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    vals.push(v);
  }
  return vals;
}

/** Scale words in the evidence ("in millions") pin down how a table number should be read. */
export function evidenceScale(evidence: string): number[] {
  const m = /\(?\s*(?:amounts?\s+)?in\s+(thousands|millions|billions)\b/i.exec(evidence);
  if (!m) return [1, 1e3, 1e6, 1e9];
  const unit = m[1]!.toLowerCase();
  return [1, unit === "thousands" ? 1e3 : unit === "millions" ? 1e6 : 1e9];
}

export function figuresMatch(claimVal: number, claimScale: number, precisionDigits: number, ev: number[], mults: number[] = [1, 1e3, 1e6, 1e9]): boolean {
  const target = claimVal * claimScale;
  const tol = Math.pow(10, -precisionDigits) * 0.51 * claimScale; // half a unit in the claim's last digit
  for (const v of ev) {
    for (const k of mults) {
      const cand = v * k;
      if (Math.abs(cand - target) <= Math.max(tol, Math.abs(target) * 1e-9)) return true;
      // the claim rounded (96.2 billion vs 96,221 million): compare at the claim's precision
      const scaled = cand / claimScale;
      if (Math.abs(scaled - claimVal) < Math.pow(10, -precisionDigits) * 0.51 + 1e-9) return true;
    }
  }
  return false;
}

export function checkFigures(claim: string, evidence: string): { checked: number; matched: number; unmatched: string[] } {
  const figs = claimFigures(claim);
  if (!figs.length) return { checked: 0, matched: 0, unmatched: [] };
  const ev = evidenceValues(evidence);
  const mults = evidenceScale(evidence);
  const unmatched: string[] = [];
  let matched = 0;
  for (const f of figs) {
    const decimals = (String(f.value).split(".")[1] ?? "").length;
    // a percentage or a bare number is matched as written; a scaled figure uses the table's unit when stated
    if (figuresMatch(f.value, f.scale, decimals, ev, f.percent || f.scale === 1 ? [1, 1e3, 1e6, 1e9] : mults)) matched++;
    else unmatched.push(f.raw);
  }
  return { checked: figs.length, matched, unmatched };
}

// ---- quote grounding ----

export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Longest common subsequence length of two token arrays. */
function lcs(a: string[], b: string[]): number {
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/**
 * True when the quote occurs in the evidence: exactly after normalization, or as a near match where at least
 * 80 percent of the quote's words appear in order inside one window of the evidence (tolerates a dropped or
 * changed word; rejects a quote assembled from scattered fragments).
 */
export function quoteFound(quote: string, evidence: string): boolean {
  const q = norm(quote);
  if (q.length < 12) return false;
  const e = norm(evidence);
  if (e.includes(q)) return true;
  const qw = q.replace(/[^a-z0-9$%.\s]/g, " ").split(/\s+/).filter(Boolean);
  if (qw.length < 6) return false;
  const ew = e.replace(/[^a-z0-9$%.\s]/g, " ").split(/\s+/).filter(Boolean);
  const win = qw.length + 3;
  const need = Math.ceil(qw.length * 0.8);
  // only start windows at a token that occurs in the quote, which keeps this fast on long sections
  const qset = new Set(qw);
  for (let i = 0; i + qw.length <= ew.length; i++) {
    if (!qset.has(ew[i]!)) continue;
    if (lcs(qw, ew.slice(i, i + win)) >= need) return true;
  }
  return false;
}

// ---- the agent ----

export function buildEvidence(sectionIds: string[], sectionsById: Map<string, Section>): { text: string; primary: Section | null } {
  const secs = sectionIds.map((id) => sectionsById.get(id)).filter((s): s is Section => !!s);
  const text = secs.map((s) => `<evidence id="${s.id}" form="${s.form}" filed="${s.filingDate}" title="${s.title}">\n${s.text}\n</evidence>`).join("\n");
  return { text, primary: secs[0] ?? null };
}

export async function validateBlock(
  cfg: Cfg,
  block: string,
  data: any,
  sectionsById: Map<string, Section>,
  model: string,
  policyUnsupported: "exclude" | "flag",
  policyUnverified: "flag" | "hide" = "flag",
  timeoutMs = 45000,
): Promise<BlockValidation> {
  const started = Date.now();
  const items = claimItems(block, data);
  const policy = { unsupported: policyUnsupported, partial: "flag", uncited: "flag", unverified: policyUnverified } as const;
  const counts: Record<Verdict, number> = { supported: 0, partial: 0, unsupported: 0, uncited: 0, unverified: 0 };
  const claims: ClaimCheck[] = [];

  // Deterministic pass first: figures and citation presence. This runs even if the model call fails.
  const prepared = items.map((item, index) => {
    const text = claimText(block, item);
    const cites: string[] = Array.isArray(item.citations) ? item.citations : [];
    const ev = buildEvidence(cites, sectionsById);
    const figures = cites.length ? checkFigures(text, ev.text) : { checked: 0, matched: 0, unmatched: [] };
    return { index, text, cites, ev, figures };
  });

  const finish = (): BlockValidation => {
    for (const c of claims) counts[c.verdict]++;
    const status: BlockValidation["status"] =
      counts.unverified > 0 && claims.every((c) => c.verdict === "unverified") ? "unverified"
        : counts.unsupported > 0 && policy.unsupported === "exclude" ? "excluded"
          : counts.partial + counts.uncited + counts.unsupported + counts.unverified > 0 ? "flagged"
            : "verified";
    return { block, status, claims, counts, policy, elapsedMs: Date.now() - started, model, provider };
  };
  let provider = "";

  if (!items.length) return finish();

  // Model pass, scoped to the cited evidence only.
  const toReview = prepared.filter((p) => p.cites.length && p.ev.text);
  let modelOut = new Map<number, { verdict: string; quote: string; reason: string }>();
  let modelError: string | undefined;
  if (toReview.length) {
    const evidenceBlocks = new Map<string, string>();
    for (const p of toReview) for (const id of p.cites) { const s = sectionsById.get(id); if (s) evidenceBlocks.set(id, `<evidence id="${s.id}" form="${s.form}" filed="${s.filingDate}" title="${s.title}">\n${s.text}\n</evidence>`); }
    const user = `EVIDENCE (the only source of truth for this review):\n${[...evidenceBlocks.values()].join("\n")}\n\nCLAIMS TO REVIEW (each lists the evidence ids its writer cited):\n${toReview
      .map((p) => `[${p.index}] cites ${p.cites.join(", ")}\n${p.text}`)
      .join("\n\n")}\n\nReturn the JSON object now.`;
    try {
      const served = await chatText(cfg, { model, temperature: 0, messages: [{ role: "system", content: VALIDATOR_SYSTEM }, { role: "user", content: user }] }, timeoutMs);
      provider = served.provider;
      const text: string = served.text;
      const m = /\{[\s\S]*\}/.exec(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      const parsed = m ? JSON.parse(m[0]) : {};
      for (const c of parsed.claims ?? []) modelOut.set(Number(c.i), { verdict: String(c.verdict ?? "").toLowerCase(), quote: String(c.quote ?? ""), reason: String(c.reason ?? "") });
    } catch (e) {
      // Vendor detail stays in the server log; the advisor sees a neutral reason.
      logAiFailure(`validate ${block}`, e);
      modelError = (e as Error).name === "AbortError" || /no response within/.test(String((e as Error).message)) ? "the independent reading timed out" : "the independent reading service did not respond";
    }
  }

  for (const p of prepared) {
    const secs = p.cites.map((id) => sectionsById.get(id)).filter((x): x is Section => !!x);
    const sources: SourceRef[] = secs.map((x) => ({ sectionId: x.id, form: x.form, item: x.item, filingDate: x.filingDate, accession: x.accession, url: x.url, fetchedAt: x.fetchedAt, chars: x.chars }));
    const srcLabel = secs.map((x) => `${x.form} ${x.item} filed ${x.filingDate}`).join("; ");
    const checks: CheckRow[] = [
      { id: "citation", label: "Citation found", pass: p.cites.length > 0 && secs.length === p.cites.length,
        detail: p.cites.length ? (secs.length === p.cites.length ? `The claim cites ${secs.length} filing section${secs.length > 1 ? "s" : ""} that ${secs.length > 1 ? "were" : "was"} actually read: ${srcLabel}.` : "The claim cites a section id that was not among the sections read.") : "The writer attached no citation to this claim." },
      { id: "source", label: "Source content checked", pass: secs.length > 0 ? true : null,
        detail: secs.length ? `${secs.reduce((a, x) => a + x.chars, 0).toLocaleString()} characters of the cited filing text were sent to the validator as the only evidence.` : "No cited text to check against." },
      { id: "figures", label: "Numbers match the filing", pass: p.figures.checked ? p.figures.unmatched.length === 0 : null,
        detail: p.figures.checked ? (p.figures.unmatched.length ? `${p.figures.matched} of ${p.figures.checked} figures found in the cited text. Not found: ${p.figures.unmatched.join(", ")}.` : `All ${p.figures.checked} figure${p.figures.checked > 1 ? "s" : ""} in the claim appear in the cited text.`) : "The claim states no figures to check." },
      { id: "authoritative", label: "Source is authoritative", pass: secs.length > 0 ? true : null,
        detail: secs.length ? `Primary document of an SEC EDGAR filing (accession ${secs[0]!.accession}), fetched from sec.gov at ${secs[0]!.fetchedAt.replace("T", " ").slice(0, 19)} UTC.` : "No SEC source attached." },
    ];
    const base: ClaimCheck = {
      index: p.index, verdict: "unverified", reason: "", quote: "", quoteFound: false,
      sectionId: p.ev.primary?.id ?? null, url: p.ev.primary?.url ?? null, figures: p.figures, modelVerdict: null, checks, sources,
    };
    if (!p.cites.length) {
      checks.push({ id: "reading", label: "Independent reading", pass: null, detail: "Not run: nothing to read against." });
      claims.push({ ...base, verdict: "uncited", reason: "The writer cited no filing section for this claim." });
      continue;
    }
    const mo = modelOut.get(p.index);
    if (!mo) {
      const why = modelError ? `Not validated: ${modelError}.` : "Validator returned no verdict for this claim.";
      checks.push({ id: "reading", label: "Independent reading", pass: null, detail: `${why} No confidence is shown; the deterministic checks above still stand and the original filing is linked.` });
      claims.push({ ...base, verdict: "unverified", reason: why });
      continue;
    }
    const qf = mo.quote ? quoteFound(mo.quote, p.ev.text) : false;
    let verdict: Verdict;
    let reason = mo.reason;
    if (mo.verdict === "unsupported") {
      verdict = "unsupported";
    } else if (mo.verdict === "partial") {
      verdict = "partial";
    } else if (mo.verdict === "supported") {
      if (!qf) { verdict = "partial"; reason = `Validator called this supported but its evidence quote could not be located in the cited text. ${reason}`.trim(); }
      else if (p.figures.unmatched.length) { verdict = "partial"; reason = `Figure${p.figures.unmatched.length > 1 ? "s" : ""} not found in the cited text: ${p.figures.unmatched.join(", ")}. ${reason}`.trim(); }
      else verdict = "supported";
    } else {
      verdict = "unverified"; reason = `Validator returned an unknown verdict "${mo.verdict}".`;
    }
    if (verdict === "supported" && p.figures.checked && p.figures.matched < p.figures.checked) verdict = "partial";
    checks.push({ id: "reading", label: "Independent reading", pass: mo.verdict === "supported" ? qf : mo.verdict === "partial" ? null : false,
      detail: mo.verdict === "supported"
        ? (qf ? `A second model read only the cited text and found the claim stated there. Evidence quote located verbatim in the filing.` : `A second model called this supported but its evidence quote could not be located in the cited text, so the claim is marked for review.`)
        : mo.verdict === "partial" ? `A second model found the main point in the cited text but a detail is missing or imprecise: ${mo.reason}` : `A second model could not find this in the cited text: ${mo.reason}` });
    claims.push({ ...base, verdict, reason, quote: mo.quote, quoteFound: qf, modelVerdict: mo.verdict });
  }
  const out = finish();
  if (modelError) out.error = modelError;
  return out;
}

export function summarizeValidation(blocks: BlockValidation[], started: number, model: string) {
  const counts: Record<Verdict, number> = { supported: 0, partial: 0, unsupported: 0, uncited: 0, unverified: 0 };
  let claims = 0, figuresChecked = 0, figuresMatched = 0, quotesFound = 0;
  for (const b of blocks) for (const c of b.claims) {
    claims++; counts[c.verdict]++;
    figuresChecked += c.figures.checked; figuresMatched += c.figures.matched;
    if (c.quoteFound) quotesFound++;
  }
  const excluded = blocks.reduce((a, b) => a + (b.policy.unsupported === "exclude" ? b.counts.unsupported : 0) + (b.policy.unverified === "hide" ? b.counts.unverified : 0), 0);
  const validatorRan = blocks.some((b) => b.claims.some((c) => c.modelVerdict !== null));
  const status = claims === 0 || !validatorRan ? "unverified" : counts.unsupported > 0 ? "unsupported" : counts.supported === claims ? "verified" : "review";
  // Safe failure: if the independent reading did not run, no coverage figure is reported at all. A number here would be a false signal.
  const supportedPct = validatorRan && claims ? Math.round((100 * counts.supported) / claims) : null;
  const hidden = blocks.reduce((a, b) => a + (b.policy.unverified === "hide" ? b.counts.unverified : 0), 0);
  const errors = [...new Set(blocks.map((b) => b.error).filter((x): x is string => !!x))];
  return { claims, counts, excluded, hidden, flagged: counts.partial + counts.uncited + (hidden ? 0 : counts.unverified) + (counts.unsupported - (excluded - hidden)), figuresChecked, figuresMatched, quotesFound, supportedPct, validatorRan, status, model, provider: blocks.find((b) => b.provider)?.provider ?? null, errors, elapsedMs: Date.now() - started };
}
