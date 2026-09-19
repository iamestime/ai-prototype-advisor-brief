// Advisor Brief server configuration. Read once per request from the runtime environment.
//
// Model providers, in order of preference:
//   1. Gemini (GEMINI_API_KEY): Google AI Studio, OpenAI compatible endpoint. Default for chat, validation, embeddings.
//   2. OpenAI (OPENAI_API_KEY): optional fallback for chat and embeddings.
// No AI call is ever routed through the Lovable AI gateway. Every model call carries its own key.

export type Provider = {
  name: "gemini" | "openai";
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
  providers: Provider[];
};

export const AI_MODEL_DEFAULT = "gemini-2.5-flash";
export const VALIDATOR_MODEL_DEFAULT = "gemini-2.5-flash";
export const EMBED_MODEL_DEFAULT = "gemini-embedding-001";

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function readEnv(): Cfg {
  const e = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
  const providers: Provider[] = [];
  // GOOGLE_API_KEY is accepted as an alias for GEMINI_API_KEY.
  if (e["GEMINI_API_KEY"] ?? e["GOOGLE_API_KEY"]) {
    const base = (e["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, "");
    providers.push({
      name: "gemini",
      chatUrl: `${base}/chat/completions`,
      embedUrl: `${base}/embeddings`,
      key: e["GEMINI_API_KEY"] ?? e["GOOGLE_API_KEY"]!,
      mapChatModel: (m) => m.replace(/^google\//, "").replace(/^openai\/.*/, e["GEMINI_MODEL"] ?? AI_MODEL_DEFAULT),
      mapEmbedModel: (m) => (m.startsWith("text-embedding-3") ? EMBED_MODEL_DEFAULT : m.replace(/^google\//, "")),
    });
  }
  if (e["OPENAI_API_KEY"]) {
    const base = (e["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1").replace(/\/$/, "");
    providers.push({
      name: "openai",
      chatUrl: `${base}/chat/completions`,
      embedUrl: `${base}/embeddings`,
      key: e["OPENAI_API_KEY"],
      mapChatModel: (m) => (m.startsWith("openai/") ? m.slice(7) : /^gpt|^o\d/.test(m) ? m : e["OPENAI_MODEL"] ?? "gpt-4o-mini"),
      mapEmbedModel: (m) => (m.startsWith("text-embedding-3") ? m : "text-embedding-3-small"),
    });
  }
  return {
    EDGAR_UA: e["EDGAR_USER_AGENT"] ?? "AdvisorBrief prototype contact@example.com",
    AI_MODEL: e["AI_MODEL"] ?? AI_MODEL_DEFAULT,
    VALIDATOR_MODEL: e["VALIDATOR_MODEL"] ?? VALIDATOR_MODEL_DEFAULT,
    EMBED_MODEL: e["EMBED_MODEL"] ?? EMBED_MODEL_DEFAULT,
    VALIDATION_POLICY: e["VALIDATION_POLICY"] === "flag" ? "flag" : "exclude",
    UNVERIFIED_POLICY: e["UNVERIFIED_POLICY"] === "hide" ? "hide" : "flag",
    RESEARCH_TIMEOUT_MS: num(e["RESEARCH_TIMEOUT_MS"], 120000),
    VALIDATOR_TIMEOUT_MS: num(e["VALIDATOR_TIMEOUT_MS"], 45000),
    ASK_TIMEOUT_MS: num(e["ASK_TIMEOUT_MS"], 40000),
    EMBED_TIMEOUT_MS: num(e["EMBED_TIMEOUT_MS"], 30000),
    MEMORY_TTL_MS: num(e["MEMORY_TTL_MS"], 6 * 3600e3),
    RATE_LIMIT_BRIEFS_PER_10M: num(e["RATE_LIMIT_BRIEFS_PER_10M"], 12),
    RATE_LIMIT_ASKS_PER_10M: num(e["RATE_LIMIT_ASKS_PER_10M"], 40),
    DEBUG_ERRORS: e["DEBUG_ERRORS"] === "1" || e["DEBUG_ERRORS"] === "true",
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
