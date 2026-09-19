# Principal engineering execution prompt

Use this prompt to investigate, repair, validate, and release Advisor Brief. It is an engineering acceptance contract, not a request for cosmetic changes.

## Role

Act as the principal engineer and lead Forward Deployed Engineer accountable for a client-facing AI prototype. Work from observed behavior, request traces, source code, and primary documentation. Preserve the product’s strongest constraint: a statement is useful only when the system can show which filing supports it.

## Surfaces to inspect

- Live application: <https://ai-prototype-advisor-brief.lovable.app/>
- Source repository: <https://github.com/iamestime/ai-prototype-advisor-brief>
- Product presentation: `docs/Advisor_Brief_Deck.pptx`
- Required ticker matrix: `LLY`, `BA`, `NVDA`, and `ORCL`
- Observed failures:
  - narrative generation intermittently falls back to the Filing Digest;
  - the independent reader fails and every claim displays an unhelpful validation warning;
  - bad validation results can be replayed from memory;
  - filing-grounded follow-up answers become unavailable after briefing generation;
  - a runtime `.env` file is tracked in a public repository.

Make changes through source control only. Do not edit the application through Lovable or another visual frontend. Publish through a normal GitHub commit without rewriting shared history unless the repository owner explicitly authorizes a credential-remediation history rewrite.

## Outcome

Deliver a dark-first prototype in which each required ticker produces six filing-grounded narrative sections, one isolated independent review covers every claim, a real evidence-coverage score appears, follow-up questions are answered directly by Gemini with filing citations, unsafe questions are refused before inference, and only independently reviewed briefings are cached.

If Gemini is unavailable, fail closed: remove generated claims from the client view and show the deterministic SEC/XBRL Filing Digest. Never leave a completed page covered in “Not validated” labels, and never manufacture a confidence score.

## Engineering principles

1. **Gemini is the only inference provider.** Narrative writing, independent review, optional embeddings, and follow-up answers call Google’s Gemini API directly from the server. Do not route through Lovable AI, Claude, Anthropic, OpenAI, or a platform model gateway.
2. **The server is the trust boundary.** Model credentials may come from encrypted Cloudflare/Nitro runtime bindings or server process variables. A privileged key must never enter a `VITE_` variable, browser bundle, response payload, log, fixture, screenshot, or committed file.
3. **Authority remains with the filing.** Every generated claim may cite only a section ID supplied to the writer. Each source retains form, item, filing date, accession number, SEC URL, fetch time, and source length.
4. **Independent review means a separate context.** The reviewer receives claims and compact excerpts from their cited sections, not the writer’s prompt or uncited sections.
5. **Deterministic checks outrank model assertions.** The server verifies citation IDs, locates the reviewer’s quote in the full filing text, and reconciles figures across filing units and ordinary rounding.
6. **Quota is an architectural constraint.** Do not launch reviewer or embedding calls while a writer stream is open. Reduce provider calls before increasing timeouts.
7. **Memory stores trusted outcomes, not failures.** A brief without a completed independent review is never replayable as a successful result.

## Investigation protocol

1. Reproduce a fresh live briefing and record the Server-Sent Event sequence, block count, provider, validation result, retrieval mode, total time, and any failure code.
2. Trace the Cloudflare worker entry, runtime binding bridge, model configuration, writer, reviewer, retrieval, Q&A, memory, and UI state.
3. Quantify model calls per briefing. Look for concurrent requests, repeated evidence, embedding batches, retry storms, and cache replay of failed states.
4. Distinguish a missing key from quota pressure, invalid payloads, timeouts, and parser failures. Keep provider detail in server logs; give the browser a safe failure category.
5. Inspect the tracked tree and relevant history for runtime files, Gemini keys, Supabase service-role keys, private keys, high-entropy tokens, and personal contact information without printing credential values.
6. Consult primary Gemini documentation for the deployed API surface, structured output, retry behavior, and embedding contracts.

## Required implementation

### Secret hygiene

- Remove `.env` and every live runtime-configuration file from the tracked tree.
- Ignore `.env`, `.env.*`, private keys, and certificate bundles while retaining a value-free `.env.example`.
- Add an automated tracked-tree secret check and execute it in the normal test gate.
- Document the rule that deletion does not revoke a leaked key. If a privileged credential is discovered, stop using it, rotate it at the provider, remove it from the branch, and prepare a coordinated history purge rather than silently force-pushing.
- Confirm that the final repository contains no personal email address. Use only Estimé Aristomene, Jr., Managing Director, Principal Engineer at AiQorx, and <https://aiqorx.com/contact>.

### Runtime and transport

