import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Advisor Brief · Perficient prototype" },
      {
        name: "description",
        content:
          "Type a ticker and get a live quote, eight quarters of SEC filed financials, and a cited briefing written from the latest 10-K, 10-Q, and 8-Ks.",
      },
      { property: "og:title", content: "Advisor Brief · Perficient prototype" },
      {
        property: "og:description",
        content:
          "Live quote, eight quarters of filed financials, and a briefing written from the latest 10-K, 10-Q, and 8-Ks. Every sentence cites the filing it came from.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AdvisorBrief,
});

/* ---------- formatting ---------- */
const fmtMoney = (v: number | null | undefined, d = 2) =>
  v == null ? "n/a" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtBig = (v: number | null | undefined): string => {
  if (v == null) return "n/a";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(0) + "M";
  return String(v);
};
const fmtUsd = (v: number | null | undefined) => (v == null ? "n/a" : (v < 0 ? "-$" : "$") + fmtBig(Math.abs(v)));
const fmtPct = (v: number | null | undefined, d = 2) => (v == null ? "n/a" : (v * 100).toFixed(d) + "%");
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
  return isNaN(d.getTime()) ? s : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

type SectionMeta = { id: string; url: string; title: string; chars: number; truncated: boolean };
type BlockEvent = { name: string; title: string; data: any; elapsedMs?: number };

const BLOCK_ORDER = ["summary", "what_changed", "risks", "events", "talking_points", "questions"] as const;
const BLOCK_TITLES: Record<string, string> = {
  summary: "60 second summary",
  what_changed: "What changed since last quarter",
  risks: "Top risks",
  events: "Recent 8-K events",
  talking_points: "Talking points for the client conversation",
  questions: "Questions the client may ask",
};

/* ---------- small pieces ---------- */
function Skeleton({ width }: { width?: string }) {
  return <div className="ab-skeleton" style={width ? { width } : undefined} />;
}

function Card({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <div className="ab-card mt-4 first:mt-0">
      <h2 className="mb-3 flex items-baseline justify-between text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-3">
        <span>{title}</span>
        {meta ? <span className="font-normal normal-case tracking-normal">{meta}</span> : null}
      </h2>
      {children}
    </div>
  );
}

function Cites({ ids, index }: { ids?: string[]; index: Record<string, SectionMeta> }) {
  if (!ids || !ids.length) return null;
  return (
    <div className="-mt-1.5 mb-2">
      {ids.map((id) => {
        const s = index[id];
        const [form, date, item] = id.split("|");
        const label = `${form} · ${item} · ${fmtDate(date)}`;
        if (!s)
          return (
            <span key={id} className="ab-cite" title={id}>
              {label}
            </span>
          );
        return (
          <a
            key={id}
            className="ab-cite"
            href={s.url}
            target="_blank"
            rel="noopener"
            title={`${s.title} (${s.chars.toLocaleString()} chars read${s.truncated ? ", truncated" : ""})`}
          >
            {label}
          </a>
        );
      })}
    </div>
  );
}

