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
    <div className="space-y-6 pb-20">
      {/* Controls & Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-zinc-900/60 p-3 rounded-xl border border-zinc-800">
        <div className="flex items-center space-x-1.5 overflow-x-auto">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === 'all'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
            }`}
          >
            All Media ({assets.length})
          </button>
          <button
            onClick={() => setFilter('photo')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === 'photo'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
            }`}
          >
            Photos
          </button>
          <button
            onClick={() => setFilter('live_photo')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center space-x-1 ${
              filter === 'live_photo'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
            }`}
          >
            <Sparkles className="w-3 h-3" />
            <span>Live Photos</span>
          </button>
          <button
            onClick={() => setFilter('video')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center space-x-1 ${
              filter === 'video'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
            }`}
          >
            <Video className="w-3 h-3" />
            <span>Videos</span>
          </button>
          <button
            onClick={() => setFilter('favorites')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center space-x-1 ${
              filter === 'favorites'
                ? 'bg-amber-600 text-white shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
            }`}
          >
            <Heart className="w-3 h-3 fill-current" />
            <span>Favorites</span>
          </button>
        </div>

        {/* Selection mode toggles */}
        <div className="flex items-center space-x-2 text-xs">
          {selectionMode ? (
            <>
              <span className="text-zinc-300 font-medium">{selectedIds.size} selected</span>
              <button
                onClick={selectAll}
                className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
              >
                Select All
              </button>
              <button
                onClick={clearSelection}
                className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setSelectionMode(true)}
              className="px-2.5 py-1 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 transition-colors flex items-center space-x-1"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Select</span>
            </button>
          )}
        </div>
      </div>

      {/* Empty State */}
      {filteredAssets.length === 0 && (
        <div className="text-center py-20 px-4">
          <p className="text-zinc-400 text-base">No media found matching this filter.</p>
          <button
            onClick={() => setFilter('all')}
            className="mt-3 text-sm text-blue-400 hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Date Grouped Timeline Grid */}
      {groupedSections.map((group) => (
        <section key={group.dateKey} className="space-y-3">
          <div className="sticky top-[61px] z-10 bg-zinc-950/90 backdrop-blur-sm py-1.5 flex items-center justify-between border-b border-zinc-900/80">
            <h3 className="text-sm font-semibold text-zinc-200">{group.label}</h3>
            <span className="text-xs text-zinc-500">{group.items.length} items</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 sm:gap-3">
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
                  className={`group relative aspect-square rounded-xl overflow-hidden bg-zinc-900 cursor-pointer select-none transition-all duration-200 ${
                    isSelected
                      ? 'ring-4 ring-blue-500 scale-[0.98]'
                      : 'hover:ring-2 hover:ring-zinc-600 hover:scale-[1.01]'
                  }`}
                >
                  {/* Thumbnail Image */}
                  <img
                    src={asset.thumbnailUrl}
                    alt={asset.filename}
                    loading="lazy"
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />

                  {/* Top Badges overlay */}
                  <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-none">
                    <div className="flex items-center space-x-1">
                      {asset.kind === 'video' && (
                        <span className="flex items-center space-x-1 bg-black/60 backdrop-blur-md text-[10px] text-zinc-200 px-1.5 py-0.5 rounded font-mono">
                          <Play className="w-2.5 h-2.5 fill-current" />
                          <span>{asset.duration ? `${asset.duration}s` : 'Video'}</span>
                        </span>
                      )}
                      {asset.kind === 'live_photo' && (
                        <span className="flex items-center space-x-0.5 bg-black/60 backdrop-blur-md text-[10px] text-blue-300 px-1.5 py-0.5 rounded font-medium">
                          <Sparkles className="w-2.5 h-2.5" />
                          <span>LIVE</span>
                        </span>
                      )}
                    </div>

                    {/* Status icons: Purged / Verified */}
                    <div className="flex items-center space-x-1">
                      {asset.isLocalPurged ? (
                        <span
                          title="Original purged locally (Stored securely in Cloud S3)"
                          className="bg-black/60 backdrop-blur-md p-1 rounded-full text-amber-400"
                        >
                          <Cloud className="w-3 h-3" />
                        </span>
                      ) : (
                        <span
                          title="Local original present & verified"
                          className="bg-black/60 backdrop-blur-md p-1 rounded-full text-emerald-400"
                        >
                          <HardDrive className="w-3 h-3" />
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Selection Checkbox (visible in selection mode or on hover) */}
                  <div
                    onClick={(e) => toggleSelect(asset.id, e)}
                    className={`absolute top-2 left-2 z-20 pointer-events-auto p-1 rounded-full transition-opacity ${
                      selectionMode || isSelected
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full flex items-center justify-center border transition-colors ${
                        isSelected
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-black/60 border-zinc-400 text-transparent hover:border-white'
                      }`}
                    >
                      <CheckCircle className="w-4 h-4 fill-current" />
                    </div>
                  </div>

                  {/* Bottom Controls / Info Gradient */}
                  <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex items-end justify-between opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[11px] text-zinc-300 truncate max-w-[70%] font-mono">
                      {asset.filename}
                    </span>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavorite(asset.id);
                      }}
                      className="p-1 rounded-full text-zinc-300 hover:text-amber-400 transition-colors"
                    >
                      <Heart
                        className={`w-4 h-4 ${
                          asset.isFavorite ? 'fill-amber-400 text-amber-400' : ''
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
