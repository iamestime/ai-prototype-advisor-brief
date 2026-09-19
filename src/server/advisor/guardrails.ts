// Guardrails: the checks that sit around every model call.
//
// Input side
//   - validateQuery / validateQuestion: length, character set, and shape of what the advisor typed.
//   - rejectSensitive: refuses client account numbers, card numbers, government ids in a question.
//   - rateLimit: per client token bucket so one browser cannot exhaust the model budget.
//   - sanitizeSource: filing text is data. Lines that read like instructions to the model are neutralized
//     before the text is placed inside the prompt (prompt injection hardening).
//   - adviceRequest: questions that ask for a recommendation get a compliance answer, no model call.
// Output side
//   - screenText: generated text is scanned for advice language, price targets, guarantees, and off
//     platform contact details. Hits are reported as compliance flags on the claim.
// Every check reports into a GuardrailReport that the UI shows, so the advisor sees what ran and what fired.

export type GuardrailCheck = { id: string; label: string; status: "pass" | "fired" | "skipped"; detail: string };
export type GuardrailReport = { checks: GuardrailCheck[]; fired: number; total: number };

export function report(checks: GuardrailCheck[]): GuardrailReport {
  return { checks, fired: checks.filter((c) => c.status === "fired").length, total: checks.length };
}

// ---- input validation ----

