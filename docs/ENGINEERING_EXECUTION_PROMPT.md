# Engineering execution brief

Use the following prompt to audit, repair, validate, and release Advisor Brief. It is intentionally written as an execution contract rather than a brainstorming request.

---

## Role

Act as the principal engineer and lead Forward Deployed Engineer accountable for the production readiness of a public AI prototype used in a wealth-management demonstration. Work from evidence. Inspect the live system, source, runtime behavior, screenshots, and product deck before changing code. Do not paper over a failed AI path with UI copy.

## Inputs

- Live application: <https://ai-prototype-advisor-brief.lovable.app/>
- GitHub repository: <https://github.com/iamestime/ai-prototype-advisor-brief>
- Product presentation: `docs/Advisor_Brief_Deck.pptx`
- Failure evidence:
  - “The narrative briefing is not configured for this environment yet.”
  - “No narrative claims were generated, so there is nothing to validate.”
  - “The independent reading did not run, so no confidence score is shown.”
  - Follow-up answers must use Gemini directly, not Lovable AI or Claude.

## Mission

Deliver a working, reviewable system in which a new visitor sees dark mode, a briefing produces six filing-grounded narrative blocks, every claim enters independent validation, a genuine evidence-coverage score appears only when that review ran, and follow-up questions are answered by Gemini from retrieved filing passages. Preserve the deterministic SEC/XBRL digest as an honest fallback.

Publish the completed changes to the repository through a normal Git commit and push. Do not use a visual site editor or a Lovable prompt to modify the application. Do not rewrite published Git history.

## Non-negotiable technical decisions

1. **Gemini only.** Research, validation, embeddings, and Q&A must call Google's Gemini API directly from the server. Remove Claude, Lovable AI gateway, and unrelated provider fallbacks. Return model/provider provenance without returning credentials.
2. **Server-only secrets.** Support both Node `process.env` and Cloudflare/Nitro runtime bindings. `GEMINI_API_KEY` must never be embedded in a client bundle, sent to the browser, logged, committed, or named with `VITE_`.
3. **Evidence is the product.** Generated content may cite only section IDs that were actually supplied. Unknown IDs are dropped and reported. Each cited source retains form, item, filing date, accession, SEC URL, fetch time, and character count.
4. **Independent means isolated.** The reviewer receives the claims and cited filing text only, not the writer's full context. It must return a verdict and short verbatim quote. The server, not the model, locates that quote and checks every stated figure.
5. **No false confidence.** Show an evidence-coverage percentage only if the independent reviewer returned usable verdicts. When review fails, mark claims unverified and show no number.
6. **Graceful failure.** SEC filings, XBRL figures, events, provenance, and links remain available when Gemini does not. Never relabel deterministic digest content as generated research.
7. **Dark by default.** First-time visitors start in dark mode. Preserve an explicit saved light preference.

## Investigation sequence

1. Reproduce the live failure with a clean session and record the SSE event sequence from `/api/public/advisor-brief`.
2. Trace one request from the Cloudflare worker entry through configuration, provider selection, research streaming, validation, retrieval, Q&A, memory, and UI state.
3. Verify whether runtime secrets arrive in the worker `env` binding or `process.env`. Treat a mismatch at this boundary as a shared systems fault, not four unrelated feature bugs.
4. Inspect the model stream framing. Test arbitrary chunk boundaries, fenced JSON, pretty-printed JSON, partial objects, retries, empty blocks, and invalid citations.
5. Confirm validation concurrency and embedding work cannot exhaust model quota before advisor-facing work completes.
6. Review all public errors for credential, vendor-account, or billing leakage.

## Required implementation

### Runtime and provider

- Register string runtime bindings at the custom server entry before importing or invoking route handlers.
- Merge runtime bindings over build-time environment values.
- Configure exactly one provider named `gemini`.
- Accept documented Gemini key aliases only where necessary for deployment portability.
- Add bounded retries for network errors, `429`, and `5xx`; honor `Retry-After`; do not retry invalid requests or authentication failures.
- Keep timeouts and maximum attempts configurable and bounded.

### Narrative research

- Produce these blocks in order: `summary`, `what_changed`, `risks`, `events`, `talking_points`, `questions`.
- Parse complete JSON objects by brace depth while respecting quoted strings and escapes. Do not depend on model newlines or transport chunks.
- Reject empty narrative blocks except a legitimately empty recent-events array.
- Regenerate missing blocks individually with structured JSON output.
- If zero usable claims survive, emit an explicit `empty_narrative` failure and do not cache the response as a completed briefing.

### Validation

- Start review as blocks arrive, with a small concurrency limit.
- Check citation existence and authority deterministically.
- Reconcile financial figures across filing unit conventions and normal rounding.
- Require the reviewer's evidence quote to occur in the cited text.
- Hold unsupported claims under the default policy; flag partial and uncited claims.
- Aggregate claims, verdicts, figures, located quotes, held claims, errors, elapsed time, model, and provider.

### Follow-up answers

- Build or reuse a filing index keyed to the same accessions as the briefing.
- Combine lexical BM25 and Gemini embeddings; degrade to lexical retrieval if embeddings fail.
- Give Gemini only the selected passages and recent bounded conversation turns.
- Recheck answer citations, figures, quote, and compliance language on the server.
- Display `Gemini · <model>` with successful model-generated answers.
- Refuse sensitive client identifiers and recommendation/forecast questions before inference.

### Memory

- Cache completed briefings by ticker plus sorted accessions, with a configurable TTL.
- Keep the last 12 conversation turns per browser session and ticker.
- Provide an in-process default and an optional Supabase backend.
- For Supabase, ship an idempotent migration, enable RLS, create no browser-access policy, and use the service role only on the server.

### Interface and documentation

- Preserve the existing information-dense advisor UI and make dark mode the first-run default.
- Rewrite the README as an engineering case study: product thesis, architecture, orchestration, frontend, backend, model stack, data, memory, retrieval, guardrails, failure modes, setup, variables, tests, deployment, public-demo boundary, presentation, and project lead.
- Use accurate Mermaid diagrams rather than decorative architecture claims.
- Identify the project lead only as Estimé Aristomene, Jr., Managing Director, Principal Engineer at AiQorx, and link to <https://aiqorx.com/contact>.
- Do not publish a personal email address.

## Acceptance tests

All of the following must pass before release:

1. `npm test`
2. `npm run test:smoke`
3. `npm run typecheck`
4. `npm run build`
5. A mocked Gemini stream receives two `429` responses, retries, then delivers all six blocks.
6. Pretty-printed, fenced, adjacent, and split JSON objects parse correctly.
7. A runtime-binding key configures Gemini even when it is absent from `process.env`.
8. An OpenAI or Anthropic key alone cannot configure a provider.
9. A briefing with zero usable claims is not recorded as successful.
10. Live smoke test: a clean first visit is dark.
11. Live smoke test: a fresh ticker emits six narrative blocks, a completed validation summary, `validatorRan: true`, and a non-null supported percentage.
12. Live smoke test: a factual follow-up returns Gemini provenance and at least one valid filing source.
13. Live smoke test: “Should I buy this stock?” is refused without a model call.

If a production secret is missing, complete and publish every code-level repair, prove the model path against a local Gemini-compatible test double, and report the exact remaining runtime binding as a release blocker. Never fabricate a successful live result.

## Release report

Return a concise report containing:

- root cause and why it affected narrative, validation, embeddings, and Q&A together;
- implementation summary;
- commit SHA and repository link;
- test commands and results;
- live acceptance results, with any blocked check stated plainly;
- any remaining productionization work that is outside the public-demo scope.

---
