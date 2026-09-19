import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { readEnv } from "../src/server/advisor/config.ts";
import { clearRuntimeEnvForTests, setRuntimeEnv } from "../src/server/runtime-env.ts";

afterEach(() => clearRuntimeEnvForTests());

test("Cloudflare runtime bindings configure Gemini without exposing a client key", () => {
  setRuntimeEnv({
    GEMINI_API_KEY: "runtime-secret",
    GEMINI_BASE_URL: "https://example.test/gemini",
    AI_MODEL: "gemini-test",
  });

  const cfg = readEnv();
  assert.equal(cfg.providers.length, 1);
  assert.equal(cfg.providers[0]?.name, "gemini");
  assert.equal(cfg.providers[0]?.chatUrl, "https://example.test/gemini/chat/completions");
  assert.equal(cfg.AI_MODEL, "gemini-test");
});

test("an unrelated provider key cannot silently become the model backend", () => {
  setRuntimeEnv({
    GEMINI_API_KEY: "",
    GOOGLE_GENERATIVE_AI_API_KEY: "",
    GOOGLE_API_KEY: "",
    OPENAI_API_KEY: "not-used",
    ANTHROPIC_API_KEY: "not-used",
  });

  assert.equal(readEnv().providers.length, 0);
});
