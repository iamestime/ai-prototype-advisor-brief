import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Advisor Brief" },
      {
        name: "description",
        content:
          "Type a ticker and get a live quote, eight quarters of SEC filed financials, and a cited briefing written from the latest 10-K, 10-Q, and 8-Ks.",
      },
    ],
  }),
  component: AdvisorBrief,
});

/* ---------- formatting ---------- */
const fmtMoney = (v: number | null | undefined, d = 2) =>
  v == null
    ? "n/a"
    : "$" +
      Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtBig = (v: number | null | undefined): string => {
  if (v == null) return "n/a";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
  return String(v);
};
const fmtUsd = (v: number | null | undefined) =>
  v == null ? "n/a" : (v < 0 ? "-$" : "$") + fmtBig(Math.abs(v));
const fmtPct = (v: number | null | undefined, d = 2) =>
  v == null ? "n/a" : (v * 100).toFixed(d) + "%";
const niceStep = (span: number, n: number) => {
  const raw = span / n;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
};
const fmtDate = (s?: string | null) => {
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const d = m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!) : new Date(s);
  return isNaN(d.getTime())
    ? s
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const fmtStamp = (iso?: string | null) => (iso ? iso.replace("T", " ").slice(0, 19) + " UTC" : "");
const fmtAge = (ms: number) =>
  ms < 60e3
    ? "just now"
    : ms < 3600e3
      ? `${Math.round(ms / 60e3)} min ago`
      : `${Math.round(ms / 3600e3)} h ago`;
const secs = (ms: number) => (ms / 1000).toFixed(1) + "s";

/* ---------- types ---------- */
type SectionMeta = {
  id: string;
  url: string;
  title: string;
  chars: number;
  truncated: boolean;
  accession?: string;
  fetchedAt?: string;
  form?: string;
  item?: string;
  filingDate?: string;
};
type BlockEvent = { name: string; title: string; data: any; elapsedMs?: number };
type Verdict = "supported" | "partial" | "unsupported" | "uncited" | "unverified";
type CheckRow = { id: string; label: string; pass: boolean | null; detail: string };
type SourceRef = {
  sectionId: string;
  form: string;
  item: string;
  filingDate: string;
  accession: string;
  url: string;
  fetchedAt: string;
  chars: number;
};
type ClaimCheck = {
  index: number;
  verdict: Verdict;
  reason: string;
  quote: string;
  quoteFound: boolean;
  sectionId: string | null;
  url: string | null;
  figures: { checked: number; matched: number; unmatched: string[] };
  checks?: CheckRow[];
  sources?: SourceRef[];
};
type BlockValidation = {
  block: string;
  status: "validating" | "verified" | "flagged" | "excluded" | "unverified";
  claims?: ClaimCheck[];
  counts?: Record<Verdict, number>;
  policy?: { unsupported: "exclude" | "flag"; unverified?: "flag" | "hide" };
  error?: string;
  provider?: string;
};
type ValidationSummary = {
  claims: number;
  counts: Record<Verdict, number>;
  excluded: number;
  hidden?: number;
  flagged: number;
  figuresChecked: number;
  figuresMatched: number;
  quotesFound?: number;
  supportedPct: number | null;
  validatorRan?: boolean;
  status: "verified" | "review" | "unsupported" | "unverified";
  model: string;
  provider?: string | null;
  errors?: string[];
  elapsedMs: number;
};
type Digest = {
  generatedAt: string;
  facts: Array<{ text: string; source: string }>;
  events: Array<{
    date: string;
    items: string[];
    labels: string[];
    url: string;
    accession: string;
  }>;
  filings: Array<{
    form: string;
    filingDate: string;
    reportDate: string;
    accession: string;
    url: string;
  }>;
  sectionsRead: Array<{
    id: string;
    title: string;
    chars: number;
    truncated: boolean;
    url: string;
    fetchedAt: string;
  }>;
};
type GuardrailCheck = {
  id: string;
  label: string;
  status: "pass" | "fired" | "skipped";
  detail: string;
};
type GuardrailReport = { checks: GuardrailCheck[]; fired: number; total: number };
type IndexInfo = {
  chunks: number;
  mode: "hybrid" | "lexical";
  embedModel: string | null;
  provider: string | null;
  buildMs: number;
};
type MemoryInfo = { hit: boolean; generatedAt?: string; ageMs?: number; backend: string };
type LogRow = { t: number; text: string; state: "done" | "live" | "queued" };
type RecentBriefing = {
  key: string;
  ticker: string;
  name: string;
  generatedAt: string;
  summary: {
    status: string | null;
    claims: number;
    supported: number;
    researchFailed: boolean;
    price: number | null;
    changePct: number | null;
  };
};
type AskTurn = {
  role: "user" | "assistant";
  content: string;
  at?: string;
  verdict?: string;
  refused?: boolean;
  sources?: Array<{
    id: string;
    form: string;
    item: string;
    filingDate: string;
    accession: string;
    url: string;
  }>;
  retrieval?: { mode: string; chunks: number; hits?: any[] };
  guardrails?: GuardrailReport;
  quote?: string;
  quoteFound?: boolean | null;
  complianceFlags?: Array<{ label: string }>;
  model?: string;
  provider?: string;
  pending?: boolean;
};

const VERDICT_LABEL: Record<Verdict, string> = {
  supported: "Verified",
  partial: "Review",
  unsupported: "Not supported",
  uncited: "No citation",
  unverified: "Verification pending",
};
const VERDICT_CLASS: Record<Verdict, string> = {
  supported: "border-good/50 text-good",
  partial: "border-warn/60 text-warn",
  unsupported: "border-bad/60 text-bad",
  uncited: "border-warn/60 text-warn",
  unverified: "border-line text-ink-3",
};
const BLOCK_ORDER = [
  "summary",
  "what_changed",
  "risks",
  "events",
  "talking_points",
  "questions",
] as const;
const BLOCK_TITLES: Record<string, string> = {
  summary: "60 second summary",
  what_changed: "What changed since last quarter",
  risks: "Top risks · ranked",
  events: "8-K events · last 90 days",
  talking_points: "Talking points for the client conversation",
  questions: "Questions the advisor should be ready for",
};

