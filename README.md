# Advisor Brief

Build "Advisor Brief", a lightweight full stack web app. Name the project "AI Prototype". It is a Perficient Forward Deployed Engineering prototype for wealth management advisors: type a ticker, get a live quote, eight quarters of SEC filed financials, and a briefing written by Claude from the latest 10-K, 10-Q, and 8-Ks, with every sentence citing the filing section and linking to sec.gov.

BACKEND (do this first)
1. Enable Lovable Cloud.
2. Create the edge function `advisor-brief` from the attached file `advisor-brief-index.ts`. Use the file contents VERBATIM as supabase/functions/advisor-brief/index.ts. Do not rewrite, simplify, or reformat its logic; it is tested. It is a GET endpoint that takes `?q=TICKER` and streams Server Sent Events (events: resolved, filings, quote, financials, sections, status, block, usage, done, error).
3. In supabase/config.toml set `[functions.advisor-brief] verify_jwt = false` so the browser can call it with the anon key.
4. Add backend secrets: ANTHROPIC_API_KEY (I will paste the value in the secrets prompt), and EDGAR_USER_AGENT with the value "Perficient AdvisorBrief prototype estime.aristomene@gmail.com". Do not use the Lovable AI gateway for this; the function calls Anthropic directly and needs ANTHROPIC_API_KEY.

FRONTEND
Port the attached `reference-ui-index.html` to React + Tailwind as a single page at `/`. Match its layout, dark navy palette, and behavior closely; the attached screenshot `reference-screenshot.png` shows the finished look. Specifically:
- Sticky header: "Advisor Brief" wordmark with a small "Perficient prototype" label, a search input (ticker or company name), a "Brief me" button, and a status pill.
- Empty state with headline "Get up to speed on any stock in about a minute." and three buttons: Try NVDA, Try Boeing, Try Eli Lilly.
- Two column layout (400px left, fluid right; stack under 1000px). Left: Quote card (ticker, name, exchange, price, change with green/red, 52 week range bar, market cap, P/E (GAAP TTM), dividend yield (TTM), volume, day range, sector, and a source line), "Last 8 quarters" card with a grouped bar chart of revenue (blue 3987E5) and net income (orange D95926) drawn as inline SVG with hover tooltip, legend, nice axis ticks, negative values supported, and a caption line; "Filings read" card listing the 10-K, 10-Q, and 8-Ks with links to sec.gov.
- Right: briefing card with six blocks in this order: 60 second summary, What changed since last quarter, Top risks (numbered, with a severity badge high/medium/low), Recent 8-K events (date column plus headline and why it matters), Talking points for the client conversation, Questions the client may ask. Each block shows skeleton loaders until its data arrives. Under every paragraph or item render citation chips: monospace pills "10-K · Item 1A · Feb 25, 2026" that link (new tab) to the section's filing URL, built from the `sections` event (map section id to url, title, chars, truncated). Parse dates like 2026-02-25 as local dates so they do not show one day early.
- A status line above the columns with a pulsing dot and progress messages from the stream, turning green on done and red on error.
- Footer with the compliance disclaimer from the `done` event and a monospace metrics readout from the `usage` event: model, calls, input tokens (with cached count), output tokens, estimated cost, elapsed seconds.
- Streaming: call the edge function with fetch (GET `${SUPABASE_URL}/functions/v1/advisor-brief?q=...` with the `apikey` and `Authorization: Bearer <anon key>` headers), read the body with a ReadableStream reader, and parse SSE frames (`event:` and `data:` lines separated by blank lines) incrementally, dispatching each event to the UI as it arrives. Do not wait for the whole response. Do not use EventSource.
- Derived valuation figures come in `quote.derived` (marketCap, trailingPE, dividendYield, marketCapBasis) and take precedence over any quote level figure. Show "n/a" when missing. Format money as $219.57, big numbers as 5.29T / 96.2B / 78M, negatives as -$444M.
- Support `?t=NVDA` in the URL to auto run.
- No authentication, no database tables, no extra pages. Keep it to one page and one edge function.

QUALITY BAR
Bloomberg terminal feel, not a generic SaaS template. No gradients, no emojis, no marketing copy. American English. Copy text from the reference HTML exactly where it exists (disclaimer, block titles, labels).

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://ai-prototype-advisor-brief.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/e45ddee1-73fb-4548-b736-75aab40cd667).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
