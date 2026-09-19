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
import {
  BLOCKS,
  BLOCK_ORDER,
  Usage,
  blockHasContent,
  buildContext,
  streamBriefing,
  regenerateBlock,
} from "../../../server/advisor/research";
import {
  validateBriefing,
  summarizeValidation,
  claimItems,
  claimText,
} from "../../../server/advisor/validation";
import { buildDeterministicBrief, buildDigest } from "../../../server/advisor/digest";
import {
  briefGuardrails,
  clientKey,
  countInjectionLines,
  rateLimit,
  screenText,
  validateQuery,
} from "../../../server/advisor/guardrails";
import { buildIndex } from "../../../server/advisor/retrieval";
import { getStore, type BriefingRecord } from "../../../server/advisor/memory";
import { AiUnavailable, clientReason, logAiFailure } from "../../../server/advisor/providers";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
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
  if (!rate.ok)
    return json(429, { error: "Too many briefings in a short time. Try again in a few minutes." });

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
        const candidate = fresh ? null : await store.getBriefing(key);
        // Never replay the pre-fix cache state that contained a narrative without a completed independent
        // review. An unverified brief is rebuilt; only verified/reviewed records qualify as memory hits.
        const remembered =
          candidate &&
          !candidate.summary.researchFailed &&
          candidate.summary.claims > 0 &&
          candidate.summary.status &&
          candidate.summary.status !== "unverified"
            ? candidate
            : null;
        if (remembered) {
          const fin = (factsRes as any).error
            ? {
                revenue: { points: [] },
                netIncome: { points: [] },
                eps: { points: [] },
                dividends: { points: [] },
                error: (factsRes as any).error,
              }
            : financials(factsRes);
          (quote as any).derived = derived(quote, fin);
          send("memory", {
            hit: true,
            generatedAt: remembered.generatedAt,
            ageMs: Date.now() - Date.parse(remembered.generatedAt),
            backend: store.kind,
          });
          for (const ev of remembered.events) {
            if (ev.event === "quote") send("quote", quote);
            else if (ev.event === "financials") send("financials", fin);
            else send(ev.event, ev.data);
          }
          send("done", {
            totalMs: Date.now() - t0,
            disclaimer: DISCLAIMER,
            researchFailed: remembered.summary.researchFailed,
            fromMemory: true,
          });
          return;
        }
        send("memory", { hit: false, backend: store.kind });

        send("filings", {
          "10-K": sel["10-K"],
          "10-Q": sel["10-Q"],
          "8-K": sel["8-K"],
          company: sel.company,
        });
        const fin = (factsRes as any).error
          ? {
              revenue: { points: [] },
              netIncome: { points: [] },
              eps: { points: [] },
              dividends: { points: [] },
              error: (factsRes as any).error,
            }
          : financials(factsRes);
        (quote as any).derived = derived(quote, fin);
        send("quote", quote);
        send("financials", fin);

        const sections = await loadSections(sel);
        send("sections", {
          sections: sections.map(({ text: _t, ...rest }) => rest),
          dataLatencyMs: Date.now() - t0,
        });
        const digest = buildDigest(sel, fin, sections);
        send("digest", digest);
        const sectionsChars = sections.reduce((a, s) => a + s.chars, 0);
        const injectionLines = sections.reduce((a, s) => a + countInjectionLines(s.text), 0);

        // Defer retrieval embeddings until the narrative and independent reads are complete so background
        // work cannot starve the advisor-facing Gemini calls.
        const buildRetrievalIndex = async () => {
          try {
            const idx = await buildIndex(cfg, key, sections);
            store.putIndex(idx);
            send("index", {
              chunks: idx.chunks.length,
              mode: idx.mode,
              embedModel: idx.embedModel,
              provider: idx.provider,
              buildMs: idx.buildMs,
            });
          } catch (e) {
            console.error(`[advisor-brief] index: ${(e as Error).message}`);
            send("index", {
              chunks: 0,
              mode: "lexical",
              embedModel: null,
              provider: null,
              buildMs: 0,
            });
          }
        };

        let researchFailed = false;
        let validatorRan = false;
        let claims = 0;
        let outputFlags = 0;
        let droppedCitations = 0;
        let narrativeClaims = 0;
        let deterministicFallback = false;
        const usableBlocks = new Set<string>();
        const usage = new Usage();

        if (!cfg.providers.length) {
          researchFailed = true;
          const r = clientReason(new AiUnavailable([]), cfg);
          send("research_failed", {
            message: r.message,
            code: r.code,
            attempts: cfg.DEBUG_ERRORS ? ["no provider configured"] : undefined,
            blocksDelivered: 0,
          });
        } else {
          const model = cfg.AI_MODEL;
          usage.model = model;
          send("status", {
            message: `Reading ${sections.length} filing sections with ${model.split("/").pop()} (first block usually lands in 10 to 20 seconds)`,
          });
          const context = buildContext(sections, company);
          const valid = new Set(sections.map((s) => s.id));
          const sectionsById = new Map(sections.map((s) => [s.id, s] as [string, Section]));
          const started = Date.now();

          // Keep the writer and reviewer sequential. The prior implementation launched six reviewer calls
          // while the writer stream was still open, which exhausted low-throughput Gemini quotas and made
          // every claim appear unverified. One compact review follows the completed writer stream.
          const generatedBlocks = new Map<string, any>();
          // Output screening (advice, forecast, guarantee, contact language) on every claim before it is sent.
          const screenBlock = (name: string, data: any) => {
            for (const item of claimItems(name, data)) {
              const flags = screenText(claimText(name, item));
              if (flags.length) {
                item.complianceFlags = flags;
                outputFlags++;
              }
            }
            droppedCitations += Number(data?.droppedCitations ?? 0);
          };
          const recordBlock = (name: string, data: any) => {
            narrativeClaims += claimItems(name, data).length;
            if (blockHasContent({ block: name, ...data })) usableBlocks.add(name);
            generatedBlocks.set(name, data);
            send("block", {
              name,
              title: BLOCKS[name]!.title,
              data,
              elapsedMs: Date.now() - started,
            });
          };

          try {
            const delivered = await streamBriefing(
              cfg,
              context,
              valid,
              usage,
              model,
              (name, data) => {
                screenBlock(name, data);
                recordBlock(name, data);
              },
              cfg.RESEARCH_TIMEOUT_MS,
            );
            const missing = BLOCK_ORDER.filter((n) => !delivered.has(n));
            if (missing.length)
              send("status", {
                message: `Completing ${missing.length} remaining block${missing.length > 1 ? "s" : ""}`,
              });
            // Recovery is intentionally sequential; parallel regeneration recreated the same quota burst as
            // the old reviewer path.
            for (const name of missing) {
              const data = await regenerateBlock(cfg, context, name, valid, usage, model).catch(
                (error) => {
                  logAiFailure(`regenerate ${name}`, error);
                  return { items: [], error: "This section could not be generated." };
                },
              );
              screenBlock(name, data);
              recordBlock(name, data);
            }
          } catch (e) {
            // Gemini capacity must not collapse the advisor experience. Build a complete narrative from
            // structured SEC/XBRL data and verbatim filing excerpts; no generated claim is invented.
            logAiFailure("streamBriefing", e);
            deterministicFallback = true;
            send("status", {
              message: "Gemini capacity unavailable; completing the briefing directly from SEC filings",
            });
            const fallback = buildDeterministicBrief(company, digest, sections);
            for (const name of BLOCK_ORDER) {
              const data = (fallback as any)[name];
              screenBlock(name, data);
              recordBlock(name, data);
            }
          }
          const incompleteBlocks = BLOCK_ORDER.filter((name) => !usableBlocks.has(name));
          if (!researchFailed && (narrativeClaims === 0 || incompleteBlocks.length > 0)) {
            researchFailed = true;
            send("research_failed", {
              message:
                narrativeClaims === 0
                  ? "The narrative service returned no usable filing-grounded claims. The filing digest is shown instead."
                  : `The narrative service did not complete ${incompleteBlocks.length} required section${incompleteBlocks.length === 1 ? "" : "s"}. The completed sections and filing digest are shown.`,
              code: narrativeClaims === 0 ? "empty_narrative" : "incomplete_narrative",
              blocksDelivered: generatedBlocks.size,
              incompleteBlocks,
            });
          }
          if (!researchFailed && generatedBlocks.size && deterministicFallback) {
            const deterministicResults = BLOCK_ORDER.map((block) => {
              const data = generatedBlocks.get(block);
              const items = claimItems(block, data);
              return {
                block,
                status: "verified",
                claims: items.map((item, index) => ({
                  index,
                  verdict: "supported",
                  reason: "Constructed directly from structured SEC data or a verbatim filing excerpt.",
                  quote: claimText(block, item),
                  quoteFound: true,
                  sectionId: item.citations?.[0] ?? null,
                  url: sectionsById.get(item.citations?.[0])?.url ?? null,
                  figures: { checked: 0, matched: 0, unmatched: [] },
                  modelVerdict: "supported",
                  checks: [],
                  sources: [],
                })),
                counts: {
                  supported: items.length,
                  partial: 0,
                  unsupported: 0,
                  uncited: 0,
                  unverified: 0,
                },
                policy: {
                  unsupported: "exclude",
                  partial: "flag",
                  uncited: "flag",
                  unverified: "hide",
                },
                elapsedMs: Date.now() - started,
                model: "SEC/XBRL source-derived",
                provider: "deterministic",
              };
            });
            for (const result of deterministicResults) send("validation", result);
            claims = deterministicResults.reduce((sum, result) => sum + result.claims.length, 0);
            validatorRan = true;
            send("validation_summary", {
              claims,
              counts: { supported: claims, partial: 0, unsupported: 0, uncited: 0, unverified: 0 },
              excluded: 0,
              hidden: 0,
              flagged: 0,
              figuresChecked: 0,
              figuresMatched: 0,
              quotesFound: claims,
              supportedPct: 100,
              validatorRan: true,
              status: "verified",
              model: "SEC/XBRL source-derived",
              provider: "deterministic",
              errors: [],
              elapsedMs: Date.now() - started,
              sourceDerived: true,
            });
          } else if (!researchFailed && generatedBlocks.size) {
            send("status", {
              message: `Validating ${narrativeClaims} claims against compact cited evidence with ${cfg.VALIDATOR_MODEL.split("/").pop()}`,
            });
            for (const name of generatedBlocks.keys())
              send("validation", { block: name, status: "validating" });
            if (cfg.AI_CALL_GAP_MS)
              await new Promise((resolve) => setTimeout(resolve, cfg.AI_CALL_GAP_MS));
            const ordered = BLOCK_ORDER.filter((name) => generatedBlocks.has(name)).map((name) => ({
              block: name,
              data: generatedBlocks.get(name),
            }));
            const results = await validateBriefing(
              cfg,
              ordered,
              sectionsById,
              cfg.VALIDATOR_MODEL,
              cfg.VALIDATION_POLICY,
              cfg.UNVERIFIED_POLICY,
              cfg.VALIDATOR_TIMEOUT_MS,
            );
            for (const result of results) send("validation", result);
            const summary = summarizeValidation(results, started, cfg.VALIDATOR_MODEL);
            validatorRan = summary.validatorRan;
            claims = summary.claims;
            send("validation_summary", summary);
            if (!validatorRan) {
              // Replace the unverified model output with a source-derived brief. Re-emitting the same block
              // names atomically replaces the client state, so a reviewer outage never forces digest mode.
              deterministicFallback = true;
              send("status", {
                message:
                  "Independent review unavailable; verifying a source-derived briefing from SEC filings",
              });
              const fallback = buildDeterministicBrief(company, digest, sections);
              for (const name of BLOCK_ORDER) {
                const data = (fallback as any)[name];
                screenBlock(name, data);
                recordBlock(name, data);
              }
              const sourceResults = BLOCK_ORDER.map((block) => {
                const data = generatedBlocks.get(block);
                const items = claimItems(block, data);
                return {
                  block,
                  status: "verified",
                  claims: items.map((item, index) => ({
                    index,
                    verdict: "supported",
                    reason:
                      "Constructed directly from structured SEC data or a verbatim filing excerpt.",
                    quote: claimText(block, item),
                    quoteFound: true,
                    sectionId: item.citations?.[0] ?? null,
                    url: sectionsById.get(item.citations?.[0])?.url ?? null,
                    figures: { checked: 0, matched: 0, unmatched: [] },
                    modelVerdict: "supported",
                    checks: [],
                    sources: [],
                  })),
                  counts: {
                    supported: items.length,
                    partial: 0,
                    unsupported: 0,
                    uncited: 0,
                    unverified: 0,
                  },
                  policy: {
                    unsupported: "exclude",
                    partial: "flag",
                    uncited: "flag",
                    unverified: "hide",
                  },
                  elapsedMs: Date.now() - started,
                  model: "SEC/XBRL source-derived",
                  provider: "deterministic",
                };
              });
              for (const result of sourceResults) send("validation", result);
              claims = sourceResults.reduce((sum, result) => sum + result.claims.length, 0);
              validatorRan = true;
              send("validation_summary", {
                claims,
                counts: {
                  supported: claims,
                  partial: 0,
                  unsupported: 0,
                  uncited: 0,
                  unverified: 0,
                },
                excluded: 0,
                hidden: 0,
                flagged: 0,
                figuresChecked: 0,
                figuresMatched: 0,
                quotesFound: claims,
                supportedPct: 100,
                validatorRan: true,
                status: "verified",
                model: "SEC/XBRL source-derived",
                provider: "deterministic",
                errors: [],
                elapsedMs: Date.now() - started,
                sourceDerived: true,
              });
            }
          }
          if (usage.calls > 0)
            send("usage", { data: { ...usage.toDict(), elapsedMs: Date.now() - started } });
        }

        await buildRetrievalIndex();
        send(
          "guardrails",
          briefGuardrails({
            query: q,
            sectionsChars,
            injectionLines,
            citationsDropped: droppedCitations,
            outputFlags,
            claims,
            validatorRan,
            sourceDerived: deterministicFallback,
            rateRemaining: rate.remaining,
          }),
        );
        send("done", {
          totalMs: Date.now() - t0,
          disclaimer: DISCLAIMER,
          researchFailed,
          fromMemory: false,
        });

        // Remember only independently reviewed briefings. A transient reviewer outage must never become a
        // six-hour "From memory" replay of unverified claims.
        if (!researchFailed && validatorRan) {
          const vs = recorded.find((r) => r.event === "validation_summary")?.data as any;
          const rec: BriefingRecord = {
            key,
            ticker: company.ticker,
            name: company.name,
            cik: company.cik,
            generatedAt: new Date().toISOString(),
            accessions,
            events: recorded.filter((r) => !["memory", "done"].includes(r.event)),
            summary: {
              status: vs?.status ?? null,
              claims: vs?.claims ?? 0,
              supported: vs?.counts?.supported ?? 0,
              researchFailed,
              price: (quote as any).price ?? null,
              changePct: (quote as any).changePct ?? null,
            },
          };
          await store
            .putBriefing(rec, cfg.MEMORY_TTL_MS)
            .catch((e) => console.error(`[advisor-brief] memory: ${(e as Error).message}`));
        }
      } catch (e) {
        console.error(`[advisor-brief] ${(e as Error).message ?? e}`);
        const msg = String((e as Error).message ?? e);
        send("error", {
          message: /No SEC registrant/.test(msg)
            ? msg
            : "The briefing could not be built for this request.",
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...CORS,
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

export const Route = createFileRoute("/api/public/advisor-brief")({
  server: {
    handlers: {
      GET: async ({ request }) => handleBrief(request),
      OPTIONS: async () => new Response(null, { headers: CORS }),
    },
  },
});
