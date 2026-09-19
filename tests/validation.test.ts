import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { readEnv } from "../src/server/advisor/config.ts";
import type { Section } from "../src/server/advisor/edgar.ts";
import { clearRuntimeEnvForTests, setRuntimeEnv } from "../src/server/runtime-env.ts";
import {
  checkFigures,
  evidenceExcerpt,
  quoteFound,
  validateBriefing,
} from "../src/server/advisor/validation.ts";

test("matches rounded claims to filing tables with stated units", () => {
  const evidence = "Amounts in millions. Revenue for the period was 96,221 compared with 60,922.";
  const result = checkFigures("Revenue was $96.2 billion.", evidence);
  assert.equal(result.checked, 1);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.unmatched, []);
});

test("requires a locatable evidence quote", () => {
  const evidence = "Demand for the data center platform exceeded supply during the quarter.";
  assert.equal(
    quoteFound("Demand for the data center platform exceeded supply during the quarter.", evidence),
    true,
  );
  assert.equal(quoteFound("Management guaranteed unlimited supply next quarter.", evidence), false);
});

test("selects a compact evidence window around the claim language and figures", () => {
  const evidence = `${"Unrelated filing language. ".repeat(200)}Revenue was 96,221 million and demand remained strong during the quarter.${" More unrelated language.".repeat(200)}`;
  const excerpt = evidenceExcerpt(
    "Revenue was $96.2 billion and demand remained strong.",
    evidence,
    1_200,
  );
  assert.ok(excerpt.length <= 1_200);
  assert.match(excerpt, /96,221 million/);
  assert.match(excerpt, /demand remained strong/);
});

test("reviews all briefing blocks in one sequential Gemini request", async (t) => {
  let requests = 0;
  const quote = "Revenue was 100 million and demand remained strong during the quarter.";
  const server = createServer(async (request, response) => {
    requests++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const user = String(body.messages?.at(-1)?.content ?? "");
    const ids = [...user.matchAll(/<review_claim id="([^"]+)"/g)].map((match) => match[1]);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                claims: ids.map((id) => ({
                  id,
                  verdict: "supported",
                  quote,
                  reason: "The cited filing states the claim.",
                })),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    clearRuntimeEnvForTests();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  setRuntimeEnv({
    GEMINI_API_KEY: "test-key",
    GEMINI_BASE_URL: `http://127.0.0.1:${address.port}`,
    AI_MAX_ATTEMPTS: "1",
  });

  const section: Section = {
    id: "10-Q|2026-08-01|Item 2",
    form: "10-Q",
    filingDate: "2026-08-01",
    item: "Item 2",
    title: "Management's Discussion and Analysis",
    text: quote,
    url: "https://www.sec.gov/example",
    chars: quote.length,
    truncated: false,
    accession: "0000000000-26-000001",
    fetchedAt: "2026-09-19T00:00:00.000Z",
    meta: {},
  };
  const blocks = [
    {
      block: "summary",
      data: {
        paragraphs: [
          { text: "Revenue was $100 million and demand remained strong.", citations: [section.id] },
        ],
      },
    },
    {
      block: "risks",
      data: {
        items: [
          {
            title: "Demand",
            severity: "low",
            text: "Demand remained strong during the quarter.",
            citations: [section.id],
          },
        ],
      },
    },
  ];
  const results = await validateBriefing(
    readEnv(),
    blocks,
    new Map([[section.id, section]]),
    "gemini-test",
    "exclude",
    "hide",
    2_000,
  );

  assert.equal(requests, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => result.status),
    ["verified", "verified"],
  );
  assert.ok(results.every((result) => result.provider === "gemini"));
  assert.ok(results.every((result) => result.claims[0]?.quoteFound));
});
