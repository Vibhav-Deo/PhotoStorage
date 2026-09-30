import type {
  MediaAsset,
  SearchFilterState,
  SearchPerformanceTelemetry,
} from '../types/index.ts';

export const CURRENT_MODEL_ID = 'clip-vit-b-32-v1';
export const COARSE_DIM = 256;
const RRF_K = 60;

export interface RankedSearchResult {
  asset: MediaAsset;
  combinedScore: number;
  vectorCosineScore: number;
  ocrScore: number;
  metadataScore: number;
  matchedTags: string[];
  matchedOcrSnippets: string[];
  rankBreakdown: {
    vectorRank?: number | undefined;
    textRank?: number | undefined;
    filterMultiplier: number;
  };
}

// Fixed pseudo-random projection vector for simulating text query CLIP embeddings
function textToEmbedding(text: string, dim: number = COARSE_DIM): { floatVector: number[]; int8Vector: number[] } {
  const clean = text.trim().toLowerCase();
  const floatVector = new Array(dim).fill(0);

  // Generate deterministic pseudo-embedding based on character n-grams
  for (let i = 0; i < clean.length; i++) {
    const charCode = clean.charCodeAt(i);
    for (let d = 0; d < dim; d++) {
      const freq = Math.sin((charCode * (d + 1) * 31) / 1000);
      floatVector[d] += freq;
    }
  }

  // L2 normalize floatVector
  let norm = 0;
  for (let d = 0; d < dim; d++) {
    norm += floatVector[d] * floatVector[d];
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) {
    floatVector[d] /= norm;
  }

  // Quantize to int8 [-127, 127]
  const int8Vector = new Array(dim);
  for (let d = 0; d < dim; d++) {
    int8Vector[d] = Math.max(-127, Math.min(127, Math.round(floatVector[d] * 127)));
  }

  return { floatVector, int8Vector };
}

// Dot product for int8 coarse vectors
function int8DotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

// Cosine similarity for float32 vectors (assumed pre-normalized)
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
  }
  return Math.max(0, Math.min(1, (dot + 1) / 2)); // Normalized to [0, 1]
}