- Capture Cloudflare/Nitro string bindings before route handlers read configuration.
- Resolve only the documented Gemini key aliases and normalize model IDs to Gemini models.
- Retry network errors, `429`, and `5xx` with bounded exponential backoff and `Retry-After` support. Do not retry authentication or invalid-request failures.
- Keep keys out of client-visible diagnostics. Return provider and model provenance only after a successful model result.

### Narrative writer

- Stream `summary`, `what_changed`, `risks`, `events`, `talking_points`, and `questions` in that order.
- Parse top-level JSON objects by brace depth while respecting strings and escapes. Do not rely on newlines or provider chunk boundaries.
- Reject empty required sections and unknown citation IDs.
- Recover missing blocks sequentially. Never launch a fan-out of regeneration calls against the same key.
- Treat zero claims or an incomplete required block set as a failed narrative and do not cache it.

### Independent validation

- Wait for the writer stream to close before starting the reviewer.
- Build one compact review request for the entire briefing. For each claim, select the most relevant windows from only its cited filing sections and preserve the full cited text server-side.
- Require one verdict and one short verbatim evidence quote per claim.
- Validate the quote against the full filing text, reconcile every figure, and hold unsupported claims.
- Report evidence coverage only when at least one usable independent verdict returns. If the reviewer fails completely, switch the interface to digest-only mode and withhold generated claims.
- Never cache or list an entirely unverified briefing in recent memory.

### Retrieval and “Answers cite the filing”

- Build BM25 retrieval from the same accession-keyed filing corpus used for the brief.
- Make Gemini embeddings optional and quota-aware; lexical retrieval must remain a complete, deterministic fallback.
- Send Gemini only the selected passages and a bounded six-turn conversation window.
- Require structured output containing answer, passage citations, a verbatim quote, and answerability.
- Recheck citations, figures, quote location, and compliance language on the server before displaying the answer.
- Show `Gemini · <model>` only on a successful Gemini answer. Do not configure or retain a Lovable AI or Claude route.
- Refuse client identifiers, trade recommendations, price targets, guarantees, and return forecasts before a model call.

### Client experience

- Keep dark mode as the first-visit default and preserve an explicit light preference.
- Stream authoritative market and filing data immediately.
- Use calm operational language. Do not expose quota, billing, credentials, raw provider errors, or a wall of “Not validated” labels.
- On a reviewer outage, show the Filing Digest and state that generated claims were withheld pending verification.
- Keep filing links, accessions, fetch times, validation details, model provenance, retrieval mode, memory state, and guardrail outcomes inspectable.

### README

Rewrite the README as a serious engineering case study suitable for a Forward Deployed Engineer review. Include:

- product thesis and advisor workflow;
- live application, product deck, and execution brief;
- full architecture and request sequence diagrams;
- role-separated orchestration and trust model;
- frontend, backend, runtime, model, SEC/XBRL, market-data, retrieval, and memory stack;
- secret boundary, validation controls, guardrails, graceful degradation, and cache policy;
- local setup, environment contract, APIs, repository map, tests, deployment checks, and productionization boundary;
- an explicit statement that this is a public demonstration exercise, not investment advice or a production compliance system;
- project attribution only to Estimé Aristomene, Jr., Managing Director, Principal Engineer at AiQorx, with <https://aiqorx.com/contact>.

Write like an experienced engineer explaining a real system. Prefer concrete decisions, operating limits, and failure semantics over adjectives.

## Release gates

The release is not complete until all of these pass:

1. `npm run security:secrets`
2. `npm test`
3. `npm run typecheck`
4. `npm run build`
5. `npm run test:smoke`
6. No `.env`, privileged credential, private key, or personal email exists in the tracked tree.
7. A retry test survives two `429` responses and still delivers all six writer blocks.
8. A batching test proves multiple briefing blocks use one independent-review request.
9. A failed reviewer causes digest-only output and is not cached.
10. In a clean browser, dark mode is active before React hydration.
11. Fresh live runs for `LLY`, `BA`, `NVDA`, and `ORCL` each produce six blocks, `validatorRan: true`, Gemini provenance, and a numeric evidence-coverage score.
12. A factual follow-up returns Gemini provenance and at least one valid SEC filing source.
13. “Should I buy this stock?” is refused without model provenance because inference never ran.

Use `npm run test:live` for the four-ticker production matrix after the GitHub-connected deployment has picked up the release commit.

## Release report

Return a concise report with the root cause, security findings, changed architecture, commit SHA, automated results, four-ticker live results, factual Q&A result, recommendation-refusal result, and any deployment propagation still pending. Do not claim the public application passed until the deployed asset and API behavior match the release commit.
