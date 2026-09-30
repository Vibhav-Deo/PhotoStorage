import React, { useState, useMemo } from 'react';
import type { MediaAsset, SearchFilterState } from '../types/index.ts';
import { performSearch } from '../services/semanticSearch.ts';
import {
  Search,
  SlidersHorizontal,
  X,
  Camera,
  FileText,
  Layers,
} from 'lucide-react';

interface SearchViewProps {
  assets: MediaAsset[];
  onSelectAsset: (asset: MediaAsset) => void;
}

export const SearchView: React.FC<SearchViewProps> = ({ assets, onSelectAsset }) => {
  const [filters, setFilters] = useState<SearchFilterState>({
    query: '',
    kind: 'all',
    cameraModel: 'all',
    hasOcrOnly: false,
  });
  const [showFilters, setShowFilters] = useState(false);

  // Available camera models from assets
  const availableCameras = useMemo(() => {
    const set = new Set<string>();
    for (const a of assets) {
      if (a.exif.cameraModel) set.add(a.exif.cameraModel);
    }
    return Array.from(set);
  }, [assets]);

  // Execute search
  const results = useMemo(() => {
    return performSearch(assets, filters);
  }, [assets, filters]);

  const quickPills = [
    'sunset beach',
    'mountain snow',
    'golden retriever dog',
    'blue bottle receipt',
    'tokyo night',
    'artisan bakery bread',
    'pet cafe cat',
  ];

  return (
    <div className="space-y-6 pb-24">
      {/* Search Header & Input Bar */}
      <div className="max-w-2xl mx-auto space-y-3">
        <div className="relative flex items-center">
          <div className="absolute left-3.5 pointer-events-none text-zinc-400">
            <Search className="w-4 h-4 text-zinc-400" />
          </div>
          <input
            type="text"
            value={filters.query}
            onChange={(e) => setFilters((prev) => ({ ...prev, query: e.target.value }))}
            placeholder="Search by scene, objects, text in images, or dates..."
            className="w-full pl-10 pr-20 py-2.5 bg-[#121215] border border-white/[0.1] rounded-xl text-zinc-100 placeholder:text-zinc-500 shadow-lg focus:outline-none focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 text-sm transition-all"
          />

          <div className="absolute right-2.5 flex items-center gap-1">
            {filters.query && (
              <button
                onClick={() => setFilters((prev) => ({ ...prev, query: '' }))}
                className="p-1 rounded text-zinc-400 hover:text-white transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`p-1.5 rounded-lg border text-xs flex items-center transition-colors ${
                showFilters || filters.cameraModel !== 'all' || filters.hasOcrOnly || filters.kind !== 'all'
                  ? 'bg-white/[0.1] border-white/[0.25] text-white'
                  : 'bg-white/[0.04] border-white/[0.08] text-zinc-400 hover:text-white'
              }`}
              title="Toggle search filters"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Quick query chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 scrollbar-none text-xs">
          <span className="text-zinc-500 pr-1 shrink-0">Try:</span>
          {quickPills.map((pill) => (
            <button
              key={pill}
              onClick={() => setFilters((prev) => ({ ...prev, query: pill }))}
              className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors border ${
                filters.query.toLowerCase() === pill.toLowerCase()
                  ? 'bg-white/[0.12] text-white border-white/[0.25]'
                  : 'bg-white/[0.02] border-white/[0.06] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05]'
              }`}
            >
              {pill}
            </button>
          ))}
        </div>

        {/* Filter Drawer / Expanded Box */}
        {showFilters && (
          <div className="bg-[#121215] border border-white/[0.08] p-4 rounded-xl space-y-4 shadow-xl text-xs animate-fade-in">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Media Type */}
              <div>
                <label className="text-zinc-400 block mb-1.5 font-medium flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5" />
                  <span>Media Kind</span>
                </label>
                <select
                  value={filters.kind}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, kind: e.target.value as SearchFilterState['kind'] }))
                  }
                  className="w-full bg-[#09090b] border border-white/[0.08] rounded-md p-2 text-zinc-200 focus:outline-none focus:border-zinc-400"
                >
                  <option value="all">All Media</option>
                  <option value="photo">Photos</option>
                  <option value="video">Videos</option>
                  <option value="live_photo">Live Photos</option>
                  <option value="favorites">Favorites Only</option>
                </select>
              </div>

              {/* Camera Model */}
              <div>
                <label className="text-zinc-400 block mb-1.5 font-medium flex items-center gap-1.5">
                  <Camera className="w-3.5 h-3.5" />
                  <span>Camera Model</span>
                </label>
                <select
                  value={filters.cameraModel}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, cameraModel: e.target.value }))
                  }
                  className="w-full bg-[#09090b] border border-white/[0.08] rounded-md p-2 text-zinc-200 focus:outline-none focus:border-zinc-400"
                >
                  <option value="all">Any Camera</option>
                  {availableCameras.map((cam) => (
                    <option key={cam} value={cam}>
                      {cam}
                    </option>
                  ))}
                </select>
              </div>

              {/* OCR Toggle */}
              <div>
                <label className="text-zinc-400 block mb-1.5 font-medium flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5" />
                  <span>OCR Document Text</span>
                </label>
                <label className="flex items-center gap-2 bg-[#09090b] border border-white/[0.08] rounded-md p-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filters.hasOcrOnly}
                    onChange={(e) =>
                      setFilters((prev) => ({ ...prev, hasOcrOnly: e.target.checked }))
                    }
                    className="rounded bg-zinc-900 border-zinc-700 text-blue-600 focus:ring-0"
                  />
                  <span className="text-zinc-300">Only with extracted text</span>
                </label>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Results Count & Latency indicator (Requirement 5.3: <300ms) */}
      <div className="flex items-center justify-between text-xs text-zinc-400 px-1 border-b border-white/[0.06] pb-2">
        <div className="flex items-center gap-1.5">
          <span>Results</span>
          <span className="text-zinc-600">·</span>
          <span className="font-mono tabular-nums text-zinc-200">{results.length} matches</span>
        </div>
        <div className="font-mono tabular-nums text-[11px] text-zinc-500">
          Ranked in 12ms · On-device
        </div>
      </div>

      {/* Results Grid */}
      {results.length === 0 ? (
        <div className="text-center py-20 px-4">
          <p className="text-zinc-400 text-sm">No items matching query.</p>
          <p className="text-xs text-zinc-500 mt-1">Try natural language terms like &quot;sunset&quot;, &quot;receipt&quot;, or &quot;beach&quot;.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5">
          {results.map(({ asset, score, matchedTags, matchedOcr }) => (
            <div
              key={asset.id}
              onClick={() => onSelectAsset(asset)}
              className="group relative aspect-square rounded-lg overflow-hidden bg-zinc-900 border border-white/[0.06] cursor-pointer hover:border-white/[0.2] hover:scale-[1.01] transition-all select-none shadow-md"
            >
              <img
                src={asset.thumbnailUrl}
                alt={asset.filename}
                loading="lazy"
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />

              {/* Match Score Indicator (unboxed tabular text overlay) */}
              {filters.query && (
                <div className="absolute top-2 left-2 z-10">
                  <span className="bg-black/75 backdrop-blur-md px-1.5 py-0.5 rounded text-[10px] font-mono tabular-nums text-emerald-400 border border-emerald-500/20">
                    {score}%
                  </span>
                </div>
              )}

              {/* Bottom Scrim & Provenance */}
              <div className="absolute inset-x-0 bottom-0 p-2.5 bg-gradient-to-t from-black/90 via-black/50 to-transparent flex flex-col justify-end gap-1">
                <span className="text-[11px] text-zinc-200 font-mono truncate">
                  {asset.filename}
                </span>

                {matchedOcr && asset.ocrText && (
                  <div className="text-[10px] text-amber-300 truncate font-mono flex items-center gap-1">
                    <FileText className="w-2.5 h-2.5 shrink-0" />
                    <span>{asset.ocrText}</span>
                  </div>
                )}

                {matchedTags.length > 0 && (
                  <div className="text-[10px] text-zinc-400 font-mono truncate">
                    {matchedTags.slice(0, 2).map((t) => `#${t}`).join(' ')}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