export function executeTwoStageSearch(
  assets: MediaAsset[],
  filters: SearchFilterState,
): {
  results: RankedSearchResult[];
  telemetry: SearchPerformanceTelemetry;
} {
  const startTime = performance.now();
  const query = filters.query.trim();

  // If query is empty, return simple filtered timeline items
  if (!query) {
    const filtered = assets.filter((asset) => applyHardFilters(asset, filters));
    return {
      results: filtered.map((asset) => ({
        asset,
        combinedScore: 1.0,
        vectorCosineScore: 1.0,
        ocrScore: 0,
        metadataScore: 0,
        matchedTags: [],
        matchedOcrSnippets: [],
        rankBreakdown: { filterMultiplier: 1 },
      })),
      telemetry: {
        coarseScanMs: 0,
        cosineRerankMs: 0,
        ocrFtsMs: 0,
        rrfFusionMs: 0.1,
        totalMs: performance.now() - startTime,
        candidatesEvaluated: assets.length,
        finalRankedCount: filtered.length,
      },
    };
  }

  // Generate query embedding
  const { floatVector: queryFloat, int8Vector: queryInt8 } = textToEmbedding(query, COARSE_DIM);

  // STAGE 1: Coarse int8 Dot-Product Scan with Min-Heap for Top Candidates (Task 6.3)
  const coarseStart = performance.now();
  const candidatePool = assets.filter((asset) => applyHardFilters(asset, filters));
  
  // We evaluate coarse dot products
  const coarseScored: { asset: MediaAsset; dotScore: number }[] = [];
  for (const asset of candidatePool) {
    const coarseVec = asset.coarseVector || textToEmbedding(asset.semanticTags.join(' ') + ' ' + asset.filename).int8Vector;
    const dot = int8DotProduct(queryInt8, coarseVec);
    coarseScored.push({ asset, dotScore: dot });
  }

  // Top K candidates (Task 6.3 specifies up to 500)
  coarseScored.sort((a, b) => b.dotScore - a.dotScore);
  const topCoarse = coarseScored.slice(0, Math.min(500, coarseScored.length));
  const coarseScanMs = performance.now() - coarseStart;

  // STAGE 2: Exact Cosine Rerank from vector_full (Task 6.3)
  const cosineStart = performance.now();
  const vectorRankings: { asset: MediaAsset; cosineScore: number }[] = [];
  for (const item of topCoarse) {
    const fullVec = item.asset.fullVector || textToEmbedding(item.asset.semanticTags.join(' ') + ' ' + item.asset.filename).floatVector;
    const cosine = cosineSimilarity(queryFloat, fullVec);
    vectorRankings.push({ asset: item.asset, cosineScore: cosine });
  }
  vectorRankings.sort((a, b) => b.cosineScore - a.cosineScore);
  const cosineRerankMs = performance.now() - cosineStart;

  // TASK 6.4: OCR Full-Text Search (FTS) evaluation
  const ocrStart = performance.now();
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const textRankings: {
    asset: MediaAsset;
    textScore: number;
    ocrSnippets: string[];
    metadataScore: number;
    matchedTags: string[];
  }[] = [];

  for (const asset of candidatePool) {
    let ocrScore = 0;
    let metadataScore = 0;
    const ocrSnippets: string[] = [];
    const matchedTags: string[] = [];

    // Search inside OCR text
    if (asset.ocrText) {
      const lowerOcr = asset.ocrText.toLowerCase();
      for (const token of queryTokens) {
        if (lowerOcr.includes(token)) {
          ocrScore += 50;
          // Extract snippet
          const idx = lowerOcr.indexOf(token);
          const snippetStart = Math.max(0, idx - 20);
          const snippetEnd = Math.min(asset.ocrText.length, idx + token.length + 20);
          ocrSnippets.push('…' + asset.ocrText.slice(snippetStart, snippetEnd).trim() + '…');
        }
      }
    }

    // Search tags & filenames
    for (const tag of asset.semanticTags) {
      const lowerTag = tag.toLowerCase();
      for (const token of queryTokens) {
        if (lowerTag.includes(token) || token.includes(lowerTag)) {
          metadataScore += 25;
          if (!matchedTags.includes(tag)) matchedTags.push(tag);
        }
      }
    }

    if (asset.filename.toLowerCase().includes(query.toLowerCase())) {
      metadataScore += 30;
    }
    if (asset.location?.placeName.toLowerCase().includes(query.toLowerCase())) {
      metadataScore += 40;
    }

    if (ocrScore > 0 || metadataScore > 0) {
      textRankings.push({
        asset,
        textScore: ocrScore,
        ocrSnippets,
        metadataScore,
        matchedTags,
      });
    }
  }
  textRankings.sort((a, b) => b.textScore + b.metadataScore - (a.textScore + a.metadataScore));
  const ocrFtsMs = performance.now() - ocrStart;

  // TASK 6.5: Reciprocal Rank Fusion (RRF) across Vector and FTS signals
  const fusionStart = performance.now();
  const vectorRankMap = new Map<string, { rank: number; score: number }>();
  vectorRankings.forEach((item, index) => {
    vectorRankMap.set(item.asset.id, { rank: index + 1, score: item.cosineScore });
  });

  const textRankMap = new Map<
    string,
    {
      rank: number;
      ocrScore: number;
      metadataScore: number;
      snippets: string[];
      tags: string[];
    }
  >();
  textRankings.forEach((item, index) => {
    textRankMap.set(item.asset.id, {
      rank: index + 1,
      ocrScore: item.textScore,
      metadataScore: item.metadataScore,
      snippets: item.ocrSnippets,
      tags: item.matchedTags,
    });
  });

  // Calculate fused scores for all matched items
  const combinedMap = new Map<string, RankedSearchResult>();

  // Include vector ranked items
  for (const vItem of vectorRankings) {
    const vRank = vectorRankMap.get(vItem.asset.id)?.rank || 1000;
    const tInfo = textRankMap.get(vItem.asset.id);
    const tRank = tInfo?.rank || 1000;

    // RRF Formula: 1 / (K + rank_vector) + 1 / (K + rank_text)
    const vectorComponent = 1.0 / (RRF_K + vRank);
    const textComponent = tInfo ? 1.0 / (RRF_K + tRank) : 0;
    const rrfScore = (vectorComponent * 1.2 + textComponent * 1.5) * 100;

    combinedMap.set(vItem.asset.id, {
      asset: vItem.asset,
      combinedScore: Number(rrfScore.toFixed(3)),
      vectorCosineScore: Number(vItem.cosineScore.toFixed(3)),
      ocrScore: tInfo?.ocrScore || 0,
      metadataScore: tInfo?.metadataScore || 0,
      matchedTags: tInfo?.tags || [],
      matchedOcrSnippets: tInfo?.snippets || [],
      rankBreakdown: {
        vectorRank: vRank,
        textRank: tInfo?.rank,
        filterMultiplier: 1.0,
      },
    });
  }

  // Include text-only matched items
  for (const tItem of textRankings) {
    if (!combinedMap.has(tItem.asset.id)) {
      const tRank = tItem.textScore > 0 ? textRankMap.get(tItem.asset.id)?.rank || 100 : 200;
      const textComponent = 1.0 / (RRF_K + tRank);
      const rrfScore = textComponent * 1.5 * 100;

      combinedMap.set(tItem.asset.id, {
        asset: tItem.asset,
        combinedScore: Number(rrfScore.toFixed(3)),
        vectorCosineScore: 0,
        ocrScore: tItem.textScore,
        metadataScore: tItem.metadataScore,
        matchedTags: tItem.matchedTags,
        matchedOcrSnippets: tItem.ocrSnippets,
        rankBreakdown: {
          textRank: tRank,
          filterMultiplier: 1.0,
        },
      });
    }
  }

  const finalResults = Array.from(combinedMap.values()).sort(
    (a, b) => b.combinedScore - a.combinedScore,
  );
  const rrfFusionMs = performance.now() - fusionStart;
  const totalMs = performance.now() - startTime;

  return {
    results: finalResults,
    telemetry: {
      coarseScanMs: Number(coarseScanMs.toFixed(2)),
      cosineRerankMs: Number(cosineRerankMs.toFixed(2)),
      ocrFtsMs: Number(ocrFtsMs.toFixed(2)),
      rrfFusionMs: Number(rrfFusionMs.toFixed(2)),
      totalMs: Number(totalMs.toFixed(2)),
      candidatesEvaluated: candidatePool.length,
      finalRankedCount: finalResults.length,
    },
  };
}

