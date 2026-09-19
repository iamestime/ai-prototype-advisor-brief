import assert from "node:assert/strict";
import test from "node:test";

import { buildDeterministicBrief } from "../src/server/advisor/digest.ts";

test("builds all six cited narrative blocks when Gemini is unavailable", () => {
  const sections = [
    {
      id: "10-Q|2026-08-26|Item 2",
      form: "10-Q",
      filingDate: "2026-08-26",
      item: "Item 2",
      title: "MD&A",
      text: "Revenue was $96.2 billion for the quarter.",
      url: "https://www.sec.gov/example",
    },
    {
      id: "10-K|2026-02-25|Item 1A",
      form: "10-K",
      filingDate: "2026-02-25",
      item: "Item 1A",
      title: "Risk Factors",
      text: "Supply constraints could affect our ability to meet customer demand and may adversely affect operating results.",
      url: "https://www.sec.gov/risk",
    },
  ] as any;
  const brief = buildDeterministicBrief(
    { name: "NVIDIA CORP", ticker: "NVDA" },
    {
      facts: [
        {
          text: "Revenue $96.2B for Q2 FY27, up 18% from Q1 FY27.",
          source: "SEC XBRL",
        },
      ],
      events: [],
    },
    sections,
  );
  assert.deepEqual(Object.keys(brief), [
    "summary",
    "what_changed",
    "risks",
    "events",
    "talking_points",
    "questions",
  ]);
  assert.equal(brief.summary.sourceMode, "deterministic");
  assert.ok(brief.summary.paragraphs.every((item) => item.citations.length > 0));
  assert.ok(brief.risks.items.length > 0);
  assert.match(brief.what_changed.items[0]!.text, /Revenue \$96\.2B/);
});
