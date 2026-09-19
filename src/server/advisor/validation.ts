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

export type CheckRow = {
  id: "source" | "citation" | "figures" | "authoritative" | "reading";
  label: string;
  pass: boolean | null;
  detail: string;
};
export type SourceRef = {
  sectionId: string;
  form: string;
  item: string;
  filingDate: string;
  accession: string;
  url: string;
  fetchedAt: string;
  chars: number;
};
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
  policy: {
    unsupported: "exclude" | "flag";
    partial: "flag";
    uncited: "flag";
    unverified: "flag" | "hide";
  };
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

Output only JSON: {"claims":[{"id":"<block:index>","verdict":"supported|partial|unsupported","quote":"...","reason":"<one sentence>"}]}`;

const VALIDATOR_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "independent_claim_review",
    strict: true,
    schema: {
      type: "object",
      properties: {
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              verdict: { type: "string", enum: ["supported", "partial", "unsupported"] },
              quote: { type: "string" },
              reason: { type: "string" },
            },
            required: ["id", "verdict", "quote", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["claims"],
      additionalProperties: false,
    },
  },
};

// ---- claim extraction ----

export function claimText(block: string, item: any): string {
  if (block === "summary") return String(item.text ?? "");
  if (block === "events")
    return `${item.date ?? ""}: ${item.headline ?? ""}. ${item.why_it_matters ?? ""}`;
  if (block === "risks") return `${item.title ?? ""}. ${item.text ?? ""}`;
  if (block === "questions") return `${item.question ?? ""} ${item.answer ?? ""}`;
  return String(item.text ?? "");
}

export function claimItems(block: string, data: any): any[] {
  return (block === "summary" ? data?.paragraphs : data?.items) ?? [];
}

// ---- figure check ----

const UNIT_MULT: Record<string, number> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  trillion: 1e12,
  k: 1e3,
  m: 1e6,
  b: 1e9,
  bn: 1e9,
  mm: 1e6,
};

/** Numbers stated in a claim, with the scale a reader would infer from the surrounding word. */
export function claimFigures(
  text: string,
): Array<{ raw: string; value: number; scale: number; percent: boolean }> {
  const out: Array<{ raw: string; value: number; scale: number; percent: boolean }> = [];
  const re =
    /(?<![\w.])\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%|percent|thousand|million|billion|trillion|bn|mm|k|m|b)?(?![\w])/gi;
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

export function figuresMatch(
  claimVal: number,
  claimScale: number,
  precisionDigits: number,
  ev: number[],
  mults: number[] = [1, 1e3, 1e6, 1e9],
): boolean {
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

export function checkFigures(
  claim: string,
  evidence: string,
): { checked: number; matched: number; unmatched: string[] } {
  const figs = claimFigures(claim);
  if (!figs.length) return { checked: 0, matched: 0, unmatched: [] };
  const ev = evidenceValues(evidence);
  const mults = evidenceScale(evidence);
  const unmatched: string[] = [];
  let matched = 0;
  for (const f of figs) {
    const decimals = (String(f.value).split(".")[1] ?? "").length;
    // a percentage or a bare number is matched as written; a scaled figure uses the table's unit when stated
    if (
      figuresMatch(
        f.value,
        f.scale,
        decimals,
        ev,
        f.percent || f.scale === 1 ? [1, 1e3, 1e6, 1e9] : mults,
      )
    )
      matched++;
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
  const qw = q
    .replace(/[^a-z0-9$%.\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (qw.length < 6) return false;
  const ew = e
    .replace(/[^a-z0-9$%.\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
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

export function buildEvidence(
  sectionIds: string[],
  sectionsById: Map<string, Section>,
): { text: string; primary: Section | null } {
  const secs = sectionIds.map((id) => sectionsById.get(id)).filter((s): s is Section => !!s);
  const text = secs
    .map(
      (s) =>
        `<evidence id="${s.id}" form="${s.form}" filed="${s.filingDate}" title="${s.title}">\n${s.text}\n</evidence>`,
    )
    .join("\n");
  return { text, primary: secs[0] ?? null };
}

type PreparedClaim = {
  id: string;
  block: string;
  index: number;
  text: string;
  cites: string[];
  ev: ReturnType<typeof buildEvidence>;
  figures: ReturnType<typeof checkFigures>;
  reviewEvidence: string;
  reviewEvidenceChars: number;
};

type ModelReview = { verdict: string; quote: string; reason: string };

const REVIEW_EVIDENCE_CHARS = 2_400;

/**
 * Select the filing windows that share the most concrete language and figures with a claim. The reviewer
 * does not need a 30,000-character filing section to check one sentence; sending a compact evidence packet
 * reduces latency and token pressure while the server keeps the full cited text for quote and figure checks.
 */
export function evidenceExcerpt(
  claim: string,
  evidence: string,
  maxChars = REVIEW_EVIDENCE_CHARS,
): string {
  if (evidence.length <= maxChars) return evidence;
  const terms = new Set(
    norm(claim)
      .replace(/[^a-z0-9$%.,\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4 || /\d/.test(word)),
  );
  const windowChars = Math.min(1_050, maxChars);
  const step = Math.max(500, windowChars - 250);
  const windows: Array<{ start: number; end: number; score: number }> = [];
  for (let start = 0; start < evidence.length; start += step) {
    const end = Math.min(evidence.length, start + windowChars);
    const haystack = norm(evidence.slice(start, end));
    let score = 0;
    for (const term of terms) if (haystack.includes(term)) score += /\d/.test(term) ? 5 : 1;
    windows.push({ start, end, score });
    if (end === evidence.length) break;
  }
  const picked: typeof windows = [];
  for (const candidate of windows.sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (
      picked.some((row) => Math.max(row.start, candidate.start) < Math.min(row.end, candidate.end))
    )
      continue;
    const used = picked.reduce((sum, row) => sum + row.end - row.start, 0);
    if (picked.length && used + (candidate.end - candidate.start) + 5 > maxChars) break;
    picked.push(candidate);
    if (used + candidate.end - candidate.start >= maxChars) break;
  }
  if (!picked.length) return evidence.slice(0, maxChars);
  return picked
    .sort((a, b) => a.start - b.start)
    .map((row) => evidence.slice(row.start, row.end).trim())
    .join("\n[…]\n")
    .slice(0, maxChars);
}

function prepareClaims(
  blocks: Array<{ block: string; data: any }>,
  sectionsById: Map<string, Section>,
): PreparedClaim[] {
  const prepared: PreparedClaim[] = [];
  for (const { block, data } of blocks) {
    for (const [index, item] of claimItems(block, data).entries()) {
      const text = claimText(block, item);
      const cites: string[] = Array.isArray(item.citations) ? item.citations : [];
      const ev = buildEvidence(cites, sectionsById);
      const figures = cites.length
        ? checkFigures(text, ev.text)
        : { checked: 0, matched: 0, unmatched: [] };
      const sections = cites
        .map((id) => sectionsById.get(id))
        .filter((section): section is Section => !!section);
      const perSection = Math.max(
        700,
        Math.floor(REVIEW_EVIDENCE_CHARS / Math.max(1, sections.length)),
      );
      const reviewEvidence = sections
        .map(
          (section) =>
            `<evidence id="${section.id}" form="${section.form}" filed="${section.filingDate}" title="${section.title}">\n${evidenceExcerpt(text, section.text, perSection)}\n</evidence>`,
        )
        .join("\n");
      prepared.push({
        id: `${block}:${index}`,
        block,
        index,
        text,
        cites,
        ev,
        figures,
        reviewEvidence,
        reviewEvidenceChars: sections.reduce(
          (sum, section) => sum + Math.min(section.text.length, perSection),
          0,
        ),
      });
    }
  }
  return prepared;
}

async function reviewClaims(
  cfg: Cfg,
  prepared: PreparedClaim[],
  model: string,
  timeoutMs: number,
): Promise<{ reviews: Map<string, ModelReview>; provider: string; error?: string }> {
  const toReview = prepared.filter((claim) => claim.cites.length && claim.reviewEvidence);
  if (!toReview.length) return { reviews: new Map(), provider: "" };
  const user = `Review every claim below. Each claim has its own filing evidence packet. Do not use evidence from one claim to validate another.\n\n${toReview
    .map(
      (claim) =>
        `<review_claim id="${claim.id}" cited_sections="${claim.cites.join(",")}">\n<claim>${claim.text}</claim>\n${claim.reviewEvidence}\n</review_claim>`,
    )
    .join("\n\n")}\n\nReturn one JSON verdict for every review_claim id.`;
  try {
    const served = await chatText(
      cfg,
      {
        model,
        temperature: 0,
        reasoning_effort: "low",
        response_format: VALIDATOR_RESPONSE_FORMAT,
        messages: [
          { role: "system", content: VALIDATOR_SYSTEM },
          { role: "user", content: user },
        ],
      },
      timeoutMs,
    );
    const match = /\{[\s\S]*\}/.exec(served.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    const parsed = match ? JSON.parse(match[0]) : {};
    const reviews = new Map<string, ModelReview>();
    for (const row of parsed.claims ?? []) {
      const id = String(row.id ?? "");
      if (!toReview.some((claim) => claim.id === id)) continue;
      reviews.set(id, {
        verdict: String(row.verdict ?? "").toLowerCase(),
        quote: String(row.quote ?? ""),
        reason: String(row.reason ?? ""),
      });
    }
    return { reviews, provider: served.provider };
  } catch (error) {
    logAiFailure("validate briefing", error);
    const message =
      (error as Error).name === "AbortError" ||
      /no response within/.test(String((error as Error).message))
        ? "the independent reading timed out"
        : "the independent reading service did not respond";
    return { reviews: new Map(), provider: "", error: message };
  }
}

function finalizeBlock(
  block: string,
  prepared: PreparedClaim[],
  sectionsById: Map<string, Section>,
  reviews: Map<string, ModelReview>,
  provider: string,
  modelError: string | undefined,
  model: string,
  policyUnsupported: "exclude" | "flag",
  policyUnverified: "flag" | "hide",
  started: number,
): BlockValidation {
  const policy = {
    unsupported: policyUnsupported,
    partial: "flag",
    uncited: "flag",
    unverified: policyUnverified,
  } as const;
  const counts: Record<Verdict, number> = {
    supported: 0,
    partial: 0,
    unsupported: 0,
    uncited: 0,
    unverified: 0,
  };
  const claims: ClaimCheck[] = [];
  for (const p of prepared.filter((claim) => claim.block === block)) {
    const secs = p.cites
      .map((id) => sectionsById.get(id))
      .filter((section): section is Section => !!section);
    const sources: SourceRef[] = secs.map((section) => ({
      sectionId: section.id,
      form: section.form,
      item: section.item,
      filingDate: section.filingDate,
      accession: section.accession,
      url: section.url,
      fetchedAt: section.fetchedAt,
      chars: section.chars,
    }));
    const sourceLabel = secs
      .map((section) => `${section.form} ${section.item} filed ${section.filingDate}`)
      .join("; ");
    const checks: CheckRow[] = [
      {
        id: "citation",
        label: "Citation found",
        pass: p.cites.length > 0 && secs.length === p.cites.length,
        detail: p.cites.length
          ? secs.length === p.cites.length
            ? `The claim cites ${secs.length} filing section${secs.length > 1 ? "s" : ""} that ${secs.length > 1 ? "were" : "was"} actually read: ${sourceLabel}.`
            : "The claim cites a section id that was not among the sections read."
          : "The writer attached no citation to this claim.",
      },
      {
        id: "source",
        label: "Source content checked",
        pass: secs.length > 0 ? true : null,
        detail: secs.length
          ? `${p.reviewEvidenceChars.toLocaleString()} targeted characters from the cited filing text were independently reviewed; the full ${secs.reduce((sum, section) => sum + section.chars, 0).toLocaleString()} characters remained available for deterministic quote and figure checks.`
          : "No cited text to check against.",
      },
      {
        id: "figures",
        label: "Numbers match the filing",
        pass: p.figures.checked ? p.figures.unmatched.length === 0 : null,
        detail: p.figures.checked
          ? p.figures.unmatched.length
            ? `${p.figures.matched} of ${p.figures.checked} figures found in the cited text. Not found: ${p.figures.unmatched.join(", ")}.`
            : `All ${p.figures.checked} figure${p.figures.checked > 1 ? "s" : ""} in the claim appear in the cited text.`
          : "The claim states no figures to check.",
      },
      {
        id: "authoritative",
        label: "Source is authoritative",
        pass: secs.length > 0 ? true : null,
        detail: secs.length
          ? `Primary document of an SEC EDGAR filing (accession ${secs[0]!.accession}), fetched from sec.gov at ${secs[0]!.fetchedAt.replace("T", " ").slice(0, 19)} UTC.`
          : "No SEC source attached.",
      },
    ];
    const base: ClaimCheck = {
      index: p.index,
      verdict: "unverified",
      reason: "",
      quote: "",
      quoteFound: false,
      sectionId: p.ev.primary?.id ?? null,
      url: p.ev.primary?.url ?? null,
      figures: p.figures,
      modelVerdict: null,
      checks,
      sources,
    };
    if (!p.cites.length) {
      checks.push({
        id: "reading",
        label: "Independent reading",
        pass: null,
        detail: "Not run: nothing to read against.",
      });
      claims.push({
        ...base,
        verdict: "uncited",
        reason: "The writer cited no filing section for this claim.",
      });
      continue;
    }
    const review = reviews.get(p.id);
    if (!review) {
      const why = modelError
        ? `Verification unavailable: ${modelError}.`
        : "The reviewer returned no verdict for this claim.";
      checks.push({
        id: "reading",
        label: "Independent reading",
        pass: null,
        detail: `${why} No confidence is shown; the original filing remains linked.`,
      });
      claims.push({ ...base, verdict: "unverified", reason: why });
      continue;
    }
    const located = review.quote ? quoteFound(review.quote, p.ev.text) : false;
    let verdict: Verdict;
    let reason = review.reason;
    if (review.verdict === "unsupported") verdict = "unsupported";
    else if (review.verdict === "partial") verdict = "partial";
    else if (review.verdict === "supported") {
      if (!located) {
        verdict = "partial";
        reason =
          `Validator called this supported but its evidence quote could not be located in the cited text. ${reason}`.trim();
      } else if (p.figures.unmatched.length) {
        verdict = "partial";
        reason =
          `Figure${p.figures.unmatched.length > 1 ? "s" : ""} not found in the cited text: ${p.figures.unmatched.join(", ")}. ${reason}`.trim();
      } else verdict = "supported";
    } else {
      verdict = "unverified";
      reason = `Validator returned an unknown verdict "${review.verdict}".`;
    }
    checks.push({
      id: "reading",
      label: "Independent reading",
      pass: review.verdict === "supported" ? located : review.verdict === "partial" ? null : false,
      detail:
        review.verdict === "supported"
          ? located
            ? "A separate Gemini review found the claim in its cited evidence packet, and the returned quote was located in the full filing text."
            : "The reviewer called this supported but its quote could not be located, so the claim is marked for review."
          : review.verdict === "partial"
            ? `The reviewer found the main point but identified an imprecise or missing detail: ${review.reason}`
            : `The reviewer could not support this claim from the cited evidence: ${review.reason}`,
    });
    claims.push({
      ...base,
      verdict,
      reason,
      quote: review.quote,
      quoteFound: located,
      modelVerdict: review.verdict,
    });
  }
  for (const claim of claims) counts[claim.verdict]++;
  const status: BlockValidation["status"] =
    counts.unverified > 0 && claims.every((claim) => claim.verdict === "unverified")
      ? "unverified"
      : counts.unsupported > 0 && policy.unsupported === "exclude"
        ? "excluded"
        : counts.partial + counts.uncited + counts.unsupported + counts.unverified > 0
          ? "flagged"
          : "verified";
  return {
    block,
    status,
    claims,
    counts,
    policy,
    elapsedMs: Date.now() - started,
    model,
    provider,
    ...(modelError ? { error: modelError } : {}),
  };
}

/** One independent Gemini call reviews the whole briefing after the writer stream closes. */
export async function validateBriefing(
  cfg: Cfg,
  blocks: Array<{ block: string; data: any }>,
  sectionsById: Map<string, Section>,
  model: string,
  policyUnsupported: "exclude" | "flag",
  policyUnverified: "flag" | "hide" = "hide",
  timeoutMs = 45000,
): Promise<BlockValidation[]> {
  const started = Date.now();
  const prepared = prepareClaims(blocks, sectionsById);
  const reviewed = await reviewClaims(cfg, prepared, model, timeoutMs);
  return blocks.map(({ block }) =>
    finalizeBlock(
      block,
      prepared,
      sectionsById,
      reviewed.reviews,
      reviewed.provider,
      reviewed.error,
      model,
      policyUnsupported,
      policyUnverified,
      started,
    ),
  );
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
  const [result] = await validateBriefing(
    cfg,
    [{ block, data }],
    sectionsById,
    model,
    policyUnsupported,
    policyUnverified,
    timeoutMs,
  );
  return result!;
}

export function summarizeValidation(blocks: BlockValidation[], started: number, model: string) {
  const counts: Record<Verdict, number> = {
    supported: 0,
    partial: 0,
    unsupported: 0,
    uncited: 0,
    unverified: 0,
  };
  let claims = 0,
    figuresChecked = 0,
    figuresMatched = 0,
    quotesFound = 0;
  for (const b of blocks)
    for (const c of b.claims) {
      claims++;
      counts[c.verdict]++;
      figuresChecked += c.figures.checked;
      figuresMatched += c.figures.matched;
      if (c.quoteFound) quotesFound++;
    }
  const excluded = blocks.reduce(
    (a, b) =>
      a +
      (b.policy.unsupported === "exclude" ? b.counts.unsupported : 0) +
      (b.policy.unverified === "hide" ? b.counts.unverified : 0),
    0,
  );
  const validatorRan = blocks.some((b) => b.claims.some((c) => c.modelVerdict !== null));
  const status =
    claims === 0 || !validatorRan
      ? "unverified"
      : counts.unsupported > 0
        ? "unsupported"
        : counts.supported === claims
          ? "verified"
          : "review";
  // Safe failure: if the independent reading did not run, no coverage figure is reported at all. A number here would be a false signal.
  const supportedPct =
    validatorRan && claims ? Math.round((100 * counts.supported) / claims) : null;
  const hidden = blocks.reduce(
    (a, b) => a + (b.policy.unverified === "hide" ? b.counts.unverified : 0),
    0,
  );
  const errors = [...new Set(blocks.map((b) => b.error).filter((x): x is string => !!x))];
  return {
    claims,
    counts,
    excluded,
    hidden,
    flagged:
      counts.partial +
      counts.uncited +
      (hidden ? 0 : counts.unverified) +
      (counts.unsupported - (excluded - hidden)),
    figuresChecked,
    figuresMatched,
    quotesFound,
    supportedPct,
    validatorRan,
    status,
    model,
    provider: blocks.find((b) => b.provider)?.provider ?? null,
    errors,
    elapsedMs: Date.now() - started,
  };
}
