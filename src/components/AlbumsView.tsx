import React, { useState } from 'react';
import type { Album, MediaAsset } from '../types/index.ts';
import {
  FolderArchive,
  Plus,
  ArrowLeft,
  Layers,
} from 'lucide-react';

interface AlbumsViewProps {
  albums: Album[];
  assets: MediaAsset[];
  onCreateAlbum: (title: string, description?: string) => void;
  onSelectAsset: (asset: MediaAsset) => void;
}

export const AlbumsView: React.FC<AlbumsViewProps> = ({
  albums,
  assets,
  onCreateAlbum,
  onSelectAsset,
}) => {
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const selectedAlbum = albums.find((a) => a.id === selectedAlbumId);

  // Assets belonging to current selected album
  const albumAssets = selectedAlbum
    ? assets.filter((a) => a.albumIds.includes(selectedAlbum.id))
    : [];

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    onCreateAlbum(newTitle.trim(), newDesc.trim() || undefined);
    setNewTitle('');
    setNewDesc('');
    setIsCreating(false);
  };

  if (selectedAlbum) {
    return (
      <div className="space-y-6 pb-24">
        {/* Back and Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSelectedAlbumId(null)}
              className="p-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] text-zinc-300 transition-colors"
              title="Back to all albums"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-white">{selectedAlbum.title}</h2>
                {selectedAlbum.isSystem && (
                  <span className="text-[11px] text-zinc-500 font-mono">
                    Takeout Import
                  </span>
                )}
              </div>
              {selectedAlbum.description && (
                <p className="text-xs text-zinc-400 mt-0.5">{selectedAlbum.description}</p>
              )}
            </div>
          </div>

          <div className="text-xs text-zinc-400 font-mono tabular-nums">
            {albumAssets.length} items <span className="text-zinc-600">·</span> Referenced without duplicate bytes
          </div>
        </div>

        {/* Album Assets Grid */}
        {albumAssets.length === 0 ? (
          <div className="text-center py-24 text-zinc-500 text-xs">
            This album is currently empty.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2.5">
            {albumAssets.map((asset) => (
              <div
                key={asset.id}
                onClick={() => onSelectAsset(asset)}
                className="group relative aspect-square rounded-lg overflow-hidden bg-zinc-900 border border-white/[0.06] cursor-pointer hover:border-white/[0.2] hover:scale-[1.01] transition-all select-none"
              >
                <img
                  src={asset.thumbnailUrl}
                  alt={asset.filename}
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2.5">
                  <span className="text-[11px] text-zinc-300 font-mono truncate">
                    {asset.filename}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      {/* Header with New Album button */}
      <div className="flex items-center justify-between pb-3 border-b border-white/[0.06]">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-200">
            Albums & Collections
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Membership is by content reference. Items in multiple albums share identical storage.
          </p>
        </div>

        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-zinc-200 border border-white/[0.08] rounded-md transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5 text-zinc-300" />
          <span>New Album</span>
        </button>
      </div>

      {/* Create Album Modal / Card */}
      {isCreating && (
        <form
          onSubmit={handleCreateSubmit}
          className="bg-[#121215] border border-white/[0.1] p-4 rounded-xl space-y-3 animate-fade-in max-w-md shadow-2xl"
        >
          <h3 className="text-xs font-semibold text-white">Create New Album</h3>
          <div>
            <label className="text-[11px] text-zinc-400 block mb-1">Album Title</label>
            <input
              type="text"
              required
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Kyoto Trip 2024"
              className="w-full bg-[#09090b] border border-white/[0.1] rounded-md px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-400"
            />
          </div>
          <div>
            <label className="text-[11px] text-zinc-400 block mb-1">Description (Optional)</label>
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Notes or memories..."
              className="w-full bg-[#09090b] border border-white/[0.1] rounded-md px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-400"
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              className="px-3 py-1.5 text-xs rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-3.5 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md shadow-sm"
            >
              Create Album
            </button>
          </div>
        </form>
      )}

      {/* Albums Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {albums.map((album) => {
          const coverAsset =
            assets.find((a) => a.id === album.coverAssetId) ||
            assets.find((a) => a.albumIds.includes(album.id));

          return (
            <div
              key={album.id}
              onClick={() => setSelectedAlbumId(album.id)}
              className="group bg-[#121215] border border-white/[0.08] rounded-xl overflow-hidden hover:border-white/[0.2] transition-all cursor-pointer flex flex-col shadow-sm"
            >
              {/* Cover Image Container */}
              <div className="aspect-[4/3] bg-zinc-950 relative overflow-hidden flex items-center justify-center">
                {coverAsset ? (
                  <img
                    src={coverAsset.thumbnailUrl}
                    alt={album.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                ) : (
                  <FolderArchive className="w-10 h-10 text-zinc-700" />
                )}

                {/* Counter */}
                <div className="absolute top-2.5 right-2.5">
                  <span className="bg-black/75 backdrop-blur-md px-2 py-0.5 rounded text-[11px] font-mono tabular-nums text-zinc-300 flex items-center gap-1 border border-white/[0.1]">
                    <Layers className="w-3 h-3 text-zinc-400" />
                    <span>{album.assetCount}</span>
                  </span>
                </div>
              </div>

              {/* Album Info */}
              <div className="p-3.5 flex-1 flex flex-col justify-between">
                <div>
                  <h3 className="font-semibold text-white group-hover:text-blue-400 transition-colors text-sm truncate">
                    {album.title}
                  </h3>
                  {album.description && (
                    <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                      {album.description}
                    </p>
                  )}
                </div>

                <div className="mt-3 pt-2.5 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-zinc-500 font-mono">
                  <span>{new Date(album.createdAt).toLocaleDateString()}</span>
                  {album.isSystem && (
                    <span className="text-zinc-400">Takeout</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
