import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContext,
  blockHasContent,
  blockResponseFormat,
  extractJsonObjects,
  tryParseBlock,
  validateCitations,
} from "../src/server/advisor/research.ts";

test("bounds filing sections before sending them to the writer", () => {
  const text = `opening evidence ${"x".repeat(30_000)} closing evidence`;
  const context = buildContext(
    [
      {
        id: "10-Q|2026-01-01|Item 2",
        form: "10-Q",
        filingDate: "2026-01-01",
        item: "Item 2",
        title: "MD&A",
        text,
      } as any,
    ],
    { name: "Example Corp", ticker: "EX", fiscalYearEnd: "1231" } as any,
  );
  assert.ok(context.length < 13_000);
  assert.match(context, /opening evidence/);
  assert.match(context, /closing evidence/);
  assert.match(context, /middle omitted for model-call budget/);
});

test("extracts pretty-printed and adjacent model JSON without relying on newlines", () => {
  const text = `Here is the result:\n\`\`\`json\n{
    "block": "summary",
    "paragraphs": [{"text": "Revenue {and margin} improved.", "citations": ["s1"]}]
  }\n,
  {"block":"risks","items":[{"title":"Supply","text":"Capacity is constrained.","citations":["s2"]}]}\n\`\`\``;

  const result = extractJsonObjects(text);
  assert.equal(result.objects.length, 2);
  assert.equal(tryParseBlock(result.objects[0]!)?.block, "summary");
  assert.equal(tryParseBlock(result.objects[1]!)?.block, "risks");
  assert.equal(result.rest, "");
});

test("targeted regeneration requests a strict Gemini JSON schema", () => {
  const response = blockResponseFormat("questions") as any;
  assert.equal(response.type, "json_schema");
  assert.equal(response.json_schema.strict, true);
  assert.deepEqual(response.json_schema.schema.required, ["block", "items"]);
  assert.deepEqual(response.json_schema.schema.properties.block.enum, ["questions"]);
});

test("retains an incomplete streamed object until its final chunk arrives", () => {
  const first = extractJsonObjects('{"block":"summary","paragraphs":[{"text":"Half');
  assert.equal(first.objects.length, 0);
  assert.ok(first.rest.startsWith("{"));

  const second = extractJsonObjects(first.rest + ' done","citations":["s1"]}]}');
  assert.equal(second.objects.length, 1);
  assert.equal(tryParseBlock(second.objects[0]!)?.block, "summary");
});

test("rejects empty narrative blocks and drops invented citation ids", () => {
  assert.equal(blockHasContent({ block: "summary", paragraphs: [] }), false);
  assert.equal(blockHasContent({ block: "events", items: [] }), true);

  const [block, dropped] = validateCitations(
    { block: "summary", paragraphs: [{ text: "Grounded claim", citations: ["s1", "invented"] }] },
    new Set(["s1"]),
  );
  assert.equal(dropped, 1);
  assert.deepEqual(block.paragraphs[0].citations, ["s1"]);
});
