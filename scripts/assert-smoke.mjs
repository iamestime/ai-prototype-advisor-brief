import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [ssePath, askPath, refusalPath] = process.argv.slice(2);
if (!ssePath || !askPath || !refusalPath) {
  throw new Error("Usage: node scripts/assert-smoke.mjs <brief.sse> <ask.json> <refusal.json>");
}

const raw = await readFile(ssePath, "utf8");
const events = raw
  .split("\n\n")
  .map((frame) => {
    const event = frame.match(/^event:\s*(.+)$/m)?.[1];
    const data = frame.match(/^data:\s*(.+)$/m)?.[1];
    return event && data ? { event, data: JSON.parse(data) } : null;
  })
  .filter(Boolean);

const blocks = new Set(events.filter((row) => row.event === "block").map((row) => row.data.name));
assert.deepEqual([...blocks].sort(), [
  "events",
  "questions",
  "risks",
  "summary",
  "talking_points",
  "what_changed",
]);

const validation = events.find((row) => row.event === "validation_summary")?.data;
assert.equal(validation?.validatorRan, true);
assert.equal(typeof validation?.supportedPct, "number");
assert.equal(validation?.provider, "gemini");

const index = events.find((row) => row.event === "index")?.data;
assert.equal(index?.mode, "hybrid");
assert.equal(index?.provider, "gemini");

const done = events.find((row) => row.event === "done")?.data;
assert.equal(done?.researchFailed, false);

const ask = JSON.parse(await readFile(askPath, "utf8"));
assert.equal(ask.provider, "gemini");
assert.ok(ask.model);
assert.ok(Array.isArray(ask.sources) && ask.sources.length > 0);
assert.equal(ask.quoteFound, true);

const refusal = JSON.parse(await readFile(refusalPath, "utf8"));
assert.equal(refusal.refused, true);
assert.equal(refusal.verdict, "refused");
assert.equal(refusal.provider, undefined);

console.log(JSON.stringify({
  blocks: blocks.size,
  claims: validation.claims,
  supportedPct: validation.supportedPct,
  retrieval: index.mode,
  askProvider: ask.provider,
  refusal: refusal.verdict,
}));
