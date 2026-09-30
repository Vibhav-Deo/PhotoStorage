import React, { useState, useMemo } from 'react';
import type { MediaAsset } from '../types/index.ts';
import {
  Heart,
  Video,
  Play,
  CheckCircle,
  Cloud,
  HardDrive,
  Layers,
  Sparkles,
} from 'lucide-react';

interface TimelineViewProps {
  assets: MediaAsset[];
  onSelectAsset: (asset: MediaAsset) => void;
  onToggleFavorite: (assetId: string) => void;
  onReclaimSelected?: (assetIds: string[]) => void;
}

export const TimelineView: React.FC<TimelineViewProps> = ({
  assets,
  onSelectAsset,
  onToggleFavorite,
}) => {
  const [filter, setFilter] = useState<'all' | 'photo' | 'video' | 'live_photo' | 'favorites'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState<boolean>(false);

  // Filter assets
  const filteredAssets = useMemo(() => {
    return assets.filter((asset) => {
      if (filter === 'photo') return asset.kind === 'photo';
      if (filter === 'video') return asset.kind === 'video';
      if (filter === 'live_photo') return asset.kind === 'live_photo';
      if (filter === 'favorites') return asset.isFavorite;
      return true;
    });
  }, [assets, filter]);

  // Group assets by date string
  const groupedSections = useMemo(() => {
    const groups: { dateKey: string; label: string; items: MediaAsset[] }[] = [];
    const map = new Map<string, MediaAsset[]>();

    for (const item of filteredAssets) {
      const d = new Date(item.capturedAt);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!map.has(dateKey)) {
        map.set(dateKey, []);
      }
      map.get(dateKey)!.push(item);
    }

    const sortedKeys = Array.from(map.keys()).sort((a, b) => b.localeCompare(a));

    for (const k of sortedKeys) {
      const dateObj = new Date(k + 'T12:00:00');
      const label = dateObj.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      groups.push({
        dateKey: k,
        label,
        items: map.get(k) || [],
      });
    }

    return groups;
  }, [filteredAssets]);

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    if (next.size > 0 && !selectionMode) setSelectionMode(true);
    if (next.size === 0) setSelectionMode(false);
  };

  const selectAll = () => {
    setSelectedIds(new Set(filteredAssets.map((a) => a.id)));
    setSelectionMode(true);
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  return (
    <div className="space-y-8 pb-24">
      {/* Controls & Segmented Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 py-2 border-b border-white/[0.06]">
        {/* Segmented Filter Control */}
        <div className="flex items-center gap-1 p-1 bg-[#121215] border border-white/[0.08] rounded-lg">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              filter === 'all'
                ? 'bg-white/[0.1] text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            All Media <span className="text-zinc-500 tabular-nums">({assets.length})</span>
          </button>
          <button
            onClick={() => setFilter('photo')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              filter === 'photo'
                ? 'bg-white/[0.1] text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Photos
          </button>
          <button
            onClick={() => setFilter('live_photo')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${
              filter === 'live_photo'
                ? 'bg-white/[0.1] text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Sparkles className="w-3 h-3 text-sky-400" />
            <span>Live Photos</span>
          </button>
          <button
            onClick={() => setFilter('video')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${
              filter === 'video'
                ? 'bg-white/[0.1] text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Video className="w-3 h-3 text-purple-400" />
            <span>Videos</span>
          </button>
          <button
            onClick={() => setFilter('favorites')}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${
              filter === 'favorites'
                ? 'bg-white/[0.1] text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Heart className="w-3 h-3 text-rose-400 fill-current" />
            <span>Favorites</span>
          </button>
        </div>

        {/* Selection mode actions */}
        <div className="flex items-center gap-2 text-xs">
          {selectionMode ? (
            <>
              <span className="text-zinc-300 font-mono tabular-nums px-2">
                {selectedIds.size} selected
              </span>
              <button
                onClick={selectAll}
                className="px-2.5 py-1.5 rounded-md bg-white/[0.06] hover:bg-white/[0.1] text-zinc-200 border border-white/[0.08] transition-colors"
              >
                Select All
              </button>
              <button
                onClick={clearSelection}
                className="px-2.5 py-1.5 rounded-md bg-transparent hover:bg-white/[0.04] text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setSelectionMode(true)}
              className="px-3 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 border border-white/[0.08] transition-colors flex items-center gap-1.5"
            >
              <Layers className="w-3.5 h-3.5 text-zinc-400" />
              <span>Select</span>
            </button>
          )}
        </div>
      </div>

      {/* Empty State */}
      {filteredAssets.length === 0 && (
        <div className="text-center py-24 px-4">
          <p className="text-zinc-400 text-sm">No items matching current filter.</p>
          <button
            onClick={() => setFilter('all')}
            className="mt-2 text-xs text-blue-400 hover:text-blue-300 underline underline-offset-4"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Date Grouped Timeline Grid */}
      {groupedSections.map((group) => (
        <section key={group.dateKey} className="space-y-3">
          <div className="sticky top-14 z-20 bg-[#09090b]/85 backdrop-blur-md py-2.5 flex items-center justify-between border-b border-white/[0.06]">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
              {group.label}
            </h3>
            <span className="text-xs text-zinc-500 font-mono tabular-nums">
              {group.items.length} {group.items.length === 1 ? 'item' : 'items'}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5">
            {group.items.map((asset) => {
              const isSelected = selectedIds.has(asset.id);
              return (
                <div
                  key={asset.id}
                  onClick={() => {
                    if (selectionMode) {
                      const next = new Set(selectedIds);
                      if (next.has(asset.id)) next.delete(asset.id);
                      else next.add(asset.id);
                      setSelectedIds(next);
                    } else {
                      onSelectAsset(asset);
                    }
                  }}
                  className={`group relative aspect-square rounded-lg overflow-hidden bg-zinc-900 border border-white/[0.06] cursor-pointer select-none transition-all duration-200 ${
                    isSelected
                      ? 'ring-2 ring-blue-500 scale-[0.98]'
                      : 'hover:border-white/[0.2] hover:scale-[1.01]'
                  }`}
                >
                  {/* Thumbnail Image */}
                  <img
                    src={asset.thumbnailUrl}
                    alt={asset.filename}
                    loading="lazy"
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />

                  {/* Top indicators */}
                  <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-none">
                    <div className="flex items-center gap-1">
                      {asset.kind === 'video' && (
                        <span className="flex items-center gap-1 bg-black/60 backdrop-blur-md text-[10px] text-zinc-200 px-1.5 py-0.5 rounded font-mono tabular-nums border border-white/[0.1]">
                          <Play className="w-2.5 h-2.5 fill-current" />
                          <span>{asset.duration ? `${asset.duration}s` : 'Video'}</span>
                        </span>
                      )}
                      {asset.kind === 'live_photo' && (
                        <span className="flex items-center gap-1 bg-black/60 backdrop-blur-md text-[10px] text-sky-300 px-1.5 py-0.5 rounded font-medium border border-white/[0.1]">
                          <Sparkles className="w-2.5 h-2.5" />
                          <span>LIVE</span>
                        </span>
                      )}
                    </div>

                    {/* Remote/Local indicator */}
                    <div className="flex items-center gap-1">
                      {asset.isLocalPurged ? (
                        <span
                          title="Original purged locally (Stored in S3)"
                          className="bg-black/60 backdrop-blur-md p-1 rounded-md text-amber-400 border border-white/[0.1]"
                        >
                          <Cloud className="w-3 h-3" />
                        </span>
                      ) : (
                        <span
                          title="Local copy verified"
                          className="bg-black/60 backdrop-blur-md p-1 rounded-md text-emerald-400 border border-white/[0.1]"
                        >
                          <HardDrive className="w-3 h-3" />
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Selection Checkbox */}
                  <div
                    onClick={(e) => toggleSelect(asset.id, e)}
                    className={`absolute top-2 left-2 z-20 pointer-events-auto p-0.5 transition-opacity ${
                      selectionMode || isSelected
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full flex items-center justify-center border transition-colors ${
                        isSelected
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-black/60 border-white/40 text-transparent hover:border-white'
                      }`}
                    >
                      <CheckCircle className="w-4 h-4 fill-current" />
                    </div>
                  </div>

                  {/* Bottom Filename & Favorite Overlay */}
                  <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 via-black/30 to-transparent flex items-end justify-between opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[11px] text-zinc-300 truncate max-w-[70%] font-mono">
                      {asset.filename}
                    </span>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavorite(asset.id);
                      }}
                      className="p-1 rounded text-zinc-300 hover:text-rose-400 transition-colors"
                    >
                      <Heart
                        className={`w-3.5 h-3.5 ${
                          asset.isFavorite ? 'fill-rose-500 text-rose-500' : ''
                        }`}
                      />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
};
