import { estimateTextTokens } from '$core/ai/context/context-budget';
import { querySemanticIndex, getSemanticDefaults, getSemanticStatus, type SemanticSnippetCandidate } from '$core/ai/retrieval/semantic-index';

export interface HybridSemanticSnippet {
  lane: 'query' | 'touched';
  path: string;
  title: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  source: 'disk';
  timestamp: number;
  stale: false;
  textHash: string;
}

export interface HybridRetrievalResult {
  snippets: HybridSemanticSnippet[];
  semanticCandidates: number;
  semanticSelected: number;
  hybridDropped: number;
  semanticQueryMs: number;
  semanticIndexStalenessMs: number;
  semanticBackend: string;
  semanticModelLoadMs: number;
  semanticLastError?: string;
}

interface BuildHybridInput {
  rootPath: string;
  query: string;
  touchedPaths: string[];
  activePath?: string;
  diagnosticsPaths?: string[];
  maxSelected?: number;
}

const MIN_SEMANTIC_CONFIDENCE = 0.18;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function lexicalSignal(text: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const lower = text.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const t of tokens) {
    if (lower.includes(t)) hits += 1;
  }
  if (tokens.length === 0) return 0;
  return hits / tokens.length;
}

export function scoreHybridSnippet(params: {
  lexicalScore: number;
  semanticScore: number;
  isTouched: boolean;
  isActive: boolean;
  isDiagnostics: boolean;
}): number {
  const A = 0.45;
  const B = 0.55;
  const touchedBoost = params.isTouched ? 0.16 : 0;
  const activeBoost = params.isActive ? 0.18 : 0;
  const diagnosticsBoost = params.isDiagnostics ? 0.1 : 0;
  return params.lexicalScore * A + params.semanticScore * B + touchedBoost + activeBoost + diagnosticsBoost;
}

export async function buildHybridSemanticSnippets(input: BuildHybridInput): Promise<HybridRetrievalResult> {
  const query = input.query.trim();
  if (!query || !input.rootPath) {
    return {
      snippets: [],
      semanticCandidates: 0,
      semanticSelected: 0,
      hybridDropped: 0,
      semanticQueryMs: 0,
      semanticIndexStalenessMs: 0,
      semanticBackend: 'disabled',
      semanticModelLoadMs: 0,
    };
  }

  const defaults = getSemanticDefaults();
  const topK = Math.max(defaults.topK, input.maxSelected ?? defaults.maxSelected);
  const laneCap = input.maxSelected ?? defaults.maxSelected;

  const result = await querySemanticIndex(input.rootPath, query, { topK, laneCap });
  const status = await getSemanticStatus(input.rootPath);
  if (!result || !result.semanticEnabled) {
    return {
      snippets: [],
      semanticCandidates: 0,
      semanticSelected: 0,
      hybridDropped: 0,
      semanticQueryMs: 0,
      semanticIndexStalenessMs: status?.staleMs ?? 0,
      semanticBackend: status?.backend ?? 'disabled',
      semanticModelLoadMs: status?.modelLoadMs ?? 0,
      semanticLastError: status?.lastError ?? undefined,
    };
  }

  const touched = new Set(input.touchedPaths.map((p) => normalizePath(p)));
  const diagnostics = new Set((input.diagnosticsPaths ?? []).map((p) => normalizePath(p)));
  const active = input.activePath ? normalizePath(input.activePath) : null;

  const deduped = new Map<string, SemanticSnippetCandidate>();
  for (const candidate of result.candidates) {
    const key = `${normalizePath(candidate.relativePath)}:${candidate.startLine}:${candidate.endLine}:${candidate.textHash}`;
    const current = deduped.get(key);
    if (!current || candidate.combinedScore > current.combinedScore) {
      deduped.set(key, candidate);
    }
  }

  const scored: HybridSemanticSnippet[] = [];
  const now = Date.now();
  for (const c of deduped.values()) {
    const rel = normalizePath(c.relativePath);
    const isTouched = touched.has(rel);
    const isActive = active ? rel === active : false;
    const isDiagnostics = diagnostics.has(rel);
    const lexicalScore = Math.max(c.lexicalScore, lexicalSignal(c.text, query));
    const semanticScore = Math.max(0, c.semanticScore);
    if (semanticScore < MIN_SEMANTIC_CONFIDENCE) {
      continue;
    }
    const hybridScore = scoreHybridSnippet({
      lexicalScore,
      semanticScore,
      isTouched,
      isActive,
      isDiagnostics,
    });

    scored.push({
      lane: isTouched ? 'touched' : 'query',
      path: rel,
      title: isTouched ? `Semantic touched evidence (${rel})` : `Semantic query evidence (${rel})`,
      content: c.text,
      startLine: c.startLine,
      endLine: c.endLine,
      score: Number((hybridScore * 100).toFixed(2)),
      source: 'disk',
      timestamp: now,
      stale: false,
      textHash: c.textHash,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const perFileLimit = 2;
  const selected: HybridSemanticSnippet[] = [];
  const perFileCounts = new Map<string, number>();
  let dropped = 0;

  for (const snippet of scored) {
    if (selected.length >= laneCap) {
      dropped += 1;
      continue;
    }

    const fileCount = perFileCounts.get(snippet.path) ?? 0;
    if (fileCount >= perFileLimit) {
      dropped += 1;
      continue;
    }

    if (estimateTextTokens(snippet.content) <= 0) {
      dropped += 1;
      continue;
    }

    selected.push(snippet);
    perFileCounts.set(snippet.path, fileCount + 1);
  }

  return {
    snippets: selected,
    semanticCandidates: result.totalCandidates,
    semanticSelected: selected.length,
    hybridDropped: dropped,
    semanticQueryMs: result.queryMs,
    semanticIndexStalenessMs: status?.staleMs ?? 0,
    semanticBackend: result.backend || status?.backend || 'local-onnx-fallback',
    semanticModelLoadMs: status?.modelLoadMs ?? 0,
    semanticLastError: status?.lastError ?? undefined,
  };
}
