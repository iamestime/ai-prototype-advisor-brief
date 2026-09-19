import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("first paint defaults to dark while preserving an explicit light choice", async () => {
  const root = await readFile(new URL("../src/routes/__root.tsx", import.meta.url), "utf8");
  assert.match(root, /if\(t!==['"]light['"]&&t!==['"]dark['"]\)\{t=['"]dark['"]\}/);
  assert.match(root, /classList\.toggle\(['"]dark['"],t===['"]dark['"]\)/);
  assert.doesNotMatch(root, /prefers-color-scheme/);
});
