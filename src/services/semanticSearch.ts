import type { MediaAsset, SearchFilterState } from '../types/index.ts';

export interface SearchResult {
  asset: MediaAsset;
  score: number;
  matchedTags: string[];
  matchedOcr: boolean;
  matchedMetadata: boolean;
}

// Concept synonyms for semantic similarity matching
const CONCEPT_EXPANSIONS: Record<string, string[]> = {
  beach: ['ocean', 'sea', 'waves', 'sand', 'coastline', 'tropical', 'shore', 'sunset', 'water'],
  ocean: ['beach', 'sea', 'waves', 'water', 'marine', 'coastal'],
  mountain: ['alps', 'mountains', 'snow', 'glacier', 'hiking', 'peaks', 'sunrise', 'rocks', 'cliff'],
  dog: ['puppy', 'retriever', 'golden retriever', 'canine', 'pet', 'animal'],
  cat: ['kitten', 'feline', 'pets', 'playful', 'cute'],
  pet: ['dog', 'cat', 'puppy', 'kitten', 'animal'],
  city: ['urban', 'tokyo', 'street', 'night', 'lights', 'neon', 'architecture', 'building'],
  night: ['lights', 'neon', 'dark', 'evening', 'city', 'shinjuku'],
  food: ['bread', 'baking', 'sourdough', 'coffee', 'bakery', 'restaurant', 'meal', 'cafe'],
  coffee: ['latte', 'espresso', 'cafe', 'blue bottle', 'drink', 'morning'],
  receipt: ['invoice', 'expense', 'document', 'text', 'paper', 'tax', 'total', 'bill'],
  document: ['receipt', 'invoice', 'paper', 'text', 'scan', 'letter'],
  nature: ['mountains', 'beach', 'trees', 'grass', 'park', 'hiking', 'lake', 'forest'],
  building: ['architecture', 'facade', 'modern', 'concrete', 'glass', 'geometric', 'lines'],
  sunset: ['evening', 'golden hour', 'sun', 'sky', 'beach', 'twilight'],
  snow: ['glacier', 'winter', 'alps', 'mountains', 'cold', 'ice'],
};

export function performSearch(
  assets: MediaAsset[],
  filters: SearchFilterState,
): SearchResult[] {
  const query = filters.query.trim().toLowerCase();
  const queryTokens = query ? query.split(/\s+/).filter(Boolean) : [];

  // Expand query tokens with semantic synonyms
  const expandedConcepts = new Set<string>();
  for (const token of queryTokens) {
    expandedConcepts.add(token);
    if (CONCEPT_EXPANSIONS[token]) {
      for (const syn of CONCEPT_EXPANSIONS[token]) {
        expandedConcepts.add(syn);
      }
    }
  }

  const results: SearchResult[] = [];

  for (const asset of assets) {
    // 1. Kind filter
    if (filters.kind === 'photo' && asset.kind !== 'photo') continue;
    if (filters.kind === 'video' && asset.kind !== 'video') continue;
    if (filters.kind === 'live_photo' && asset.kind !== 'live_photo') continue;
    if (filters.kind === 'favorites' && !asset.isFavorite) continue;

    // 2. Camera filter
    if (filters.cameraModel && filters.cameraModel !== 'all') {
      const model = asset.exif.cameraModel || '';
      if (!model.toLowerCase().includes(filters.cameraModel.toLowerCase())) {
        continue;
      }
    }

    // 3. Album filter
    if (filters.albumId && !asset.albumIds.includes(filters.albumId)) {
      continue;
    }

    // 4. Date range filter
    if (filters.dateStart) {
      const startTime = new Date(filters.dateStart).getTime();
      if (asset.capturedAt < startTime) continue;
    }
    if (filters.dateEnd) {
      const endTime = new Date(filters.dateEnd).getTime() + 86400000;
      if (asset.capturedAt > endTime) continue;
    }

    // 5. OCR only filter
    if (filters.hasOcrOnly && (!asset.ocrText || asset.ocrText.trim().length === 0)) {
      continue;
    }

    // If query is empty, match with baseline score
    if (!query) {
      results.push({
        asset,
        score: 1.0,
        matchedTags: [],
        matchedOcr: false,
        matchedMetadata: false,
      });
      continue;
    }

    // Score calculation
    let score = 0;
    const matchedTags: string[] = [];
    let matchedOcr = false;
    let matchedMetadata = false;

    // Check tags (semantic similarity)
    for (const tag of asset.semanticTags) {
      const lowerTag = tag.toLowerCase();
      for (const concept of expandedConcepts) {
        if (lowerTag.includes(concept) || concept.includes(lowerTag)) {
          score += 15;
          if (!matchedTags.includes(tag)) matchedTags.push(tag);
        }
      }
    }

    // Check OCR text
    if (asset.ocrText) {
      const lowerOcr = asset.ocrText.toLowerCase();
      for (const token of queryTokens) {
        if (lowerOcr.includes(token)) {
          score += 25;
          matchedOcr = true;
        }
      }
    }

    // Check metadata: filename, place name, camera model
    const lowerFilename = asset.filename.toLowerCase();
    const lowerPlace = asset.location?.placeName.toLowerCase() || '';
    const lowerCamera = `${asset.exif.cameraMake || ''} ${asset.exif.cameraModel || ''}`.toLowerCase();

    for (const token of queryTokens) {
      if (lowerFilename.includes(token)) {
        score += 10;
        matchedMetadata = true;
      }
      if (lowerPlace.includes(token)) {
        score += 20;
        matchedMetadata = true;
      }
      if (lowerCamera.includes(token)) {
        score += 15;
        matchedMetadata = true;
      }
    }

    if (score > 0) {
      results.push({
        asset,
        score,
        matchedTags,
        matchedOcr,
        matchedMetadata,
      });
    }
  }

  // Rank by highest fused score, then by captured date descending
  return results.sort((a, b) => b.score - a.score || b.asset.capturedAt - a.asset.capturedAt);
}
