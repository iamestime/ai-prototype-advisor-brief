import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { readEnv } from "../src/server/advisor/config.ts";
import { BLOCK_ORDER, Usage, streamBriefing } from "../src/server/advisor/research.ts";
import { clearRuntimeEnvForTests, setRuntimeEnv } from "../src/server/runtime-env.ts";

test("Gemini transport retries throttling and delivers all six streamed blocks", async (t) => {
  let requests = 0;
  const objects = [
    { block: "summary", paragraphs: [{ text: "The company sells filing-backed products.", citations: ["s1"] }] },
    { block: "what_changed", items: [{ text: "Revenue changed during the period.", citations: ["s1"] }] },
    { block: "risks", items: [{ title: "Supply", severity: "medium", text: "Supply remains a risk.", citations: ["s1"] }] },
    { block: "events", items: [] },
    { block: "talking_points", items: [{ text: "The latest filing describes demand.", citations: ["s1"] }] },
    { block: "questions", items: [{ question: "What changed?", answer: "The filing describes the change.", citations: ["s1"] }] },
  ];
  const modelText = `\`\`\`json\n${objects.map((o) => JSON.stringify(o, null, 2)).join("\n,\n")}\n\`\`\``;

  const server = createServer((req, res) => {
    requests++;
    req.resume();
    if (requests < 3) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { message: "try again" } }));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < modelText.length; i += 41) {
      const content = modelText.slice(i, i + 41);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n`);
    res.end("data: [DONE]\n\n");
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
    AI_MAX_ATTEMPTS: "3",
  });

  const delivered = new Map<string, unknown>();
  const usage = new Usage();
  const result = await streamBriefing(
    readEnv(),
    "<sections />",
    new Set(["s1"]),
    usage,
    "gemini-test",
    (name, data) => delivered.set(name, data),
    2_000,
  );

  assert.equal(requests, 3);
  assert.deepEqual([...result], BLOCK_ORDER);
  assert.equal(delivered.size, 6);
  assert.equal(usage.provider, "gemini");
  assert.equal(usage.input, 100);
  assert.equal(usage.output, 50);
});