/* ---------- quote ---------- */
function QuoteCard({ quote }: { quote: any }) {
  const asOf = quote?.asOf ? "as of " + new Date(quote.asOf).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  if (!quote)
    return (
      <Card title="Quote">
        <Skeleton width="60%" />
        <Skeleton />
        <Skeleton width="80%" />
      </Card>
    );
  const d = quote.derived || {};
  const pe = d.trailingPE ?? quote.trailingPE;
  const mc = d.marketCap ?? quote.marketCap;
  const dy = d.dividendYield ?? (quote.dividendYieldPct != null ? quote.dividendYieldPct / 100 : null);
  let pos: number | null = null;
  if (quote.price && quote.week52Low && quote.week52High && quote.week52High > quote.week52Low)
    pos = Math.min(100, Math.max(0, (100 * (quote.price - quote.week52Low)) / (quote.week52High - quote.week52Low)));

  const rows: Array<[string, React.ReactNode, string?]> = [
    ["Market cap", mc == null ? "n/a" : "$" + fmtBig(mc), d.marketCapBasis],
    ["P/E (GAAP TTM)", pe == null ? "n/a" : Number(pe).toFixed(1)],
    ["Dividend yield (TTM)", dy == null ? "n/a" : fmtPct(dy)],
    ["Volume", quote.volume == null ? "n/a" : fmtBig(quote.volume)],
    ["Day range", quote.dayLow == null ? "n/a" : fmtMoney(quote.dayLow) + " – " + fmtMoney(quote.dayHigh)],
    ["Sector", quote.sector || "n/a"],
  ];

  return (
    <Card title="Quote" meta={asOf}>
      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-[28px] font-bold tracking-[0.5px]">{quote.ticker}</span>
        <span className="text-sm text-ink-2">
          {quote.name || ""}
          {quote.exchange ? " · " + quote.exchange : ""}
        </span>
      </div>
      <div className="tabular mt-1 text-[34px] font-bold">
        {quote.price == null ? "Quote unavailable" : fmtMoney(quote.price)}
        {quote.change == null ? null : (
          <span className={`ml-2.5 text-base font-semibold ${quote.change >= 0 ? "text-good" : "text-bad"}`}>
            {quote.change >= 0 ? "+" : ""}
            {quote.change.toFixed(2)} ({quote.changePct >= 0 ? "+" : ""}
            {quote.changePct.toFixed(2)}%)
          </span>
        )}
      </div>
      {pos == null ? null : (
        <div className="mt-3">
          <div className="relative h-1.5 rounded-[3px] bg-surface-2">
            <i
              className="absolute -top-1 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-surface bg-accent"
              style={{ left: `${pos}%` }}
            />
          </div>
          <div className="tabular mt-1.5 flex justify-between text-xs text-ink-3">
            <span>52w low {fmtMoney(quote.week52Low)}</span>
            <span>52w high {fmtMoney(quote.week52High)}</span>
          </div>
        </div>
      )}
      <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
        {rows.map(([label, value, title]) => (
          <div key={label} className="flex justify-between border-b border-dotted border-line py-[3px]">
            <span className="text-ink-3">{label}</span>
            <span className="tabular" title={title || undefined}>
              {value}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2.5 text-xs text-ink-3">
        Price: {quote.source || "n/a"}
        {quote.stale ? " · STALE, last cached value" : ""}. {d.marketCap ? "Market cap, P/E, and yield computed from price and SEC XBRL facts." : ""}
      </div>
    </Card>
  );
}

/* ---------- financials chart ---------- */
type Row = { label: string; rev: number | null; ni: number | null; end: string; derived?: boolean };

function FinancialsCard({ fin }: { fin: any }) {
  const [tip, setTip] = useState<{ x: number; y: number; row: Row } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  if (!fin)
    return (
      <Card title="Last 8 quarters" meta="SEC XBRL, USD">
        <Skeleton />
        <Skeleton />
      </Card>
    );

  const rev = fin.revenue?.points || [];
  const ni = fin.netIncome?.points || [];
  if (!rev.length)
    return (
      <Card title="Last 8 quarters" meta="SEC XBRL, USD">
        <div className="text-xs text-ink-3">No quarterly revenue series in XBRL company facts{fin.error ? ": " + fin.error : ""}.</div>
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

  const W = 360,
    H = 190,
    padL = 44,
    padR = 8,
    padT = 14,
    padB = 28;
  const vals = rows.flatMap((r) => [r.rev, r.ni]).filter((v): v is number => v != null);
  const step = niceStep(Math.max(...vals, 0) - Math.min(...vals, 0), 4);
  const max = Math.ceil(Math.max(...vals, 0) / step) * step;
  const min = Math.floor(Math.min(...vals, 0) / step) * step;
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / (max - min || 1));
  const gw = (W - padL - padR) / rows.length;
  const bw = Math.min(16, gw * 0.36);
  const y0 = y(0);
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);

  const last = rows[rows.length - 1]!;
  const first = rows[0]!;
  const growth = first.rev && last.rev ? Number(((last.rev / first.rev - 1) * 100).toFixed(0)) : null;

  const bar = (r: Row, i: number, v: number | null, x: number, color: string, name: string) => {
    if (v == null) return null;
    const top = Math.min(y(v), y0);
    const h = Math.abs(y(v) - y0);
    return (
      <rect
        key={name + i}
        x={x}
        y={top}
        width={bw}
        height={Math.max(h, 1)}
        rx={3}
        fill={color}
        onMouseMove={(e) => {
          const b = wrapRef.current?.getBoundingClientRect();
          if (!b) return;
          setTip({ x: Math.min(e.clientX - b.left + 12, b.width - 180), y: e.clientY - b.top - 10, row: r });
        }}
        onMouseLeave={() => setTip(null)}
      >
        <title>{`${r.label} ${name}: ${fmtUsd(v)}`}</title>
      </rect>
    );
  };

  return (
    <Card title="Last 8 quarters" meta="SEC XBRL, USD">
      <div className="mb-2 flex gap-4 text-xs text-ink-2">
        <span>
          <i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-[-1px]" style={{ background: "#3987e5" }} />
          Revenue
        </span>
        <span>
          <i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm align-[-1px]" style={{ background: "#d95926" }} />
          Net income
        </span>
      </div>
      <div className="relative" ref={wrapRef}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Revenue and net income, last ${rows.length} quarters`}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#22304a" strokeWidth={1} />
              <text x={padL - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill="#7c879c">
                {fmtUsd(v)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const cx = padL + gw * i + gw / 2;
            return (
              <g key={r.label}>
                {bar(r, i, r.rev, cx - bw - 1, "#3987e5", "Revenue")}
                {bar(r, i, r.ni, cx + 1, "#d95926", "Net income")}
                <text x={cx} y={H - 10} textAnchor="middle" fontSize={10} fill="#aab4c6">
                  {r.label.replace(" 20", " '")}
                </text>
              </g>
            );
          })}
          <line x1={padL} x2={W - padR} y1={y0} y2={y0} stroke="#7c879c" strokeWidth={1} />
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
      <div className="mt-2.5 text-xs text-ink-3">
        Latest quarter {last.label} (period end {last.end}): revenue {fmtUsd(last.rev)}, net income {fmtUsd(last.ni)}
        {growth == null ? "" : `. Revenue ${growth >= 0 ? "up" : "down"} ${Math.abs(growth)}% versus ${first.label}`}. Calendar quarters from XBRL
        frames{rows.some((r) => r.derived) ? "; Q4 values derived as fiscal year minus Q1 to Q3" : ""}. Tag: {fin.revenue.tag}.
      </div>
    </Card>
  );
}

/* ---------- filings ---------- */
function FilingsCard({ filings }: { filings: any }) {
  if (!filings)
    return (
      <Card title="Filings read">
        <Skeleton />
        <Skeleton />
      </Card>
    );
  const items: Array<{ f: any; form: string }> = [];
  if (filings["10-K"]) items.push({ f: filings["10-K"], form: "10-K" });
  if (filings["10-Q"]) items.push({ f: filings["10-Q"], form: "10-Q" });
  for (const f of filings["8-K"] || []) items.push({ f, form: "8-K" });
  const c = filings.company || {};
  return (
    <Card title="Filings read">
      {items.length ? (
        items.map(({ f, form }, i) => (
          <div key={form + i} className="flex items-baseline gap-2.5 border-b border-line py-1.5 text-[13px] last:border-b-0">
            <span className="min-w-[44px] rounded-[5px] bg-surface-2 px-[7px] py-0.5 text-center font-mono text-xs">{form}</span>
            <a href={f.url} target="_blank" rel="noopener" className="text-ink-2 hover:text-ink hover:underline">
              {form === "8-K"
                ? f.items || "current report"
                : (form === "10-K" ? "Annual report" : "Quarterly report") + (f.reportDate ? " for period ending " + fmtDate(f.reportDate) : "")}
            </a>
            <span className="tabular ml-auto whitespace-nowrap text-ink-3">{fmtDate(f.filingDate)}</span>
          </div>
        ))
      ) : (
        <div className="text-xs text-ink-3">No filings found.</div>
      )}
      <div className="mt-2.5 text-xs text-ink-3">
        CIK {c.cik} · {c.sicDescription || ""} · fiscal year end {c.fiscalYearEnd || ""} · 8-Ks from the last 90 days. Links open the filing on
        sec.gov.
      </div>
    </Card>
  );
}

/* ---------- briefing blocks ---------- */
function Block({ name, block, index }: { name: string; block?: BlockEvent; index: Record<string, SectionMeta> }) {
  const title = block?.title ?? BLOCK_TITLES[name]!;
  const d = block?.data ?? null;
  return (
    <div className="mb-3.5">
      <h3 className="mb-2.5 text-[17px] font-semibold">{title}</h3>
      {!d ? (
        <>
          <Skeleton />
          <Skeleton width="85%" />
          <Skeleton width="70%" />
        </>
      ) : (
        <>
          {d.error ? <p className="mb-2.5 text-bad">{d.error}</p> : null}
          {name === "summary" &&
            (d.paragraphs || []).map((p: any, i: number) => (
              <div key={i}>
                <p className="mb-2.5">{p.text}</p>
                <Cites ids={p.citations} index={index} />
              </div>
            ))}
          {name === "risks" && (
            <ol className="list-decimal pl-5">
              {(d.items || []).map((i: any, k: number) => (
                <li key={k} className="mb-2.5 pl-0.5">
                  <span className="font-semibold">{i.title}</span>
                  <span
                    className={`ml-2 rounded px-[7px] py-px align-[1px] text-[11px] uppercase tracking-[0.8px] ${
                      i.severity === "high"
                        ? "bg-bad/20 text-bad"
                        : i.severity === "low"
                          ? "bg-good/20 text-good"
                          : "bg-warn/20 text-warn"
                    }`}
                  >
                    {i.severity || ""}
                  </span>
                  <div>{i.text}</div>
                  <Cites ids={i.citations} index={index} />
                </li>
              ))}
            </ol>
          )}
          {name === "events" &&
            ((d.items || []).length ? (
              (d.items || []).map((i: any, k: number) => (
                <div key={k} className="grid grid-cols-[96px_1fr] gap-3 border-b border-line py-2 last:border-b-0">
                  <div className="tabular pt-0.5 text-[13px] text-ink-3">{fmtDate(i.date)}</div>
                  <div>
                    <b className="block">{i.headline}</b>
                    <span className="text-ink-2">{i.why_it_matters}</span>
                    <Cites ids={i.citations} index={index} />
                  </div>
                </div>
              ))
            ) : (
              <p className="text-xs text-ink-3">No 8-K filings in the last 90 days.</p>
            ))}
          {name === "questions" &&
            (d.items || []).map((i: any, k: number) => (
              <div key={k}>
                <p className="mb-2.5">
                  <span className="font-semibold">{i.question}</span>
                  <br />
                  {i.answer}
                </p>
                <Cites ids={i.citations} index={index} />
              </div>
            ))}
          {(name === "what_changed" || name === "talking_points") && (
            <ul className="list-disc pl-5">
              {(d.items || []).map((i: any, k: number) => (
                <li key={k} className="mb-2.5 pl-0.5">
                  {i.text}
                  <Cites ids={i.citations} index={index} />
                </li>
              ))}
            </ul>
          )}
          {d.droppedCitations ? (
            <div className="text-xs text-ink-3">
              {d.droppedCitations} citation{d.droppedCitations > 1 ? "s" : ""} rejected by the validator (not a section that was sent).
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ---------- page ---------- */
function AdvisorBrief() {
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<{ text: string; state: "" | "done" | "err" }>({ text: "", state: "" });
  const [quote, setQuote] = useState<any>(null);
  const [fin, setFin] = useState<any>(null);
  const [filings, setFilings] = useState<any>(null);
  const [sectionIndex, setSectionIndex] = useState<Record<string, SectionMeta>>({});
  const [blocks, setBlocks] = useState<Record<string, BlockEvent>>({});
  const [blocksShown, setBlocksShown] = useState(false);
  const [usage, setUsage] = useState<any>(null);
  const [disclaimer, setDisclaimer] = useState("For internal advisor preparation only. Not investment advice.");
  const [pill, setPill] = useState<{ text: string; kind: "" | "live" | "err" }>({ text: "ready", kind: "" });
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setStarted(true);
    setRunning(true);
    setQuote(null);
    setFin(null);
    setFilings(null);
    setSectionIndex({});
    setBlocks({});
    setBlocksShown(false);
    setUsage(null);
    setPill({ text: "streaming", kind: "live" });
    setStatus({ text: `Resolving ${q} on SEC EDGAR`, state: "" });
    const t0 = performance.now();

    const handle = (event: string, data: any) => {
      switch (event) {
        case "resolved":
          setStatus({ text: `${data.name} (CIK ${data.cik}). Fetching quote, filings, and XBRL facts`, state: "" });
          if (typeof document !== "undefined") document.title = `${data.ticker} · Advisor Brief`;
          break;
        case "filings":
          setFilings(data);
          break;
        case "quote":
          setQuote(data);
          break;
        case "financials":
          setFin(data);
          break;
        case "sections": {
          const idx: Record<string, SectionMeta> = {};
          for (const s of data.sections) idx[s.id] = s;
          setSectionIndex(idx);
          setBlocksShown(true);
          const chars = data.sections.reduce((a: number, s: any) => a + s.chars, 0);
          setStatus({
            text: `Read ${data.sections.length} filing sections (${chars.toLocaleString()} characters) in ${(data.dataLatencyMs / 1000).toFixed(1)}s`,
            state: "",
          });
          break;
        }
        case "status":
          setStatus({ text: data.message, state: "" });
          break;
        case "block":
          setBlocksShown(true);
          setBlocks((b) => ({ ...b, [data.name]: data }));
          if (data.elapsedMs != null) setStatus({ text: `${data.title} ready at ${(data.elapsedMs / 1000).toFixed(1)}s`, state: "" });
          break;
        case "usage":
          setUsage(data.data);
          if (data.data?.model) setPill({ text: "Live: " + data.data.model, kind: "live" });
          break;
        case "done":
          setDisclaimer(data.disclaimer);
          setStatus({ text: `Briefing complete in ${((performance.now() - t0) / 1000).toFixed(1)}s`, state: "done" });
          setRunning(false);
          break;
        case "error":
          setStatus({ text: data.message || "Connection lost", state: "err" });
          setPill({ text: "error", kind: "err" });
          setRunning(false);
          break;
      }
    };

    try {
      const res = await fetch(`/api/public/advisor-brief?q=${encodeURIComponent(q)}`, {
        headers: { accept: "text/event-stream" },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
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
      setPill({ text: "error", kind: "err" });
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t");
    if (t) {
      setQuery(t);
      void start(t);
    }
  }, [start]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-[5] flex items-center gap-5 border-b border-line bg-surface px-7 py-4">
        <div className="flex shrink-0 items-baseline gap-2.5 whitespace-nowrap">
          <b className="text-lg tracking-[0.2px]">Advisor Brief</b>
          <span className="text-xs uppercase tracking-[1px] text-ink-3">Perficient prototype</span>
        </div>
        <form
          autoComplete="off"
          className="flex max-w-[560px] flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void start(query);
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ticker or company name, e.g. NVDA or Boeing"
            aria-label="Ticker or company name"
            className="flex-1 rounded-lg border border-line bg-background px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={running}
            className="rounded-lg bg-accent px-4.5 py-2.5 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-50"
          >
            Brief me
          </button>
        </form>
        <span
          className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-xs ${
            pill.kind === "live" ? "border-good text-good" : pill.kind === "err" ? "border-bad text-bad" : "border-line text-ink-2"
          }`}
        >
          {pill.text}
        </span>
      </header>

      <main className="mx-auto grid max-w-[1480px] grid-cols-1 gap-5 px-7 pb-10 pt-5 min-[1000px]:grid-cols-[400px_1fr]">
        {started ? (
          <div className="col-span-full flex min-h-[22px] items-center gap-3 text-sm text-ink-2">
            <span className={`ab-dot ${status.state === "done" ? "!animate-none bg-good" : status.state === "err" ? "!animate-none bg-bad" : ""}`} />
            <span>{status.text}</span>
          </div>
        ) : null}

        {started ? (
          <section>
            <QuoteCard quote={quote} />
            <FinancialsCard fin={fin} />
            <FilingsCard filings={filings} />
          </section>
        ) : null}

        <section className={started ? "" : "col-span-full"}>
          {!started ? (
            <div className="ab-card px-5 py-16 text-center text-ink-2">
              <h1 className="mb-2 text-[28px] font-bold text-ink">Get up to speed on any stock in about a minute.</h1>
              <div>
                Live quote, eight quarters of filed financials, and a briefing written from the latest 10-K, 10-Q, and 8-Ks. Every sentence cites the
                filing it came from.
              </div>
              <div className="mt-4.5 flex flex-wrap justify-center gap-2.5">
                {[
                  ["NVDA", "Try NVDA"],
                  ["BA", "Try Boeing"],
                  ["LLY", "Try Eli Lilly"],
                ].map(([t, label]) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setQuery(t!);
                      void start(t!);
                    }}
                    className="rounded-lg border border-line bg-surface-2 px-4.5 py-2.5 text-sm font-semibold text-ink"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="ab-card">
              {blocksShown ? (
                BLOCK_ORDER.map((n) => <Block key={n} name={n} block={blocks[n]} index={sectionIndex} />)
              ) : (
                <>
                  <Skeleton />
                  <Skeleton width="85%" />
                  <Skeleton width="70%" />
                </>
              )}
            </div>
          )}
        </section>

        {started ? (
          <footer className="col-span-full flex flex-wrap justify-between gap-6 border-t border-line pt-3.5 text-xs text-ink-3">
            <div>{disclaimer}</div>
            <div className="whitespace-nowrap font-mono text-ink-2">
              {usage
                ? [
                    `model ${usage.model}`,
                    `${usage.calls} calls`,
                    `${(usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens).toLocaleString()} in (${usage.cacheReadTokens.toLocaleString()} cached)`,
                    `${usage.outputTokens.toLocaleString()} out`,
                    `est. $${usage.estimatedCostUsd.toFixed(3)}`,
                    `${(usage.elapsedMs / 1000).toFixed(1)}s`,
                  ].join(" · ")
                : ""}
            </div>
          </footer>
        ) : null}
      </main>
    </div>
  );
}
