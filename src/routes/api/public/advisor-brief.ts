// Advisor Brief: one endpoint that streams a cited stock briefing over Server Sent Events.
// GET /api/public/advisor-brief?q=NVDA[&session=<id>][&fresh=1]
//
// Pipeline (multi agent, see docs/ARCHITECTURE.md):
//   data        SEC EDGAR filings, XBRL company facts, quote adapter, section extraction   (edgar.ts)
//   memory      briefing replay, retrieval index, conversation turns                       (memory.ts)
//   research    one streamed model call writes six cited blocks                            (research.ts)
//   validation  a second model reviews every claim against only the cited text             (validation.ts)
//   guardrails  input, rate, injection, output screening, reported to the UI               (guardrails.ts)
//   retrieval   chunk, embed, index the filings for follow up questions                    (retrieval.ts)
//   digest      no model fallback built from structured data                               (digest.ts)
// Models: Gemini through GEMINI_API_KEY. Nothing routes through a platform gateway or another model vendor.
//
// Events: resolved, filings, quote, financials, sections, digest, memory, status, block, validation,
//         validation_summary, guardrails, index, research_failed, usage, done, error.
import { createFileRoute } from "@tanstack/react-router";
import { CORS, DISCLAIMER, readEnv, type Cfg } from "../../../server/advisor/config";
import { configureEdgar, financials, derived, type Section } from "../../../server/advisor/edgar";
import { loadCompany, loadSections } from "../../../server/advisor/pipeline";
import { BLOCKS, BLOCK_ORDER, Usage, blockHasContent, buildContext, streamBriefing, regenerateBlock } from "../../../server/advisor/research";
import { validateBlock, summarizeValidation, claimItems, claimText, type BlockValidation } from "../../../server/advisor/validation";
import { buildDigest } from "../../../server/advisor/digest";
import { briefGuardrails, clientKey, countInjectionLines, rateLimit, screenText, validateQuery } from "../../../server/advisor/guardrails";
import { buildIndex } from "../../../server/advisor/retrieval";
import { getStore, type BriefingRecord } from "../../../server/advisor/memory";
import { AiUnavailable, clientReason, logAiFailure } from "../../../server/advisor/providers";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