export function validateQuery(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const q = String(raw ?? "").trim();
  if (!q) return { ok: false, message: "Enter a ticker or company name." };
  if (q.length > 64) return { ok: false, message: "Keep the ticker or company name under 64 characters." };
  if (!/^[A-Za-z0-9 .,&'\-]+$/.test(q)) return { ok: false, message: "Use letters, numbers, spaces, and basic punctuation only." };
  return { ok: true, value: q };
}

export function validateQuestion(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  const q = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (q.length < 3) return { ok: false, message: "Ask a fuller question." };
  if (q.length > 600) return { ok: false, message: "Keep the question under 600 characters." };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(q)) return { ok: false, message: "The question contains unsupported characters." };
  return { ok: true, value: q };
}

// ---- sensitive data in the question (client PII never goes to a model) ----

function luhn(digits: string): boolean {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

export function rejectSensitive(text: string): string | null {
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return "Please remove the Social Security number before asking.";
  const runs = text.replace(/[\s-]/g, "").match(/\d{13,19}/g) ?? [];
  if (runs.some(luhn)) return "Please remove the card number before asking.";
  if (/\b(account|acct|routing)\s*(number|no\.?|#)?\s*[:#]?\s*\d{6,}/i.test(text)) return "Please remove the account number before asking. Questions should be about the company and its filings.";
  if (/\b[A-Z]{1,2}\d{6,9}\b/.test(text) && /passport|license|licence/i.test(text)) return "Please remove the identity document number before asking.";
  return null;
}

// ---- advice requests get a compliance answer instead of a model answer ----

const ADVICE_RE = /\b(should (i|we|my client|the client|they)\s+(buy|sell|hold|invest|add|trim)|is it a (good|bad|smart) (buy|investment|time)|(buy|sell|hold) (rating|recommendation)|price target|will (the|this) stock (go|rise|fall|drop|double)|what will the (price|stock) (be|do)|(good|safe) investment)\b/i;

export function adviceRequest(question: string): boolean {
  return ADVICE_RE.test(question);
}

export const ADVICE_ANSWER =
  "This tool does not make recommendations or forecasts. It summarizes what the company has filed with the SEC so you can form your own view. Ask about revenue, margins, risks, capital return, guidance language, or recent 8-K events and the answer will cite the filing.";

// ---- prompt injection hardening for source text ----

const INJECTION_RE = /^(?:.*\b(ignore|disregard|forget)\b.*\b(previous|prior|above|all|these)\b.*\b(instructions?|rules?|prompts?)\b.*|.*\byou are now\b.*|.*\bsystem prompt\b.*|.*\bas an ai\b.*|.*\bdo not follow\b.*\binstructions?\b.*)$/i;

/** Neutralizes instruction shaped lines inside a filing section and returns the cleaned text. */
export function sanitizeSource(text: string): string {
  let hits = 0;
  const out = text
    .split("\n")
    .map((line) => {
      if (INJECTION_RE.test(line.trim())) { hits++; return "[line removed: instruction shaped text in source]"; }
      return line;
    })
    .join("\n");
  if (hits) console.warn(`[advisor-brief] sanitizeSource removed ${hits} instruction shaped line(s)`);
  return out;
}

export function countInjectionLines(text: string): number {
  return text.split("\n").filter((l) => INJECTION_RE.test(l.trim())).length;
}

// ---- output screening ----

const OUTPUT_RULES: Array<{ id: string; label: string; re: RegExp }> = [
  { id: "advice", label: "Advice language", re: /\b(you should (buy|sell|hold)|(strong )?(buy|sell) (now|today|this stock)|we recommend (buying|selling)|(buy|sell|hold) rating|accumulate|overweight|underweight)\b/i },
  { id: "target", label: "Price target or forecast", re: /\b(price target|target price|will (rise|fall|double|triple)|expect the (stock|shares) to|is going to (rise|fall))\b/i },
  { id: "guarantee", label: "Guarantee or certainty", re: /\b(guaranteed|risk free|cannot lose|certain to|sure thing)\b/i },
  { id: "contact", label: "Off platform contact", re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b\+?\d{3}[ .-]\d{3}[ .-]\d{4}\b|https?:\/\/(?!www\.sec\.gov)/i },
];

export type OutputFlag = { id: string; label: string; match: string };

export function screenText(text: string): OutputFlag[] {
  const flags: OutputFlag[] = [];
  for (const r of OUTPUT_RULES) {
    const m = r.re.exec(text);
    if (m) flags.push({ id: r.id, label: r.label, match: m[0] });
  }
  return flags;
}

// ---- rate limiting (per warm instance token bucket) ----

const buckets = new Map<string, { tokens: number; at: number }>();
const WINDOW_MS = 10 * 60e3;

export function clientKey(request: Request): string {
  const h = request.headers;
  return h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "anon";
}

export function rateLimit(key: string, limitPer10m: number): { ok: boolean; remaining: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: limitPer10m, at: now };
  const refill = ((now - b.at) / WINDOW_MS) * limitPer10m;
  b.tokens = Math.min(limitPer10m, b.tokens + refill);
  b.at = now;
  if (b.tokens < 1) { buckets.set(key, b); return { ok: false, remaining: 0 }; }
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
  return { ok: true, remaining: Math.floor(b.tokens) };
}

// ---- report builders ----

export function briefGuardrails(args: {
  query: string;
  sectionsChars: number;
  injectionLines: number;
  citationsDropped: number;
  outputFlags: number;
  claims: number;
  validatorRan: boolean;
  rateRemaining: number;
}): GuardrailReport {
  return report([
    { id: "input", label: "Input validated", status: "pass", detail: `Query "${args.query}" passed length and character checks.` },
    { id: "rate", label: "Rate limit", status: "pass", detail: `${args.rateRemaining} briefings left in this 10 minute window for this client.` },
    { id: "source", label: "Source text treated as data", status: args.injectionLines ? "fired" : "pass", detail: args.injectionLines ? `${args.injectionLines} instruction shaped line(s) removed from filing text before the model saw it.` : `${args.sectionsChars.toLocaleString()} characters of filing text passed to the model inside data tags; no instruction shaped lines found.` },
    { id: "citations", label: "Citations enforced", status: args.citationsDropped ? "fired" : "pass", detail: args.citationsDropped ? `${args.citationsDropped} citation(s) pointed at sections that were never sent and were dropped.` : "Every citation points at a section that was actually read." },
    { id: "output", label: "Output screened", status: args.outputFlags ? "fired" : "pass", detail: args.outputFlags ? `${args.outputFlags} claim(s) contained advice, forecast, guarantee, or contact language and were flagged for compliance.` : "No advice, forecast, guarantee, or contact language in the generated text." },
    { id: "validation", label: "Independent validation", status: args.validatorRan ? "pass" : "skipped", detail: args.validatorRan ? `${args.claims} claims reviewed against the cited filing text by a separate Gemini context.` : "Generated claims were withheld because independent verification did not complete; the SEC filing digest remains available." },
  ]);
}

export function askGuardrails(args: { question: string; sensitive: string | null; advice: boolean; retrieved: number; outputFlags: OutputFlag[]; figuresOk: boolean | null; quoteOk: boolean | null }): GuardrailReport {
  return report([
    { id: "input", label: "Question validated", status: "pass", detail: `${args.question.length} characters, plain text.` },
    { id: "pii", label: "Client data screened", status: args.sensitive ? "fired" : "pass", detail: args.sensitive ?? "No account, card, or identity numbers in the question." },
    { id: "advice", label: "Advice request", status: args.advice ? "fired" : "pass", detail: args.advice ? "The question asked for a recommendation or forecast. Answered with the compliance response, no model call." : "The question asks about the company or its filings." },
    { id: "grounding", label: "Grounded in filings", status: args.retrieved ? "pass" : "skipped", detail: args.retrieved ? `${args.retrieved} filing passages retrieved and passed to the model as the only source.` : "No passages retrieved." },
    { id: "output", label: "Output screened", status: args.outputFlags.length ? "fired" : "pass", detail: args.outputFlags.length ? `Flagged: ${args.outputFlags.map((f) => f.label).join(", ")}.` : "No advice, forecast, guarantee, or contact language in the answer." },
    { id: "figures", label: "Numbers match the filing", status: args.figuresOk === null ? "skipped" : args.figuresOk ? "pass" : "fired", detail: args.figuresOk === null ? "The answer states no figures." : args.figuresOk ? "Every figure in the answer appears in the retrieved passages." : "A figure in the answer was not found in the retrieved passages; the answer is marked for review." },
    { id: "quote", label: "Evidence quote located", status: args.quoteOk === null ? "skipped" : args.quoteOk ? "pass" : "fired", detail: args.quoteOk === null ? "No quote returned." : args.quoteOk ? "The supporting quote occurs verbatim in the filing." : "The supporting quote could not be located in the filing; the answer is marked for review." },
  ]);
}