function applyHardFilters(asset: MediaAsset, filters: SearchFilterState): boolean {
  if (filters.kind === 'photo' && asset.kind !== 'photo') return false;
  if (filters.kind === 'video' && asset.kind !== 'video') return false;
  if (filters.kind === 'live_photo' && asset.kind !== 'live_photo') return false;
  if (filters.kind === 'favorites' && !asset.isFavorite) return false;

  if (filters.cameraModel && filters.cameraModel !== 'all') {
    const model = (asset.exif.cameraModel || '').toLowerCase();
    if (!model.includes(filters.cameraModel.toLowerCase())) return false;
  }

  if (filters.albumId && !asset.albumIds.includes(filters.albumId)) {
    return false;
  }

  if (filters.dateStart) {
    const s = new Date(filters.dateStart).getTime();
    if (asset.capturedAt < s) return false;
  }
  if (filters.dateEnd) {
    const e = new Date(filters.dateEnd).getTime() + 86400000;
    if (asset.capturedAt > e) return false;
  }

  if (filters.hasOcrOnly && (!asset.ocrText || asset.ocrText.trim().length === 0)) {
    return false;
  }

  return true;
}

// Task 6.7: Vector Backup & Restore
export function exportVectorShard(assets: MediaAsset[]): Blob {
  // Shard header: magic bytes 'VEC1', count uint32, dim uint16
  const validAssets = assets.filter((a) => a.coarseVector);
  const totalBytes = 8 + validAssets.length * (32 + COARSE_DIM); // 32 bytes hash + 256 bytes int8
  const buffer = new Uint8Array(totalBytes);
  const view = new DataView(buffer.buffer);

  // 'VEC1'
  buffer[0] = 0x56; buffer[1] = 0x45; buffer[2] = 0x43; buffer[3] = 0x31;
  view.setUint32(4, validAssets.length, true);

  let offset = 8;
  const encoder = new TextEncoder();
  for (const a of validAssets) {
    // 32-byte hash prefix
    const hashBytes = encoder.encode(a.hash.slice(0, 32));
    buffer.set(hashBytes, offset);
    offset += 32;

    // 256 bytes int8 vector
    if (a.coarseVector) {
      buffer.set(new Uint8Array(new Int8Array(a.coarseVector).buffer), offset);
    }
    offset += COARSE_DIM;
  }

  return new Blob([buffer], { type: 'application/octet-stream' });
}

export async function parseVectorShard(file: Blob): Promise<{ hashPrefix: string; vector: number[] }[]> {
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'VEC1') {
    throw new Error('Invalid vector shard header: magic mismatch');
  }

  const count = view.getUint32(4, true);
  const results: { hashPrefix: string; vector: number[] }[] = [];
  const decoder = new TextDecoder();
  let offset = 8;

  for (let i = 0; i < count; i++) {
    if (offset + 32 + COARSE_DIM > buf.byteLength) break;
    const hashPrefix = decoder.decode(buf.slice(offset, offset + 32));
    offset += 32;

    const int8Arr = new Int8Array(buf.slice(offset, offset + COARSE_DIM));
    results.push({
      hashPrefix,
      vector: Array.from(int8Arr),
    });
    offset += COARSE_DIM;
  }

  return results;
}
