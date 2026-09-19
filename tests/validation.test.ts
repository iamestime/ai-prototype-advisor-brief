import assert from "node:assert/strict";
import test from "node:test";

import { checkFigures, quoteFound } from "../src/server/advisor/validation.ts";

test("matches rounded claims to filing tables with stated units", () => {
  const evidence = "Amounts in millions. Revenue for the period was 96,221 compared with 60,922.";
  const result = checkFigures("Revenue was $96.2 billion.", evidence);
  assert.equal(result.checked, 1);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.unmatched, []);
});

test("requires a locatable evidence quote", () => {
  const evidence = "Demand for the data center platform exceeded supply during the quarter.";
  assert.equal(quoteFound("Demand for the data center platform exceeded supply during the quarter.", evidence), true);
  assert.equal(quoteFound("Management guaranteed unlimited supply next quarter.", evidence), false);
});