/** Bound independent reads so one briefing cannot burst the model quota with six simultaneous calls. */
function createLimiter(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active--;
    waiting.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

async function handleBrief(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  const cfg: Cfg = readEnv();
  configureEdgar(cfg);
  const url = new URL(request.url);
  const v = validateQuery(url.searchParams.get("q"));
  if (!v.ok) return json(400, { error: v.message });
  const q = v.value;
  const fresh = url.searchParams.get("fresh") === "1";
  const rate = rateLimit(`brief:${clientKey(request)}`, cfg.RATE_LIMIT_BRIEFS_PER_10M);
  if (!rate.ok) return json(429, { error: "Too many briefings in a short time. Try again in a few minutes." });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const recorded: Array<{ event: string; data: unknown }> = [];
      const send = (event: string, data: unknown) => {
        recorded.push({ event, data });
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const t0 = Date.now();
      try {
        const store = await getStore();
        const { company, sel, quote, factsRes, accessions, key } = await loadCompany(q);
        send("resolved", company);

        // Memory hit: the same filings were briefed recently. Replay the stored briefing with a fresh quote.
        const remembered = fresh ? null : await store.getBriefing(key);
        if (remembered) {
          const fin = (factsRes as any).error ? { revenue: { points: [] }, netIncome: { points: [] }, eps: { points: [] }, dividends: { points: [] }, error: (factsRes as any).error } : financials(factsRes);
          (quote as any).derived = derived(quote, fin);
          send("memory", { hit: true, generatedAt: remembered.generatedAt, ageMs: Date.now() - Date.parse(remembered.generatedAt), backend: store.kind });
          for (const ev of remembered.events) {
            if (ev.event === "quote") send("quote", quote);
            else if (ev.event === "financials") send("financials", fin);
            else send(ev.event, ev.data);
          }
          send("done", { totalMs: Date.now() - t0, disclaimer: DISCLAIMER, researchFailed: remembered.summary.researchFailed, fromMemory: true });
          return;
        }
        send("memory", { hit: false, backend: store.kind });

        send("filings", { "10-K": sel["10-K"], "10-Q": sel["10-Q"], "8-K": sel["8-K"], company: sel.company });
        const fin = (factsRes as any).error
          ? { revenue: { points: [] }, netIncome: { points: [] }, eps: { points: [] }, dividends: { points: [] }, error: (factsRes as any).error }
          : financials(factsRes);
        (quote as any).derived = derived(quote, fin);
        send("quote", quote);
        send("financials", fin);

        const sections = await loadSections(sel);
        send("sections", { sections: sections.map(({ text: _t, ...rest }) => rest), dataLatencyMs: Date.now() - t0 });
        send("digest", buildDigest(sel, fin, sections));
        const sectionsChars = sections.reduce((a, s) => a + s.chars, 0);
        const injectionLines = sections.reduce((a, s) => a + countInjectionLines(s.text), 0);

        // Defer retrieval embeddings until the narrative and independent reads are complete so background
        // work cannot starve the advisor-facing Gemini calls.
        const buildRetrievalIndex = async () => {
          try {
            const idx = await buildIndex(cfg, key, sections);
            store.putIndex(idx);
            send("index", { chunks: idx.chunks.length, mode: idx.mode, embedModel: idx.embedModel, provider: idx.provider, buildMs: idx.buildMs });
          } catch (e) {
            console.error(`[advisor-brief] index: ${(e as Error).message}`);
            send("index", { chunks: 0, mode: "lexical", embedModel: null, provider: null, buildMs: 0 });
          }
        };

        let researchFailed = false;
        let validatorRan = false;
        let claims = 0;
        let outputFlags = 0;
        let droppedCitations = 0;
        let narrativeClaims = 0;
        const usableBlocks = new Set<string>();
        const usage = new Usage();

        if (!cfg.providers.length) {
          researchFailed = true;
          const r = clientReason(new AiUnavailable([]), cfg);
          send("research_failed", { message: r.message, code: r.code, attempts: cfg.DEBUG_ERRORS ? ["no provider configured"] : undefined, blocksDelivered: 0 });
        } else {
          const model = cfg.AI_MODEL;
          usage.model = model;
          send("status", { message: `Reading ${sections.length} filing sections with ${model.split("/").pop()} (first block usually lands in 10 to 20 seconds)` });
          const context = buildContext(sections, company);
          const valid = new Set(sections.map((s) => s.id));
          const sectionsById = new Map(sections.map((s) => [s.id, s] as [string, Section]));
          const started = Date.now();

          // Validation agent runs alongside the research stream: each block is reviewed the moment it lands.
          const validations: Promise<BlockValidation>[] = [];
          const limitValidation = createLimiter(2);
          // Output screening (advice, forecast, guarantee, contact language) on every claim before it is sent.
          const screenBlock = (name: string, data: any) => {
            for (const item of claimItems(name, data)) {
              const flags = screenText(claimText(name, item));
              if (flags.length) { item.complianceFlags = flags; outputFlags++; }
            }
            droppedCitations += Number(data?.droppedCitations ?? 0);
          };
          const validateAndSend = (name: string, data: any) => {
            narrativeClaims += claimItems(name, data).length;
            if (blockHasContent({ block: name, ...data })) usableBlocks.add(name);
            send("validation", { block: name, status: "validating" });
            const p = limitValidation(() => validateBlock(cfg, name, data, sectionsById, cfg.VALIDATOR_MODEL, cfg.VALIDATION_POLICY, cfg.UNVERIFIED_POLICY, cfg.VALIDATOR_TIMEOUT_MS))
              .catch((e) => {
                logAiFailure(`validateBlock ${name}`, e);
                return { block: name, status: "unverified", claims: [], counts: { supported: 0, partial: 0, unsupported: 0, uncited: 0, unverified: 0 }, policy: { unsupported: cfg.VALIDATION_POLICY, partial: "flag", uncited: "flag", unverified: cfg.UNVERIFIED_POLICY }, elapsedMs: 0, model: cfg.VALIDATOR_MODEL, error: "the independent reading service did not respond" } as BlockValidation;
              })
              .then((v) => { send("validation", v); return v; });
            validations.push(p);
          };

          let deliveredCount = 0;
          try {
            const delivered = await streamBriefing(cfg, context, valid, usage, model, (name, data) => {
              deliveredCount++;
              screenBlock(name, data);
              send("block", { name, title: BLOCKS[name]!.title, data, elapsedMs: Date.now() - started });
              validateAndSend(name, data);
            }, cfg.RESEARCH_TIMEOUT_MS);
            const missing = BLOCK_ORDER.filter((n) => !delivered.has(n));
            if (missing.length) send("status", { message: `Completing ${missing.length} remaining block${missing.length > 1 ? "s" : ""}` });
            await Promise.all(
              missing.map(async (n) => {
                const data = await regenerateBlock(cfg, context, n, valid, usage, model).catch((e) => { logAiFailure(`regenerate ${n}`, e); return { items: [], error: "This section could not be generated." }; });
                screenBlock(n, data);
                send("block", { name: n, title: BLOCKS[n]!.title, data, elapsedMs: Date.now() - started });
                validateAndSend(n, data);
              }),
            );
          } catch (e) {
            // Safe failure: the digest (already sent) carries the filings, XBRL facts, and 8-K timeline with links
            // and timestamps. The advisor sees a neutral message; the real reason is in the server log.
            researchFailed = true;
            logAiFailure("streamBriefing", e);
            const r = clientReason(e, cfg);
            send("research_failed", { message: r.message, code: r.code, attempts: cfg.DEBUG_ERRORS ? (e as AiUnavailable).attempts ?? [String((e as Error).message)] : undefined, blocksDelivered: deliveredCount });
          }
          if (validations.length) {
            send("status", { message: `Validating claims against the cited filings with ${cfg.VALIDATOR_MODEL.split("/").pop()}` });
            const results = await Promise.all(validations);
            const summary = summarizeValidation(results, started, cfg.VALIDATOR_MODEL);
            validatorRan = summary.validatorRan;
            claims = summary.claims;
            send("validation_summary", summary);
          }
          const incompleteBlocks = BLOCK_ORDER.filter((name) => !usableBlocks.has(name));
          if (!researchFailed && (narrativeClaims === 0 || incompleteBlocks.length > 0)) {
            researchFailed = true;
            send("research_failed", {
              message: narrativeClaims === 0
                ? "The narrative service returned no usable filing-grounded claims. The filing digest is shown instead."
                : `The narrative service did not complete ${incompleteBlocks.length} required section${incompleteBlocks.length === 1 ? "" : "s"}. The completed sections and filing digest are shown.`,
              code: narrativeClaims === 0 ? "empty_narrative" : "incomplete_narrative",
              blocksDelivered: deliveredCount,
              incompleteBlocks,
            });
          }
          if (usage.calls > 0) send("usage", { data: { ...usage.toDict(), elapsedMs: Date.now() - started } });
        }

        await buildRetrievalIndex();
        send("guardrails", briefGuardrails({ query: q, sectionsChars, injectionLines, citationsDropped: droppedCitations, outputFlags, claims, validatorRan, rateRemaining: rate.remaining }));
        send("done", { totalMs: Date.now() - t0, disclaimer: DISCLAIMER, researchFailed, fromMemory: false });

        // Remember the briefing (not the quote, which is refreshed on replay) when the narrative was produced.
        if (!researchFailed) {
          const vs = recorded.find((r) => r.event === "validation_summary")?.data as any;
          const rec: BriefingRecord = {
            key, ticker: company.ticker, name: company.name, cik: company.cik, generatedAt: new Date().toISOString(), accessions,
            events: recorded.filter((r) => !["memory", "done"].includes(r.event)),
            summary: { status: vs?.status ?? null, claims: vs?.claims ?? 0, supported: vs?.counts?.supported ?? 0, researchFailed, price: (quote as any).price ?? null, changePct: (quote as any).changePct ?? null },
          };
          await store.putBriefing(rec, cfg.MEMORY_TTL_MS).catch((e) => console.error(`[advisor-brief] memory: ${(e as Error).message}`));
        }
      } catch (e) {
        console.error(`[advisor-brief] ${(e as Error).message ?? e}`);
        const msg = String((e as Error).message ?? e);
        send("error", { message: /No SEC registrant/.test(msg) ? msg : "The briefing could not be built for this request." });
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