/* ---------- small pieces ---------- */
function Skeleton({ width }: { width?: string }) {
  return <div className="ab-skeleton" style={width ? { width } : undefined} />;
}
function StatusChip({
  state,
  label,
}: {
  state: "done" | "live" | "queued" | "digest" | "held";
  label?: string | undefined;
}) {
  const cls =
    state === "done"
      ? "text-good"
      : state === "live"
        ? "text-accent"
        : state === "held"
          ? "text-bad"
          : "text-ink-3";
  const glyph = state === "queued" ? "○" : "●";
  return (
    <span className={`font-mono text-[11px] ${cls}`}>
      {glyph}{" "}
      {label ??
        (state === "done"
          ? "Complete"
          : state === "live"
            ? "Streaming"
            : state === "digest"
              ? "Direct from SEC"
              : state === "held"
                ? "Held"
                : "Queued")}
    </span>
  );
}
function Card({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`ab-card ab-in ${className}`}>
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="ab-label">{title}</h2>
        {right ? <div className="flex items-center gap-2">{right}</div> : null}
      </header>
      {children}
    </section>
  );
}
function Icon({
  name,
  className = "h-4 w-4",
}: {
  name: "search" | "sun" | "moon" | "external" | "arrow" | "shield" | "memory";
  className?: string;
}) {
  const p = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (name === "search")
    return (
      <svg viewBox="0 0 24 24" className={className} {...p}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
    );
  if (name === "sun")
    return (
      <svg viewBox="0 0 24 24" className={className} {...p}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  if (name === "moon")
    return (
      <svg viewBox="0 0 24 24" className={className} {...p}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
      </svg>
    );
  if (name === "external")
    return (
      <svg viewBox="0 0 24 24" className={className} {...p}>
        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
    );
  if (name === "shield")
    return (
      <svg viewBox="0 0 24 24" className={className} {...p}>
        <path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6l-8-3Z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    );
  if (name === "memory")
    return (
      <svg viewBox="0 0 24 24" className={className} {...p}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" className={className} {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/* ---------- citations ---------- */
function CitePopover({
  sec,
  check,
  onClose,
}: {
  sec: SectionMeta | undefined;
  check?: ClaimCheck | undefined;
  onClose: () => void;
}) {
  const [form, date, item] = (sec?.id ?? "").split("|");
  const src = check?.sources?.find((s) => s.sectionId === sec?.id) ?? check?.sources?.[0];
  return (
    <div
      className="ab-in absolute left-0 top-full z-20 mt-1.5 w-[min(480px,90vw)] rounded-xl border border-line bg-surface p-4 shadow-2xl shadow-black/30"
      onMouseLeave={onClose}
    >
      <div className="ab-label mb-2">Citation · click to open the filing</div>
      <div className="text-[15px] font-semibold">
        Form {form} · {item} {sec?.title ? `· ${sec.title}` : ""}
      </div>
      <div className="mt-1 font-mono text-[11px] text-ink-3">
        Filed {date}{" "}
        {(src?.accession ?? sec?.accession)
          ? `· Accession ${src?.accession ?? sec?.accession}`
          : ""}
      </div>
      {check?.quote ? <p className="mt-2.5 text-[13px] text-ink-2">“{check.quote}”</p> : null}
      <div className="mt-3 flex items-center justify-between gap-3">
        <a
          className="ab-btn !py-1.5 !px-3 !text-[12px]"
          href={sec?.url}
          target="_blank"
          rel="noopener"
        >
          Open on sec.gov <Icon name="external" className="h-3.5 w-3.5" />
        </a>
        <span className="font-mono text-[11px] text-ink-3">
          {sec ? `Section ${sec.chars.toLocaleString()} chars` : ""}
          {check
            ? ` · ${check.verdict === "supported" ? "validated" : VERDICT_LABEL[check.verdict].toLowerCase()}`
            : ""}
          {src?.fetchedAt ? ` · fetched ${fmtStamp(src.fetchedAt)}` : ""}
        </span>
      </div>
    </div>
  );
}
function Cites({
  ids,
  index,
  check,
}: {
  ids?: string[];
  index: Record<string, SectionMeta>;
  check?: ClaimCheck | undefined;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!ids || !ids.length) return null;
  return (
    <div className="relative mt-1.5 flex flex-wrap">
      {ids.map((id) => {
        const s = index[id];
        const [form, date, item] = id.split("|");
        return (
          <span key={id} className="relative">
            <button
              type="button"
              className="ab-cite"
              onClick={() => setOpen(open === id ? null : id)}
              title={s?.title ?? id}
            >
              {form} · {item} · {date}
            </button>
            {open === id ? (
              <CitePopover sec={s} check={check} onClose={() => setOpen(null)} />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

/* ---------- validation pieces ---------- */
function ClaimMark({
  check,
  flags,
}: {
  check?: ClaimCheck | undefined;
  flags?: Array<{ label: string }>;
}) {
  const [open, setOpen] = useState(false);
  if (!check) return <span className="ab-chip">Validating</span>;
  const figs = check.figures?.checked
    ? ` · ${check.figures.matched}/${check.figures.checked} figures`
    : "";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 align-middle">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`ab-chip ${VERDICT_CLASS[check.verdict]}`}
        title={check.reason || VERDICT_LABEL[check.verdict]}
        aria-expanded={open}
      >
        {VERDICT_LABEL[check.verdict]}
        {figs}
        <span className="text-ink-3">{open ? "▾" : "▸"}</span>
      </button>
      {flags?.length ? (
        <span
          className="ab-chip border-bad/60 text-bad"
          title={flags.map((f) => f.label).join(", ")}
        >
          Compliance review
        </span>
      ) : null}
      {open ? (
        <div className="mt-1.5 w-full rounded-lg border border-line bg-background px-3 py-2.5 text-[13px]">
          <div className="ab-label mb-1.5">Why this status</div>
          {(check.checks || []).map((c) => (
            <div key={c.id} className="mb-1 grid grid-cols-[64px_1fr] gap-2">
              <span
                className={`font-mono text-[11px] ${c.pass === true ? "text-good" : c.pass === false ? "text-bad" : "text-ink-3"}`}
              >
                {c.pass === true ? "PASS" : c.pass === false ? "FAIL" : "NOT RUN"}
              </span>
              <span>
                <span className="font-semibold text-ink">{c.label}.</span>{" "}
                <span className="text-ink-2">{c.detail}</span>
              </span>
            </div>
          ))}
          {check.quote ? (
            <div className="mt-1.5">
              <span className="text-ink-3">
                Evidence{check.quoteFound ? "" : " (not located verbatim in the cited text)"}:{" "}
              </span>
              <span className="text-ink-2">“{check.quote}”</span>
            </div>
          ) : null}
          {!check.checks?.length && check.reason ? (
            <div className="mt-1 text-warn">{check.reason}</div>
          ) : null}
          {flags?.length ? (
            <div className="mt-1 text-bad">
              Compliance screen: {flags.map((f) => f.label).join(", ")}. Shown for review, not for
              the client.
            </div>
          ) : null}
          <div className="mt-2 text-xs text-ink-3">
            {(check.sources || []).map((src) => (
              <div key={src.sectionId} className="mb-1">
                <a className="ab-cite" href={src.url} target="_blank" rel="noopener">
                  {src.form} · {src.item} · {src.filingDate}
                </a>
                <span className="ml-1">
                  accession {src.accession} · fetched {fmtStamp(src.fetchedAt)} ·{" "}
                  {src.chars.toLocaleString()} chars read
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
}
function blockState(v?: BlockValidation, b?: BlockEvent): "done" | "live" | "queued" {
  if (!b) return "queued";
  if (!v || v.status === "validating") return "live";
  return "done";
}
function BlockBadge({ v }: { v?: BlockValidation | undefined }) {
  if (!v || v.status === "validating") return null;
  const c = v.counts || ({} as Record<Verdict, number>);
  const held =
    (v.policy?.unsupported === "exclude" ? c.unsupported || 0 : 0) +
    (v.policy?.unverified === "hide" ? c.unverified || 0 : 0);
  const flagged =
    (c.partial || 0) +
    (c.uncited || 0) +
    (v.policy?.unverified === "hide" ? 0 : c.unverified || 0) +
    (v.policy?.unsupported === "flag" ? c.unsupported || 0 : 0);
  if (v.status === "unverified")
    return (
      <span className="ab-chip" title={v.error || ""}>
        Verification unavailable
      </span>
    );
  if (v.status === "verified")
    return <span className="ab-chip border-good/50 text-good">{c.supported || 0} verified</span>;
  return (
    <span className="ab-chip border-warn/60 text-warn">
      {c.supported || 0} verified · {flagged} review{held ? ` · ${held} held` : ""}
    </span>
  );
}

/* ---------- header ---------- */
function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      try {
        localStorage.setItem("ab-theme", next);
      } catch {
        /* private mode */
      }
      return next;
    });
  }, []);
  return { theme, toggle };
}
function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!now) return <span className="font-mono text-[11px] text-ink-3">As of</span>;
  const time = now.toLocaleTimeString("en-US", { hour12: false, timeZone: "America/Chicago" });
  const date = now.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  });
  return (
    <span className="whitespace-nowrap font-mono text-[11px] text-ink-3">
      As of {time} CT · {date}
    </span>
  );
}

/* ---------- quote band ---------- */
function CompanyBand({ company, quote, fin }: { company: any; quote: any; fin: any }) {
  const d = quote?.derived || {};
  const pos =
    quote?.price && quote?.week52Low && quote?.week52High && quote.week52High > quote.week52Low
      ? Math.min(
          100,
          Math.max(
            0,
            (100 * (quote.price - quote.week52Low)) / (quote.week52High - quote.week52Low),
          ),
        )
      : null;
  const up = (quote?.change ?? 0) >= 0;
  const stats: Array<[string, string, string?]> = [
    ["Market cap", d.marketCap == null ? "n/a" : "$" + fmtBig(d.marketCap), d.marketCapBasis],
    ["P/E (TTM)", d.trailingPE == null ? "n/a" : Number(d.trailingPE).toFixed(1)],
    ["Div yield", d.dividendYield == null ? "n/a" : fmtPct(d.dividendYield)],
    ["Volume", quote?.volume == null ? "n/a" : fmtBig(quote.volume)],
    [
      "Day range",
      quote?.dayLow == null ? "n/a" : `${fmtMoney(quote.dayLow)} – ${fmtMoney(quote.dayHigh)}`,
    ],
  ];
  return (
    <div className="ab-in border-b border-line bg-surface">
      <div className="mx-auto max-w-[1440px] px-6 py-5 md:px-10">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] font-bold tracking-tight">
            {quote?.name || company?.name || "…"}
          </h1>
          {company?.ticker ? (
            <span className="ab-chip bg-surface-2 text-ink-2">
              {company.ticker}
              {quote?.exchange ? ` · ${quote.exchange}` : ""}
            </span>
          ) : null}
        </div>
        <div className="mt-2 grid gap-6 lg:grid-cols-[minmax(280px,380px)_1fr] lg:items-end">
          <div>
            {quote ? (
              <>
                <div className="flex flex-wrap items-baseline gap-4">
                  <span className="tabular font-mono text-[44px] font-semibold leading-none tracking-tight">
                    {quote.price == null ? "n/a" : fmtMoney(quote.price)}
                  </span>
                  {quote.change != null ? (
                    <span
                      className={`tabular font-mono text-[15px] ${up ? "text-good" : "text-bad"}`}
                    >
                      {up ? "▲" : "▼"} {up ? "+" : ""}
                      {quote.change.toFixed(2)} ({up ? "+" : ""}
                      {quote.changePct.toFixed(2)}%)
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-xs text-ink-3">
                  {quote.asOf
                    ? `As of ${new Date(quote.asOf).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                    : "Quote unavailable"}{" "}
                  · {quote.source || "n/a"}
                </div>
              </>
            ) : (
              <>
                <Skeleton width="60%" />
                <Skeleton width="40%" />
              </>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-7 gap-y-3 sm:grid-cols-3 xl:grid-cols-[repeat(5,auto)_minmax(150px,1fr)]">
            {stats.map(([k, v, title]) => (
              <div key={k}>
                <div className="ab-label">{k}</div>
                <div
                  className="tabular mt-1 whitespace-nowrap font-mono text-[14px]"
                  title={title || undefined}
                >
                  {quote ? v : "…"}
                </div>
              </div>
            ))}
            <div>
              <div className="ab-label">52 week range</div>
              {pos == null ? (
                <div className="mt-1 font-mono text-[15px]">n/a</div>
              ) : (
                <div className="mt-2.5">
                  <div className="relative h-1 rounded bg-line">
                    <div
                      className="absolute left-0 top-0 h-1 rounded bg-accent/60"
                      style={{ width: `${pos}%` }}
                    />
                    <i
                      className="absolute -top-[4px] h-3 w-3 -translate-x-1/2 rounded-full border-2 border-surface bg-accent"
                      style={{ left: `${pos}%` }}
                    />
                  </div>
                  <div className="tabular mt-1.5 flex justify-between gap-2 whitespace-nowrap font-mono text-[10px] text-ink-3">
                    <span>{fmtMoney(quote.week52Low)}</span>
                    <span className="text-ink-3/70">{Math.round(pos)}%</span>
                    <span>{fmtMoney(quote.week52High)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 font-mono text-[11px] text-ink-3">
          Source: {quote?.source || "quote source"} ·{" "}
          {d.marketCap
            ? "Market cap, P/E, and yield derived from price and SEC XBRL facts"
            : "Derived metrics appear when XBRL facts load"}
          {fin?.revenue?.tag ? ` · Tag ${fin.revenue.tag}` : ""}
        </div>
      </div>
    </div>
  );
}

/* ---------- financials chart ---------- */
type Row = { label: string; rev: number | null; ni: number | null; end: string; derived?: boolean };
function FinancialsCard({ fin }: { fin: any }) {
  const [tip, setTip] = useState<{ x: number; y: number; row: Row } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  if (!fin)
    return (
      <Card title="Financial trend · 8 quarters" right={<StatusChip state="queued" />}>
        <Skeleton />
        <Skeleton />
        <Skeleton width="70%" />
      </Card>
    );
  const rev = fin.revenue?.points || [];
  const ni = fin.netIncome?.points || [];
  if (!rev.length)
    return (
      <Card title="Financial trend · 8 quarters">
        <div className="text-xs text-ink-3">
          No quarterly revenue series in XBRL company facts{fin.error ? ": " + fin.error : ""}.
        </div>
      </Card>
    );
  const niMap: Record<string, any> = Object.fromEntries(ni.map((p: any) => [p.frame, p]));
  const rows: Row[] = rev.map((p: any) => ({
    label: p.label,
    rev: p.value,
    ni: niMap[p.frame]?.value ?? null,
    end: p.periodEnd,
    derived: p.derived || niMap[p.frame]?.derived,
  }));
  const W = 720,
    H = 220,
    padL = 60,
    padR = 8,
    padT = 12,
    padB = 30;
  const vals = rows.flatMap((r) => [r.rev, r.ni]).filter((v): v is number => v != null);
  const step = niceStep(Math.max(...vals, 0) - Math.min(...vals, 0), 4);
  const max = Math.ceil(Math.max(...vals, 0) / step) * step;
  const min = Math.floor(Math.min(...vals, 0) / step) * step;
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / (max - min || 1));
  const gw = (W - padL - padR) / rows.length;
  const bw = Math.min(22, gw * 0.3);
  const y0 = y(0);
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
  const last = rows[rows.length - 1]!,
    first = rows[0]!;
  const growth =
    first.rev && last.rev ? Number(((last.rev / first.rev - 1) * 100).toFixed(0)) : null;
  const bar = (r: Row, i: number, v: number | null, x: number, cls: string, name: string) => {
    if (v == null) return null;
    const top = Math.min(y(v), y0),
      h = Math.abs(y(v) - y0);
    return (
      <rect
        key={name + i}
        x={x}
        y={top}
        width={bw}
        height={Math.max(h, 1)}
        rx={3}
        className={cls}
        onMouseMove={(e) => {
          const b = wrapRef.current?.getBoundingClientRect();
          if (!b) return;
          setTip({
            x: Math.min(e.clientX - b.left + 12, b.width - 190),
            y: e.clientY - b.top - 10,
            row: r,
          });
        }}
        onMouseLeave={() => setTip(null)}
      >
        <title>{`${r.label} ${name}: ${fmtUsd(v)}`}</title>
      </rect>
    );
  };
  return (
    <Card title="Financial trend · 8 quarters" right={<StatusChip state="done" />}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
        <div className="text-[15px] font-medium">Revenue and net income, USD</div>
        <div className="flex gap-4 font-mono text-[11px] text-ink-2">
          <span>
            <i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-navy align-[-1px]" />
            Revenue
          </span>
          <span>
            <i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm bg-accent align-[-1px]" />
            Net income
          </span>
        </div>
      </div>
      <div className="relative" ref={wrapRef}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`Revenue and net income, last ${rows.length} quarters`}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y(v)}
                y2={y(v)}
                className="stroke-line"
                strokeWidth={1}
              />
              <text
                x={padL - 8}
                y={y(v) + 4}
                textAnchor="end"
                fontSize={10}
                className="fill-ink-3 font-mono"
              >
                {fmtUsd(v)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const cx = padL + gw * i + gw / 2;
            return (
              <g key={r.label}>
                {bar(r, i, r.rev, cx - bw - 2, "fill-navy", "Revenue")}
                {bar(r, i, r.ni, cx + 2, "fill-accent", "Net income")}
                <text
                  x={cx}
                  y={H - 10}
                  textAnchor="middle"
                  fontSize={10}
                  className="fill-ink-3 font-mono"
                >
                  {r.label.replace(" 20", " '")}
                </text>
              </g>
            );
          })}
          <line x1={padL} x2={W - padR} y1={y0} y2={y0} className="stroke-ink-3" strokeWidth={1} />
        </svg>
        {tip ? (
          <div
            className="pointer-events-none absolute z-[3] whitespace-nowrap rounded-lg border border-line bg-background px-2.5 py-2 text-xs"
            style={{ left: tip.x, top: tip.y }}
          >
            <b>{tip.row.label}</b> · period end {tip.row.end}
            <br />
            Revenue {fmtUsd(tip.row.rev)}
            <br />
            Net income {fmtUsd(tip.row.ni)}
          </div>
        ) : null}
      </div>
      <div className="mt-2 font-mono text-[11px] text-ink-3">
        Source: SEC XBRL company facts API · {fin.revenue.tag},{" "}
        {fin.netIncome?.tag || "NetIncomeLoss"} · Latest {last.label}: revenue {fmtUsd(last.rev)},
        net income {fmtUsd(last.ni)}
        {growth == null
          ? ""
          : ` · Revenue ${growth >= 0 ? "up" : "down"} ${Math.abs(growth)}% vs ${first.label}`}
        {rows.some((r) => r.derived) ? " · Q4 derived as fiscal year minus Q1 to Q3" : ""}
      </div>
    </Card>
  );
}

/* ---------- briefing blocks ---------- */
function Block({
  name,
  block,
  index,
  validation,
  digestMode,
}: {
  name: string;
  block?: BlockEvent | undefined;
  index: Record<string, SectionMeta>;
  validation?: BlockValidation | undefined;
  digestMode: boolean;
}) {
  const title = BLOCK_TITLES[name] ?? block?.title ?? name;
  const d = block?.data ?? null;
  const checks: Record<number, ClaimCheck> = {};
  for (const c of validation?.claims || []) checks[c.index] = c;
  const exclude = validation?.policy?.unsupported === "exclude";
  const hideUnverified = validation?.policy?.unverified === "hide";
  const items: any[] = (name === "summary" ? d?.paragraphs : d?.items) || [];
  const show = (k: number) =>
    !(
      (exclude && checks[k]?.verdict === "unsupported") ||
      (hideUnverified && checks[k]?.verdict === "unverified") ||
      items[k]?.complianceFlags?.length
    );
  const mark = (k: number, item: any) => (
    <div className="mt-1.5">
      <ClaimMark check={checks[k]} flags={item?.complianceFlags} />
    </div>
  );
  const state = blockState(validation, block);
  return (
    <Card
      title={title}
      right={
        <>
          <BlockBadge v={validation} />
          <StatusChip
            state={digestMode && !block ? "queued" : state}
            label={digestMode && !block ? "Not generated" : undefined}
          />
        </>
      }
    >
      {!d ? (
        <>
          <Skeleton />
          <Skeleton width="85%" />
          <Skeleton width="60%" />
        </>
      ) : (
        <>
          {d.error ? <p className="mb-2.5 text-bad">{d.error}</p> : null}
          {name === "summary" &&
            (d.paragraphs || []).map((p: any, i: number) =>
              show(i) ? (
                <div key={i} className="mb-3 last:mb-0">
                  <p className="text-[15px] leading-7">{p.text}</p>
                  {mark(i, p)}
                  <Cites ids={p.citations} index={index} check={checks[i]} />
                </div>
              ) : null,
            )}
          {name === "risks" && (
            <ol className="space-y-3">
              {(d.items || []).map(
                (i: any, k: number) =>
                  show(k) && (
                    <li key={k} className="grid grid-cols-[28px_1fr] gap-3">
                      <span className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 font-mono text-[11px] text-accent">
                        {k + 1}
                      </span>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[15px] font-semibold">{i.title}</span>
                          <span
                            className={`ab-chip ${i.severity === "high" ? "border-bad/50 text-bad" : i.severity === "low" ? "border-good/50 text-good" : "border-warn/50 text-warn"}`}
                          >
                            {i.severity || ""}
                          </span>
                        </div>
                        <div className="text-[13.5px] text-ink-2">{i.text}</div>
                        {mark(k, i)}
                        <Cites ids={i.citations} index={index} check={checks[k]} />
                      </div>
                    </li>
                  ),
              )}
            </ol>
          )}
          {name === "events" &&
            ((d.items || []).length ? (
              <div className="relative ml-2 border-l border-line pl-5">
                {(d.items || []).map(
                  (i: any, k: number) =>
                    show(k) && (
                      <div key={k} className="relative mb-4 last:mb-0">
                        <i className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-accent bg-surface" />
                        <div className="flex flex-wrap items-baseline gap-3">
                          <span className="font-mono text-[12px] text-accent">{i.date}</span>
                          <b className="text-[15px]">{i.headline}</b>
                        </div>
                        <div className="text-[13.5px] text-ink-2">{i.why_it_matters}</div>
                        {mark(k, i)}
                        <Cites ids={i.citations} index={index} check={checks[k]} />
                      </div>
                    ),
                )}
              </div>
            ) : (
              <p className="text-xs text-ink-3">No 8-K filings in the last 90 days.</p>
            ))}
          {name === "questions" &&
            (d.items || []).map((i: any, k: number) =>
              show(k) ? (
                <div
                  key={k}
                  className="mb-3 border-b border-line pb-3 last:mb-0 last:border-b-0 last:pb-0"
                >
                  <p className="text-[15px] font-semibold">{i.question}</p>
                  <p className="mt-1 text-[14px] text-ink-2">{i.answer}</p>
                  {mark(k, i)}
                  <Cites ids={i.citations} index={index} check={checks[k]} />
                </div>
              ) : null,
            )}
          {(name === "what_changed" || name === "talking_points") && (
            <ol className="space-y-2.5">
              {(d.items || []).map(
                (i: any, k: number) =>
                  show(k) && (
                    <li key={k} className="grid grid-cols-[28px_1fr] gap-3">
                      <span className="mt-1 font-mono text-[11px] text-accent">
                        {String(k + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <div className="text-[15px] leading-6">{i.text}</div>
                        {mark(k, i)}
                        <Cites ids={i.citations} index={index} check={checks[k]} />
                      </div>
                    </li>
                  ),
              )}
            </ol>
          )}
          {d.droppedCitations ? (
            <div className="mt-2 text-xs text-ink-3">
              {d.droppedCitations} citation{d.droppedCitations > 1 ? "s" : ""} rejected (not a
              section that was sent).
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function HeldForReview({
  blocks,
  validations,
}: {
  blocks: Record<string, BlockEvent>;
  validations: Record<string, BlockValidation>;
}) {
  const held: Array<{ block: string; text: string; check: ClaimCheck }> = [];
  for (const name of BLOCK_ORDER) {
    const v = validations[name],
      b = blocks[name];
    if (!v || !b) continue;
    const items = (name === "summary" ? b.data?.paragraphs : b.data?.items) || [];
    for (let ch of v.claims || []) {
      const it = items[ch.index];
      if (!it) continue;
      const compliance = it.complianceFlags?.length
        ? `Compliance screen: ${it.complianceFlags.map((f: any) => f.label).join(", ")}. Not shown to the client.`
        : null;
      const heldOut =
        compliance ||
        (ch.verdict === "unsupported" && v.policy?.unsupported === "exclude") ||
        (ch.verdict === "unverified" && v.policy?.unverified === "hide");
      if (!heldOut) continue;
      if (compliance) ch = { ...ch, reason: `${compliance} ${ch.reason}`.trim() };
      const text =
        name === "events"
          ? `${it.headline}. ${it.why_it_matters}`
          : name === "risks"
            ? `${it.title}. ${it.text}`
            : name === "questions"
              ? `${it.question} ${it.answer}`
              : it.text;
      held.push({ block: name, text, check: ch });
    }
  }
  if (!held.length) return null;
  return (
    <Card
      title={`Held for review · ${held.length} claim${held.length > 1 ? "s" : ""} not shown`}
      right={<StatusChip state="held" label="Excluded from the brief" />}
      className="border-bad/40"
    >
      <div className="mb-3 text-xs text-ink-3">
        The validator could not support these claims in the cited filing, the compliance screen
        flagged them, or validation did not run. Each keeps its filing link and fetch time so you
        can check it directly.
      </div>
      {held.map((h, k) => (
        <div key={k} className="mb-3 border-t border-line pt-3 text-[13.5px]">
          <div className="ab-label">{BLOCK_TITLES[h.block]}</div>
          <div className="mt-1 text-ink-2 line-through decoration-bad/60">{h.text}</div>
          <div className="mt-1 text-warn">
            {h.check.verdict === "unverified" ? "Validation did not run for this claim. " : ""}
            {h.check.reason}
          </div>
          {h.check.quote ? (
            <div className="mt-1 text-ink-3">Closest evidence: “{h.check.quote}”</div>
          ) : null}
          {(h.check.sources || []).map((src) => (
            <div key={src.sectionId} className="mt-1 text-xs text-ink-3">
              <a className="ab-cite" href={src.url} target="_blank" rel="noopener">
                {src.form} · {src.item} · {src.filingDate}
              </a>
              <span className="ml-1">
                accession {src.accession} · fetched {fmtStamp(src.fetchedAt)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

/* ---------- filing digest (no model): the safe state ---------- */
function DigestCard({ digest, reason }: { digest: Digest | null; reason: string | null }) {
  if (!digest) return null;
  return (
    <Card
      title="Filing digest · read directly from SEC EDGAR"
      right={<StatusChip state="digest" />}
    >
      <div className="mb-4 rounded-lg border border-line bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">
        {reason ? `${reason} ` : ""}Everything in this section is read straight from SEC EDGAR and
        XBRL, with the filing link and fetch time on every line. Nothing here was written by a
        model.
      </div>
      {digest.facts.length ? (
        <div className="mb-4">
          <div className="ab-label mb-2">Filed figures</div>
          {digest.facts.map((f, i) => (
            <div key={i} className="mb-2.5">
              <div className="text-[15px]">{f.text}</div>
              <div className="font-mono text-[11px] text-ink-3">{f.source}</div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mb-4">
        <div className="ab-label mb-2">8-K filings in the last 90 days</div>
        {digest.events.length ? (
          <div className="relative ml-2 border-l border-line pl-5">
            {digest.events.map((e) => (
              <div key={e.accession} className="relative mb-3 last:mb-0">
                <i className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-accent bg-surface" />
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-[12px] text-accent">{e.date}</span>
                  <span className="text-[15px]">{e.labels.join("; ")}</span>
                </div>
                <a className="ab-cite mt-1" href={e.url} target="_blank" rel="noopener">
                  8-K · Items {e.items.join(", ")} · {e.accession}
                </a>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-ink-3">No 8-K filings in the last 90 days.</div>
        )}
      </div>
      <div>
        <div className="ab-label mb-2">Filing sections fetched</div>
        {digest.sectionsRead.map((x) => (
          <div key={x.id} className="mb-1.5 text-[13px]">
            <a className="ab-cite" href={x.url} target="_blank" rel="noopener">
              {x.id.split("|")[0]} · {x.id.split("|")[2]} · {x.id.split("|")[1]}
            </a>
            <span className="ml-1 font-mono text-[11px] text-ink-3">
              {x.title} · {x.chars.toLocaleString()} chars{x.truncated ? " (truncated)" : ""} ·
              fetched {fmtStamp(x.fetchedAt)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- ask panel: follow up questions with conversation memory ---------- */
function AskPanel({
  ticker,
  session,
  enabled,
  onTurns,
}: {
  ticker: string;
  session: string;
  enabled: boolean;
  onTurns?: (n: number) => void;
}) {
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onTurns?.(turns.filter((t) => t.role === "user").length);
  }, [turns, onTurns]);
  useEffect(() => {
    setTurns([]);
    if (!ticker) return;
    fetch(
      `/api/public/advisor-memory?ticker=${encodeURIComponent(ticker)}&session=${encodeURIComponent(session)}`,
    )
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.turns)) setTurns(j.turns);
      })
      .catch(() => {});
  }, [ticker, session]);
  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setQ("");
    setTurns((t) => [
      ...t,
      { role: "user", content: question },
      { role: "assistant", content: "", pending: true },
    ]);
    try {
      const r = await fetch("/api/public/advisor-ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker, question, session }),
      });
      const j = await r.json();
      const a: AskTurn = r.ok
        ? {
            role: "assistant",
            content: j.answer,
            verdict: j.verdict,
            refused: j.refused,
            sources: j.sources,
            retrieval: j.retrieval,
            guardrails: j.guardrails,
            quote: j.quote,
            quoteFound: j.quoteFound,
            complianceFlags: j.complianceFlags,
            model: j.model,
            provider: j.provider,
          }
        : {
            role: "assistant",
            content: j.error || "The question could not be answered right now.",
            verdict: "unavailable",
          };
      setTurns((t) => [...t.slice(0, -1), a]);
    } catch {
      setTurns((t) => [
        ...t.slice(0, -1),
        {
          role: "assistant",
          content: "The question could not be answered right now.",
          verdict: "unavailable",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };
  const suggestions = [
    "What does management say about supply?",
    "Which customers or segments drive revenue?",
    "What changed in the risk factors?",
    "Should I buy this stock?",
  ];
  const verdictChip = (t: AskTurn) => {
    if (t.refused)
      return (
        <span className="ab-chip border-warn/60 text-warn">
          <Icon name="shield" className="h-3 w-3" /> Guardrail
        </span>
      );
    if (t.verdict === "supported")
      return <span className="ab-chip border-good/50 text-good">Verified in filing</span>;
    if (t.verdict === "review")
      return <span className="ab-chip border-warn/60 text-warn">Review</span>;
    if (t.verdict === "not_in_filings")
      return <span className="ab-chip">Not in the filings read</span>;
    if (t.verdict === "compliance")
      return <span className="ab-chip border-bad/60 text-bad">Compliance review</span>;
    if (t.verdict === "unavailable") return <span className="ab-chip">Unavailable</span>;
    return null;
  };
  return (
    <Card
      title={`Ask about ${ticker} · answers cite the filing`}
      right={
        <span className="ab-chip">
          <Icon name="memory" className="h-3 w-3" /> {turns.filter((t) => t.role === "user").length}{" "}
          in conversation memory
        </span>
      }
    >
      {turns.length ? (
        <div className="mb-3 space-y-3">
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="text-[15px] font-semibold">
                {t.content}
              </div>
            ) : (
              <div key={i} className="rounded-lg border border-line bg-background px-4 py-3">
                {t.pending ? (
                  <>
                    <Skeleton width="80%" />
                    <Skeleton width="55%" />
                  </>
                ) : (
                  <>
                    <div className="text-[14.5px] leading-6">{t.content}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {verdictChip(t)}
                      {t.provider === "gemini" ? (
                        <span
                          className="ab-chip"
                          title="Generated directly with the Google Gemini API"
                        >
                          Gemini ·{" "}
                          {String(t.model || "")
                            .split("/")
                            .pop()}
                        </span>
                      ) : null}
                      {t.retrieval ? (
                        <span className="ab-chip" title="Passages retrieved for this answer">
                          {t.retrieval.hits?.length ?? 0} passages ·{" "}
                          {t.retrieval.mode === "hybrid" ? "vector + lexical" : "lexical"} retrieval
                        </span>
                      ) : null}
                      {t.quote ? (
                        <span className="ab-chip" title={t.quote}>
                          {t.quoteFound ? "quote located" : "quote not located"}
                        </span>
                      ) : null}
                    </div>
                    {t.sources?.length ? (
                      <div className="mt-1.5 flex flex-wrap">
                        {t.sources.map((s) => (
                          <a
                            key={s.id}
                            className="ab-cite"
                            href={s.url}
                            target="_blank"
                            rel="noopener"
                            title={`accession ${s.accession}`}
                          >
                            {s.form} · {s.item} · {s.filingDate}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ),
          )}
        </div>
      ) : (
        <div className="mb-3 text-[13.5px] text-ink-2">
          Follow up questions are answered only from the filings read for this briefing, remembered
          for this session, and checked the same way as the briefing. Recommendations and forecasts
          are declined.
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={!enabled || busy}
          placeholder={
            enabled ? `Ask a question about ${ticker}` : "Questions open once the filings are read"
          }
          aria-label="Question"
          maxLength={600}
          className="flex-1 rounded-lg border border-line bg-background px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-accent disabled:opacity-60"
        />
        <button type="submit" className="ab-btn" disabled={!enabled || busy || !q.trim()}>
          Ask
        </button>
      </form>
      {!turns.length ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={!enabled || busy}
              onClick={() => void ask(s)}
              className="ab-chip hover:border-accent hover:text-ink disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/* ---------- right rail ---------- */
function FilingsCard({ filings, sections }: { filings: any; sections: SectionMeta[] }) {
  if (!filings)
    return (
      <Card title="Filings fetched from SEC EDGAR">
        <Skeleton />
        <Skeleton />
      </Card>
    );
  const rows: Array<{ form: string; f: any }> = [];
  if (filings["10-K"]) rows.push({ form: "10-K", f: filings["10-K"] });
  if (filings["10-Q"]) rows.push({ form: "10-Q", f: filings["10-Q"] });
  for (const f of filings["8-K"] || []) rows.push({ form: "8-K", f });
  const parsed = (acc: string) => sections.filter((s) => s.accession === acc);
  const c = filings.company || {};
  return (
    <Card title="Filings fetched from SEC EDGAR">
      {rows.length ? (
        rows.map(({ form, f }, i) => {
          const p = parsed(f.accession);
          return (
            <div key={form + i} className="mb-2.5 grid grid-cols-[44px_1fr] gap-3 last:mb-0">
              <span className="ab-chip justify-center bg-surface-2 !px-1 text-accent">{form}</span>
              <div>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener"
                  className="text-[13.5px] hover:underline"
                >
                  {form === "8-K"
                    ? `Item${String(f.items || "").includes(",") ? "s" : ""} ${f.items || "current report"}`
                    : form === "10-K"
                      ? `Annual report FY ending ${fmtDate(f.reportDate)}`
                      : `Quarterly report, period ending ${fmtDate(f.reportDate)}`}
                </a>
                <div className="font-mono text-[11px] text-ink-3">
                  {f.filingDate} ·{" "}
                  {p.length ? `Parsed · ${p.map((s) => s.item).join(", ")}` : "Fetched"}
                </div>
              </div>
            </div>
          );
        })
      ) : (
        <div className="text-xs text-ink-3">No filings found.</div>
      )}
      <div className="mt-3 font-mono text-[11px] text-ink-3">
        CIK {c.cik} · {c.sicDescription || ""} · FYE {c.fiscalYearEnd || ""}
      </div>
    </Card>
  );
}

function ValidationCard({
  summary,
  pending,
  filings,
  digestMode,
}: {
  summary: ValidationSummary | null;
  pending: boolean;
  filings: any;
  digestMode: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (digestMode)
    return (
      <Card title="Validation" right={<StatusChip state="digest" label="Digest only" />}>
        <div className="text-[13px] text-ink-2">
          Only deterministic SEC and XBRL content is displayed. Narrative claims are withheld unless
          the independent review completes.
        </div>
      </Card>
    );
  if (!summary)
    return (
      <Card
        title="Validation"
        right={
          <StatusChip
            state={pending ? "live" : "queued"}
            label={pending ? "Checking" : undefined}
          />
        }
      >
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <span className="ab-dot" />
          {pending
            ? "A second model is checking each claim against the cited filing text"
            : "Runs as each section lands"}
        </div>
      </Card>
    );
  const c = summary.counts;
  const headline =
    summary.status === "verified"
      ? "Verified"
      : summary.status === "unsupported"
        ? "Unsupported claims held"
        : summary.status === "review"
          ? "Needs review"
          : "Verification unavailable";
  const tone =
    summary.status === "verified"
      ? "text-good"
      : summary.status === "unsupported"
        ? "text-bad"
        : summary.status === "review"
          ? "text-warn"
          : "text-ink-3";
  const ran = summary.validatorRan !== false && summary.supportedPct != null;
  const docs: Array<{ form: string; url: string; date: string; accession: string }> = [];
  if (filings?.["10-K"])
    docs.push({
      form: "10-K",
      url: filings["10-K"].url,
      date: filings["10-K"].filingDate,
      accession: filings["10-K"].accession,
    });
  if (filings?.["10-Q"])
    docs.push({
      form: "10-Q",
      url: filings["10-Q"].url,
      date: filings["10-Q"].filingDate,
      accession: filings["10-Q"].accession,
    });
  for (const f of filings?.["8-K"] || [])
    docs.push({ form: "8-K", url: f.url, date: f.filingDate, accession: f.accession });
  return (
    <Card title="Validation" right={<StatusChip state="done" />}>
      <div className={`text-[17px] font-semibold ${tone}`}>{headline}</div>
      <div className="mt-0.5 text-[13px] text-ink-2">
        {summary.claims} claims · {c.supported} verified · {summary.flagged} need review ·{" "}
        {summary.excluded} held
      </div>
      {ran ? (
        <>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded bg-surface-2">
            <div className="h-full rounded bg-good" style={{ width: `${summary.supportedPct}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-3">
            <span>{summary.supportedPct}% supported</span>
            <span>
              {summary.figuresChecked
                ? `${summary.figuresMatched}/${summary.figuresChecked} figures found`
                : "no figures to check"}
            </span>
          </div>
        </>
      ) : (
        <div className="mt-3 rounded-lg border border-warn/50 bg-warn/5 px-3 py-2 text-xs text-warn">
          Independent verification did not complete
          {summary.errors?.length ? ` (${summary.errors[0]})` : ""}. Generated claims are withheld
          and the filing digest remains available.
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-[11px]">
        <div>
          <div className="text-ink-3">Validator</div>
          <div className="text-ink">{String(summary.model).split("/").pop()}</div>
        </div>
        <div>
          <div className="text-ink-3">Elapsed</div>
          <div className="text-ink">{secs(summary.elapsedMs)}</div>
        </div>
        <div>
          <div className="text-ink-3">Quotes located</div>
          <div className="text-ink">
            {summary.quotesFound ?? 0} of {summary.claims}
          </div>
        </div>
        <div>
          <div className="text-ink-3">Policy</div>
          <div className="text-ink">unsupported held</div>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-3 text-xs text-ink-2 underline decoration-line underline-offset-2"
      >
        {open ? "Hide" : "Show"} how each claim was checked
      </button>
      {open ? (
        <div className="mt-2 space-y-1.5 text-[12.5px]">
          <div>
            <b>Citation found.</b>{" "}
            <span className="text-ink-2">
              The claim points at a filing section that was actually read.
            </span>
          </div>
          <div>
            <b>Source content checked.</b>{" "}
            <span className="text-ink-2">
              Only the cited text is handed to the validator, never the writer's prompt.
            </span>
          </div>
          <div>
            <b>Numbers match the filing.</b>{" "}
            <span className="text-ink-2">
              Every figure in the claim is searched for in the cited text, allowing for units.
            </span>
          </div>
          <div>
            <b>Source is authoritative.</b>{" "}
            <span className="text-ink-2">
              Each source is the primary document of an SEC EDGAR filing, identified by accession
              number and fetch time.
            </span>
          </div>
          <div>
            <b>Independent reading.</b>{" "}
            <span className="text-ink-2">
              A second model, told to assume the claim may be wrong, returns a verdict plus a
              verbatim quote the server must locate.
            </span>
          </div>
          <div className="ab-label pt-2">SEC documents used</div>
          {docs.map((d) => (
            <div key={d.accession}>
              <a className="ab-cite" href={d.url} target="_blank" rel="noopener">
                {d.form} · {d.date}
              </a>
              <span className="ml-1 font-mono text-[11px] text-ink-3">{d.accession}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function GuardrailsCard({ report, running }: { report: GuardrailReport | null; running: boolean }) {
  return (
    <Card
      title="Guardrails"
      right={
        report ? (
          <StatusChip
            state={report.fired ? "live" : "done"}
            label={report.fired ? `${report.fired} fired` : "All clear"}
          />
        ) : (
          <StatusChip state={running ? "live" : "queued"} label={running ? "Active" : undefined} />
        )
      }
    >
      {report ? (
        <div className="space-y-2">
          {report.checks.map((c) => (
            <div key={c.id} className="grid grid-cols-[14px_1fr] gap-2.5 text-[12.5px]">
              <span
                className={`mt-[5px] h-2 w-2 rounded-full ${c.status === "pass" ? "bg-good" : c.status === "fired" ? "bg-warn" : "bg-line"}`}
              />
              <div>
                <span className="font-medium">{c.label}</span>{" "}
                <span className="text-ink-2">{c.detail}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[13px] text-ink-2">
          Input validation, rate limiting, source text treated as data, citation enforcement, output
          screening, and independent validation run on every briefing. The report lands when the
          briefing completes.
        </div>
      )}
    </Card>
  );
}

function MemoryCard({
  memory,
  index,
  recent,
  conversationTurns,
  onOpen,
}: {
  memory: MemoryInfo | null;
  index: IndexInfo | null;
  recent: RecentBriefing[];
  conversationTurns: number;
  onOpen: (t: string) => void;
}) {
  return (
    <Card
      title="Memory"
      right={
        memory ? (
          <StatusChip
            state={memory.hit ? "done" : "live"}
            label={memory.hit ? "Replayed" : "Remembering"}
          />
        ) : null
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 font-mono text-[11px]">
        <div>
          <div className="text-ink-3">This briefing</div>
          <div className="text-ink">
            {memory
              ? memory.hit
                ? `from memory · ${fmtAge(memory.ageMs ?? 0)}`
                : "generated now, kept 6 h"
              : "…"}
          </div>
        </div>
        <div>
          <div className="text-ink-3">Retrieval index</div>
          <div className="text-ink">
            {index
              ? `${index.chunks} passages · ${index.mode === "hybrid" ? "vectors + lexical" : "lexical"}`
              : "building"}
          </div>
        </div>
        <div>
          <div className="text-ink-3">Embeddings</div>
          <div className="text-ink">{index ? (index.embedModel ?? "not configured") : "…"}</div>
        </div>
        <div>
          <div className="text-ink-3">Conversation</div>
          <div className="text-ink">
            {conversationTurns} turn{conversationTurns === 1 ? "" : "s"} this session
          </div>
        </div>
      </div>
      {recent.length ? (
        <div className="mt-3">
          <div className="ab-label mb-1.5">Recent briefings</div>
          <div className="flex flex-wrap gap-1.5">
            {recent.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => onOpen(r.ticker)}
                className="ab-chip hover:border-accent hover:text-ink"
                title={`${r.name} · ${fmtAge(Date.now() - Date.parse(r.generatedAt))}`}
              >
                {r.ticker} ·{" "}
                {r.summary.status === "verified"
                  ? "verified"
                  : r.summary.status === "unsupported"
                    ? "held"
                    : r.summary.status === "review"
                      ? "review"
                      : "digest"}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function CostCard({
  usage,
  firstBlockMs,
  totalMs,
  digestMode,
}: {
  usage: any;
  firstBlockMs: number | null;
  totalMs: number | null;
  digestMode: boolean;
}) {
  if (digestMode && !usage) return null;
  return (
    <Card title="Cost of this briefing">
      <div className="flex items-baseline gap-2">
        <span className="tabular font-mono text-[30px] font-semibold">
          {usage ? `$${estimateCost(usage).toFixed(2)}` : "…"}
        </span>
        <span className="text-xs text-ink-3">per briefing at list price</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-[11px]">
        <div>
          <div className="text-ink-3">Latency to first block</div>
          <div className="text-ink">{firstBlockMs != null ? secs(firstBlockMs) : "…"}</div>
        </div>
        <div>
          <div className="text-ink-3">Total latency</div>
          <div className="text-ink">{totalMs != null ? secs(totalMs) : "…"}</div>
        </div>
        <div>
          <div className="text-ink-3">Tokens in / out</div>
          <div className="text-ink">
            {usage
              ? `${Number(usage.inputTokens || 0).toLocaleString()} / ${Number(usage.outputTokens || 0).toLocaleString()}`
              : "…"}
          </div>
        </div>
        <div>
          <div className="text-ink-3">Model</div>
          <div className="text-ink">{usage ? String(usage.model).split("/").pop() : "…"}</div>
        </div>
      </div>
    </Card>
  );
}
function estimateCost(u: any) {
  // list price estimate for a flash class model: $0.30 per million input, $2.50 per million output
  return (Number(u.inputTokens || 0) * 0.3 + Number(u.outputTokens || 0) * 2.5) / 1e6;
}

function PipelineCard({ log }: { log: LogRow[] }) {
  return (
    <Card title="Pipeline · live">
      <div className="space-y-1.5">
        {log.map((r, i) => (
          <div
            key={i}
            className="grid grid-cols-[10px_44px_1fr] items-baseline gap-2 text-[12.5px]"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${r.state === "done" ? "bg-good" : r.state === "live" ? "bg-accent" : "border border-ink-3"}`}
            />
            <span className="font-mono text-[11px] text-ink-3">{(r.t / 1000).toFixed(1)}s</span>
            <span className={r.state === "queued" ? "text-ink-3" : ""}>{r.text}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- page ---------- */
function useSession() {
  const [session, setSession] = useState("anon");
  useEffect(() => {
    try {
      let s = localStorage.getItem("ab-session");
      if (!s) {
        s = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        localStorage.setItem("ab-session", s);
      }
      setSession(s);
    } catch {
      /* private mode */
    }
  }, []);
  return session;
}

function AdvisorBrief() {
  const { theme, toggle } = useTheme();
  const session = useSession();
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<{ text: string; state: "" | "done" | "err" }>({
    text: "",
    state: "",
  });
  const [company, setCompany] = useState<any>(null);
  const [quote, setQuote] = useState<any>(null);
  const [fin, setFin] = useState<any>(null);
  const [filings, setFilings] = useState<any>(null);
  const [sections, setSections] = useState<SectionMeta[]>([]);
  const [blocks, setBlocks] = useState<Record<string, BlockEvent>>({});
  const [usage, setUsage] = useState<any>(null);
  const [validations, setValidations] = useState<Record<string, BlockValidation>>({});
  const [vsummary, setVsummary] = useState<ValidationSummary | null>(null);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [researchFailed, setResearchFailed] = useState<string | null>(null);
  const [guardrails, setGuardrails] = useState<GuardrailReport | null>(null);
  const [index, setIndex] = useState<IndexInfo | null>(null);
  const [memory, setMemory] = useState<MemoryInfo | null>(null);
  const [recent, setRecent] = useState<RecentBriefing[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [firstBlockMs, setFirstBlockMs] = useState<number | null>(null);
  const [totalMs, setTotalMs] = useState<number | null>(null);
  const [disclaimer, setDisclaimer] = useState(
    "For internal advisor preparation only. Not investment advice.",
  );
  const [mode, setMode] = useState<"" | "live" | "done" | "digest" | "memory" | "err">("");
  const [conversationTurns, setConversationTurns] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sectionIndex = useMemo(
    () => Object.fromEntries(sections.map((s) => [s.id, s])),
    [sections],
  );

  const loadRecent = useCallback(() => {
    fetch("/api/public/advisor-memory")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.recent)) setRecent(j.recent);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  const start = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setStarted(true);
      setRunning(true);
      setMode("live");
      setCompany(null);
      setQuote(null);
      setFin(null);
      setFilings(null);
      setSections([]);
      setBlocks({});
      setUsage(null);
      setValidations({});
      setVsummary(null);
      setDigest(null);
      setResearchFailed(null);
      setGuardrails(null);
      setIndex(null);
      setMemory(null);
      setLog([]);
      setElapsed(0);
      setFirstBlockMs(null);
      setTotalMs(null);
      setStatus({ text: `Resolving ${q} on SEC EDGAR`, state: "" });
      const t0 = performance.now();
      const at = () => performance.now() - t0;
      const push = (text: string, state: LogRow["state"] = "done") =>
        setLog((l) => [
          ...l.filter((x) => x.state !== "live" || x.text !== text),
          { t: at(), text, state },
        ]);
      const finishLive = (prefix: string, text: string) =>
        setLog((l) =>
          l.map((x) =>
            x.state === "live" && x.text.startsWith(prefix)
              ? { ...x, text, state: "done" as const }
              : x,
          ),
        );
      let blockCount = 0;
      let failureMessage = "";

      const handle = (event: string, data: any) => {
        switch (event) {
          case "resolved":
            setCompany(data);
            setStatus({
              text: `${data.name} (CIK ${data.cik}). Fetching quote, filings, and XBRL facts`,
              state: "",
            });
            push(`Resolved ${data.ticker} to CIK ${String(data.cik).padStart(10, "0")}`);
            if (typeof document !== "undefined") document.title = `${data.ticker} · Advisor Brief`;
            break;
          case "memory":
            setMemory(data);
            if (data.hit) {
              setMode("memory");
              push(`Briefing found in memory (${fmtAge(data.ageMs)}), replaying`);
            }
            break;
          case "filings":
            setFilings(data);
            push(
              `EDGAR submissions feed, ${[data["10-K"], data["10-Q"], ...(data["8-K"] || [])].filter(Boolean).length} filings`,
            );
            break;
          case "quote":
            setQuote(data);
            push(`Quote fetched, ${data.source ? String(data.source).split(" (")[0] : "n/a"}`);
            break;
          case "financials":
            setFin(data);
            push(`XBRL facts, ${data.revenue?.points?.length ?? 0} quarters`);
            break;
          case "sections": {
            setSections(data.sections);
            const chars = data.sections.reduce((a: number, s: any) => a + s.chars, 0);
            push(
              `Sections extracted, ${Math.round(chars / 1000)}k chars in ${secs(data.dataLatencyMs)}`,
            );
            setStatus({
              text: `Read ${data.sections.length} filing sections (${chars.toLocaleString()} characters) in ${secs(data.dataLatencyMs)}`,
              state: "",
            });
            break;
          }
          case "digest":
            setDigest(data);
            break;
          case "index":
            setIndex(data);
            push(
              `Retrieval index, ${data.chunks} passages, ${data.mode === "hybrid" ? "vectors + lexical" : "lexical"}`,
            );
            break;
          case "status":
            setStatus({ text: data.message, state: "" });
            if (/^Reading/.test(data.message)) push("Streaming briefing", "live");
            if (/^Validating/.test(data.message)) push("Validating claims", "live");
            break;
          case "block":
            blockCount++;
            setBlocks((b) => ({ ...b, [data.name]: data }));
            if (blockCount === 1 && data.elapsedMs != null) setFirstBlockMs(data.elapsedMs);
            setLog((l) => {
              const i = l.findIndex((x) => x.state === "live" && x.text.startsWith("Streaming"));
              const row = {
                t: at(),
                text: `Streaming briefing, block ${blockCount} of 6`,
                state: (blockCount >= 6 ? "done" : "live") as LogRow["state"],
              };
              return i >= 0 ? l.map((x, k) => (k === i ? row : x)) : [...l, row];
            });
            if (data.elapsedMs != null)
              setStatus({ text: `${data.title} ready at ${secs(data.elapsedMs)}`, state: "" });
            break;
          case "research_failed": {
            failureMessage = String(data.message || "");
            setResearchFailed(failureMessage);
            setMode("digest");
            push(
              data.code === "validation_unavailable"
                ? "Independent verification unavailable, unverified narrative withheld"
                : data.code === "incomplete_narrative"
                  ? "Narrative briefing incomplete, digest shown"
                  : "Narrative briefing not generated, digest shown",
            );
            break;
          }
          case "validation":
            setValidations((v) => ({ ...v, [data.block]: data }));
            break;
          case "validation_summary":
            setVsummary(data);
            finishLive(
              "Validating",
              `Validation complete, ${data.counts.supported} of ${data.claims} claims verified`,
            );
            setStatus({
              text: `Validation complete: ${data.counts.supported} of ${data.claims} claims verified against the cited filings`,
              state: "",
            });
            break;
          case "guardrails":
            setGuardrails(data);
            push(`Guardrails, ${data.total - data.fired} of ${data.total} clear`);
            break;
          case "usage":
            setUsage(data.data);
            break;
          case "done":
            setDisclaimer(data.disclaimer);
            setTotalMs(data.totalMs);
            setStatus(
              data.researchFailed
                ? {
                    text:
                      failureMessage ||
                      "Filing digest ready. Narrative sections were not generated for this briefing.",
                    state: "done",
                  }
                : {
                    text: `Briefing complete in ${secs(data.totalMs)}${data.fromMemory ? " (from memory)" : ""}`,
                    state: "done",
                  },
            );
            setMode(data.researchFailed ? "digest" : data.fromMemory ? "memory" : "done");
            setRunning(false);
            loadRecent();
            break;
          case "error":
            setStatus({ text: data.message || "Connection lost", state: "err" });
            setMode("err");
            setRunning(false);
            break;
        }
      };

      try {
        const res = await fetch(`/api/public/advisor-brief?q=${encodeURIComponent(q)}`, {
          headers: { accept: "text/event-stream" },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `Request failed (${res.status})`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let event = "message";
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            if (!dataLines.length) continue;
            try {
              handle(event, JSON.parse(dataLines.join("\n")));
            } catch {
              /* ignore a frame that will not parse */
            }
          }
        }
        setRunning(false);
      } catch (e) {
        if (ac.signal.aborted) return;
        setStatus({ text: String((e as Error).message ?? e), state: "err" });
        setMode("err");
        setRunning(false);
      }
    },
    [loadRecent],
  );

  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t");
    if (t) {
      setQuery(t);
      void start(t);
    }
  }, [start]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const digestMode = !!researchFailed;
  const validationPending = Object.keys(validations).length > 0 && !vsummary;
  const modePill =
    mode === "live"
      ? { text: "Live", cls: "border-accent text-accent" }
      : mode === "done"
        ? { text: "Complete", cls: "border-good/60 text-good" }
        : mode === "memory"
          ? { text: "From memory", cls: "border-good/60 text-good" }
          : mode === "digest"
            ? { text: "Digest", cls: "border-line text-ink-2" }
            : mode === "err"
              ? { text: "Error", cls: "border-bad text-bad" }
              : null;
  const askEnabled = sections.length > 0;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] items-center gap-4 px-6 py-3 md:px-10">
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="block h-5 w-1.5 rounded-sm bg-accent" />
            <b className="text-[17px] tracking-tight">Advisor Brief</b>
          </div>
          <form
            autoComplete="off"
            className="relative flex max-w-[620px] flex-1 items-center"
            onSubmit={(e) => {
              e.preventDefault();
              void start(query);
            }}
          >
            <Icon
              name="search"
              className="pointer-events-none absolute left-3.5 h-4 w-4 text-ink-3"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter a ticker or company name"
              aria-label="Ticker or company name"
              className="w-full rounded-lg border border-line bg-background py-2 pl-10 pr-24 font-mono text-[13.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-3 focus:border-accent"
            />
            <div className="absolute right-2 flex items-center gap-2">
              {started ? (
                <span className="hidden font-mono text-[10px] text-ink-3 sm:inline">⌘K</span>
              ) : null}
              <button
                type="submit"
                disabled={running || !query.trim()}
                className="ab-btn !py-1 !px-3 !text-[12px]"
              >
                Brief me
              </button>
            </div>
          </form>
          <div className="ml-auto flex items-center gap-3">
            {modePill ? <span className={`ab-chip ${modePill.cls}`}>{modePill.text}</span> : null}
            <button
              type="button"
              onClick={toggle}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-2 hover:border-accent hover:text-ink"
            >
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
            <span className="hidden lg:inline">
              <Clock />
            </span>
            <span className="hidden h-8 w-8 items-center justify-center rounded-full bg-surface-2 font-mono text-[11px] text-ink-2 md:flex">
              EA
            </span>
          </div>
        </div>
      </header>

      {!started ? (
        <main className="mx-auto max-w-[1440px] px-6 md:px-10">
          <section className="flex min-h-[calc(100vh-140px)] flex-col items-center justify-center py-16 text-center">
            <h1 className="text-[34px] font-bold tracking-tight md:text-[42px]">
              Which stock is the client asking about?
            </h1>
            <p className="mt-2 max-w-[640px] text-[15px] text-ink-2">
              Live quote, latest 10-K, 10-Q and 8-Ks, summarized and cited in about 60 seconds.
            </p>
            <form
              autoComplete="off"
              className="mt-8 flex w-full max-w-[600px] items-center gap-2 rounded-xl border border-accent/70 bg-surface p-2 shadow-lg shadow-black/10"
              onSubmit={(e) => {
                e.preventDefault();
                void start(query);
              }}
            >
              <Icon name="search" className="ml-2 h-5 w-5 text-ink-3" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter a ticker or company name"
                aria-label="Ticker or company name"
                className="flex-1 bg-transparent px-2 py-2 text-[16px] text-ink outline-none placeholder:text-ink-3"
                autoFocus
              />
              <button type="submit" className="ab-btn" disabled={!query.trim()}>
                Brief me
              </button>
            </form>
            <div className="mt-6 text-[12px] text-ink-3">Try one of today's demo names</div>
            <div className="mt-2 grid w-full max-w-[600px] gap-3 sm:grid-cols-2">
              {[
                ["NVDA", "NVIDIA · large cap, clean story"],
                ["ORCL", "Oracle · 8-K filed this quarter"],
                ["BA", "Boeing · risk factors in focus"],
                ["LLY", "Eli Lilly · growth and guidance language"],
              ].map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setQuery(t!);
                    void start(t!);
                  }}
                  className="rounded-lg border border-line bg-surface px-4 py-3 text-left hover:border-accent"
                >
                  <div className="font-mono text-[12px] text-accent">{t}</div>
                  <div className="text-[13px] text-ink-2">{label}</div>
                </button>
              ))}
            </div>
            {recent.length ? (
              <div className="mt-8 w-full max-w-[600px]">
                <div className="ab-label mb-2 text-center">Recent briefings in memory</div>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {recent.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => {
                        setQuery(r.ticker);
                        void start(r.ticker);
                      }}
                      className="ab-chip hover:border-accent hover:text-ink"
                    >
                      {r.ticker} · {fmtAge(Date.now() - Date.parse(r.generatedAt))}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-12 grid max-w-[760px] gap-8 sm:grid-cols-3">
              {[
                [
                  "Sources",
                  "SEC EDGAR filings and market data, with the filing linked on every claim",
                ],
                [
                  "Grounding",
                  "Every sentence cites the section it came from and is checked by a second model",
                ],
                [
                  "Memory and guardrails",
                  "Briefings and follow up questions are remembered; advice and client data are declined",
                ],
              ].map(([h, p]) => (
                <div key={h}>
                  <div className="text-[13px] font-semibold">{h}</div>
                  <div className="mt-1 text-[12.5px] text-ink-3">{p}</div>
                </div>
              ))}
            </div>
          </section>
        </main>
      ) : (
        <>
          <CompanyBand company={company} quote={quote} fin={fin} />
          <main className="mx-auto max-w-[1440px] px-6 pb-12 pt-5 md:px-10">
            <div className="mb-4 flex min-h-[22px] flex-wrap items-center gap-3 text-[13.5px] text-ink-2">
              <span
                className={`ab-dot ${status.state === "done" ? "!animate-none bg-good" : status.state === "err" ? "!animate-none bg-bad" : ""}`}
              />
              <span>{status.text}</span>
              {running ? (
                <span className="font-mono text-[11px] text-ink-3">{elapsed}s</span>
              ) : null}
            </div>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="space-y-5">
                <FinancialsCard fin={fin} />
                {digestMode ? <DigestCard digest={digest} reason={researchFailed} /> : null}
                {!digestMode
                  ? BLOCK_ORDER.map((n) => (
                      <Block
                        key={n}
                        name={n}
                        block={blocks[n]}
                        index={sectionIndex}
                        validation={validations[n]}
                        digestMode={false}
                      />
                    ))
                  : null}
                {!digestMode ? <HeldForReview blocks={blocks} validations={validations} /> : null}
                {company?.ticker ? (
                  <AskPanel
                    ticker={company.ticker}
                    session={session}
                    enabled={askEnabled}
                    onTurns={setConversationTurns}
                  />
                ) : null}
              </div>
              <aside className="space-y-5">
                <FilingsCard filings={filings} sections={sections} />
                <ValidationCard
                  summary={vsummary}
                  pending={validationPending}
                  filings={filings}
                  digestMode={digestMode}
                />
                <GuardrailsCard report={guardrails} running={running} />
                <MemoryCard
                  memory={memory}
                  index={index}
                  recent={recent.filter((r) => r.ticker !== company?.ticker)}
                  conversationTurns={conversationTurns}
                  onOpen={(t) => {
                    setQuery(t);
                    void start(t);
                  }}
                />
                <CostCard
                  usage={usage}
                  firstBlockMs={firstBlockMs}
                  totalMs={totalMs}
                  digestMode={digestMode}
                />
                <PipelineCard log={log} />
              </aside>
            </div>
          </main>
        </>
      )}

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1440px] flex-wrap justify-between gap-4 px-6 py-4 text-[11.5px] text-ink-3 md:px-10">
          <div className="max-w-[900px]">{disclaimer}</div>
          <div className="font-mono">Advisor Brief · Prototype build 0.3</div>
        </div>
      </footer>
    </div>
  );
}
