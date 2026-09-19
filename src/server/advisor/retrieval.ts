// Retrieval: chunking, lexical index (BM25), vector index (cosine over provider embeddings), hybrid ranking.
//
// The briefing itself reads whole sections, because six blocks need the full picture. Follow up questions
// ("Ask") retrieve the passages that matter, so the model sees only the evidence for that question and the
// answer can be validated against exactly those passages. Vectors come directly from Gemini using
// gemini-embedding-001; without a configured key, BM25 alone answers and the UI says so. The index is a per
// company object kept in memory (see memory.ts); the same
// shape maps onto pgvector or OpenSearch in production. The public demo defaults to BM25 so embedding
// batches cannot consume the same Gemini quota needed for writing, review, and advisor follow-ups.
import type { Cfg } from "./config";
import type { Section } from "./edgar";
import { embed } from "./providers";

export type Chunk = {
  id: string;
  sectionId: string;
  form: string;
  item: string;
  filingDate: string;
  accession: string;
  url: string;
  fetchedAt: string;
  index: number;
  text: string;
};
export type VectorIndex = {
  key: string;
  chunks: Chunk[];
  vectors: Float32Array[] | null;
  mode: "hybrid" | "lexical";
  embedModel: string | null;
  provider: string | null;
  builtAt: string;
  buildMs: number;
  df: Map<string, number>;
  avgLen: number;
  tokens: string[][];
};

export const CHUNK_CHARS = 900;
export const CHUNK_OVERLAP = 150;

export function chunkSections(sections: Section[]): Chunk[] {
  const out: Chunk[] = [];
  for (const s of sections) {
    const text = s.text;
    let i = 0,
      n = 0;
    while (i < text.length) {
      let end = Math.min(text.length, i + CHUNK_CHARS);
      if (end < text.length) {
        const cut = text.lastIndexOf(". ", end);
        if (cut > i + CHUNK_CHARS * 0.5) end = cut + 1;
      }
      const piece = text.slice(i, end).trim();
      if (piece.length > 40)
        out.push({
          id: `${s.id}#${n}`,
          sectionId: s.id,
          form: s.form,
          item: s.item,
          filingDate: s.filingDate,
          accession: s.accession,
          url: s.url,
          fetchedAt: s.fetchedAt,
          index: n,
          text: piece,
        });
      n++;
      if (end >= text.length) break;
      i = Math.max(end - CHUNK_OVERLAP, i + 1);
    }
  }
  return out;
}

const STOP = new Set(
  "the a an and or of to in for on with by as at from that this is are was were be been it its their our we they has have had not no".split(
    " ",
  ),
);
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$%.\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t) && t.length > 1);
}

export async function buildIndex(cfg: Cfg, key: string, sections: Section[]): Promise<VectorIndex> {
  const t0 = Date.now();
  const chunks = chunkSections(sections);
  const tokens = chunks.map((c) => tokenize(c.text));
  const df = new Map<string, number>();
  for (const ts of tokens) for (const t of new Set(ts)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = tokens.reduce((a, t) => a + t.length, 0) / Math.max(1, tokens.length);
  let vectors: Float32Array[] | null = null;
  let embedModel: string | null = null;
  let provider: string | null = null;
  // Embeddings are explicitly opt-in. A failure on any batch means lexical mode for the whole index
  // (never a partial vector index), and smaller batches keep request payloads predictable.
  if (cfg.providers.length && cfg.ENABLE_EMBEDDINGS) {
    const all: Float32Array[] = [];
    let ok = true;
    for (let i = 0; i < chunks.length && ok; i += 32) {
      const batch = chunks.slice(i, i + 32).map((c) => c.text);
      const r = await embed(cfg, batch, cfg.EMBED_TIMEOUT_MS);
      if (!r || r.vectors.length !== batch.length) {
        ok = false;
        break;
      }
      for (const v of r.vectors) all.push(normalize(Float32Array.from(v)));
      embedModel = r.model;
      provider = r.provider;
    }
    if (ok && all.length === chunks.length) vectors = all;
    else {
      embedModel = null;
      provider = null;
    }
  }
  return {
    key,
    chunks,
    vectors,
    mode: vectors ? "hybrid" : "lexical",
    embedModel,
    provider,
    builtAt: new Date().toISOString(),
    buildMs: Date.now() - t0,
    df,
    avgLen,
    tokens,
  };
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
  return v;
}

function bm25(index: VectorIndex, query: string[]): number[] {
  const N = index.chunks.length,
    k1 = 1.4,
    b = 0.75;
  return index.tokens.map((ts) => {
    if (!ts.length) return 0;
    const tf = new Map<string, number>();
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of query) {
      const f = tf.get(q);
      if (!f) continue;
      const n = index.df.get(q) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * ts.length) / index.avgLen)));
    }
    return score;
  });
}

export type Hit = { chunk: Chunk; score: number; lexical: number; vector: number | null };

export async function search(
  cfg: Cfg,
  index: VectorIndex,
  question: string,
  k = 6,
): Promise<{ hits: Hit[]; mode: "hybrid" | "lexical" }> {
  const lex = bm25(index, tokenize(question));
  const lexMax = Math.max(1e-9, ...lex);
  let vec: number[] | null = null;
  if (index.vectors && cfg.ENABLE_EMBEDDINGS) {
    const r = await embed(cfg, [question], cfg.EMBED_TIMEOUT_MS);
    if (r?.vectors[0]) {
      const q = normalize(Float32Array.from(r.vectors[0]));
      vec = index.vectors.map((v) => {
        let s = 0;
        for (let i = 0; i < v.length; i++) s += v[i]! * q[i]!;
        return s;
      });
    }
  }
  const hits: Hit[] = index.chunks.map((chunk, i) => {
    const lexical = lex[i]! / lexMax;
    const vector = vec ? vec[i]! : null;
    const score = vector == null ? lexical : 0.45 * lexical + 0.55 * Math.max(0, vector);
    return { chunk, score, lexical, vector };
  });
  hits.sort((a, b) => b.score - a.score);
  // keep at most two chunks per section so the evidence covers more than one filing
  const perSection = new Map<string, number>();
  const picked: Hit[] = [];
  for (const h of hits) {
    const n = perSection.get(h.chunk.sectionId) ?? 0;
    if (n >= 2) continue;
    perSection.set(h.chunk.sectionId, n + 1);
    picked.push(h);
    if (picked.length >= k) break;
  }
  return { hits: picked, mode: vec ? "hybrid" : "lexical" };
}
