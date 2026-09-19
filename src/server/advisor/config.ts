// Advisor Brief server configuration. Read once per request from the runtime environment.
//
// Model provider:
//   Gemini (GEMINI_API_KEY): Google AI Studio, OpenAI-compatible endpoint.
// No AI call is routed through a platform gateway or another model vendor.

import { readRuntimeEnv } from "../runtime-env";

export type Provider = {
  name: "gemini";
  chatUrl: string;
  embedUrl: string;
  key: string;
  /** Maps the configured model id to what this provider expects. */
  mapChatModel: (m: string) => string;
  mapEmbedModel: (m: string) => string;
};

export type Cfg = {
  EDGAR_UA: string;
  AI_MODEL: string;
  VALIDATOR_MODEL: string;
  EMBED_MODEL: string;
  VALIDATION_POLICY: "exclude" | "flag";
  UNVERIFIED_POLICY: "flag" | "hide";
  RESEARCH_TIMEOUT_MS: number;
  VALIDATOR_TIMEOUT_MS: number;
  ASK_TIMEOUT_MS: number;
  EMBED_TIMEOUT_MS: number;
  MEMORY_TTL_MS: number;
  RATE_LIMIT_BRIEFS_PER_10M: number;
  RATE_LIMIT_ASKS_PER_10M: number;
  DEBUG_ERRORS: boolean;
  AI_MAX_ATTEMPTS: number;
  AI_CALL_GAP_MS: number;
  ENABLE_EMBEDDINGS: boolean;
  providers: Provider[];
};

export const AI_MODEL_DEFAULT = "gemini-3.8-flash";
export const VALIDATOR_MODEL_DEFAULT = "gemini-3.8-flash";
export const EMBED_MODEL_DEFAULT = "gemini-embedding-001";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const nonNegativeNum = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

const geminiModel = (value: string | undefined, fallback: string) => {
  const model = (value ?? fallback).replace(/^google\//, "");
  return /^(?:openai|anthropic|claude)\//.test(model) || /^(?:gpt-|o\d)/.test(model)
    ? fallback
    : model;
};

export function readEnv(): Cfg {
  const e = readRuntimeEnv();
  const providers: Provider[] = [];
  const geminiKey = [
    e["GEMINI_API_KEY"],
    e["GOOGLE_GENERATIVE_AI_API_KEY"],
    e["GOOGLE_API_KEY"],
  ].find((value) => value?.trim());
  if (geminiKey) {
    const base = (
      e["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta/openai"
    ).replace(/\/$/, "");
    providers.push({
      name: "gemini",
      chatUrl: `${base}/chat/completions`,
      embedUrl: `${base}/embeddings`,
      key: geminiKey,
      mapChatModel: (m) => geminiModel(m, geminiModel(e["GEMINI_MODEL"], AI_MODEL_DEFAULT)),
      mapEmbedModel: (m) =>
        m.startsWith("text-embedding-3") ? EMBED_MODEL_DEFAULT : m.replace(/^google\//, ""),
    });
  }
  return {
    EDGAR_UA: e["EDGAR_USER_AGENT"] ?? "AdvisorBrief public-demo https://aiqorx.com/contact",
    AI_MODEL: geminiModel(e["AI_MODEL"] ?? e["GEMINI_MODEL"], AI_MODEL_DEFAULT),
    VALIDATOR_MODEL: geminiModel(
      e["VALIDATOR_MODEL"] ?? e["GEMINI_MODEL"],
      VALIDATOR_MODEL_DEFAULT,
    ),
    EMBED_MODEL: e["EMBED_MODEL"] ?? EMBED_MODEL_DEFAULT,
    VALIDATION_POLICY: e["VALIDATION_POLICY"] === "flag" ? "flag" : "exclude",
    UNVERIFIED_POLICY: e["UNVERIFIED_POLICY"] === "flag" ? "flag" : "hide",
    RESEARCH_TIMEOUT_MS: num(e["RESEARCH_TIMEOUT_MS"], 120000),
    VALIDATOR_TIMEOUT_MS: num(e["VALIDATOR_TIMEOUT_MS"], 75000),
    ASK_TIMEOUT_MS: num(e["ASK_TIMEOUT_MS"], 60000),
    EMBED_TIMEOUT_MS: num(e["EMBED_TIMEOUT_MS"], 30000),
    MEMORY_TTL_MS: num(e["MEMORY_TTL_MS"], 6 * 3600e3),
    RATE_LIMIT_BRIEFS_PER_10M: num(e["RATE_LIMIT_BRIEFS_PER_10M"], 12),
    RATE_LIMIT_ASKS_PER_10M: num(e["RATE_LIMIT_ASKS_PER_10M"], 40),
    DEBUG_ERRORS: e["DEBUG_ERRORS"] === "1" || e["DEBUG_ERRORS"] === "true",
    AI_MAX_ATTEMPTS: Math.min(5, num(e["AI_MAX_ATTEMPTS"], 4)),
    AI_CALL_GAP_MS: Math.min(5_000, nonNegativeNum(e["AI_CALL_GAP_MS"], 750)),
    ENABLE_EMBEDDINGS: e["ENABLE_EMBEDDINGS"] === "1" || e["ENABLE_EMBEDDINGS"] === "true",
    providers,
  };
}

export const DISCLAIMER =
  "For internal advisor preparation only. Not investment advice, not a recommendation, not for distribution to clients. " +
  "Generated from public SEC filings and market data as of the timestamps shown. Verify against the cited filing before relying on any statement.";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
