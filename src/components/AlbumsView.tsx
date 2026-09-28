import React, { useState } from 'react';
import type { Album, MediaAsset } from '../types/index.ts';
import {
  FolderArchive,
  Plus,
  ArrowLeft,
  Calendar,
  Layers,
  Sparkles,
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
      <div className="space-y-6 pb-20">
        {/* Back and Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-800">
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setSelectedAlbumId(null)}
              className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-xl font-bold text-zinc-100">{selectedAlbum.title}</h2>
                {selectedAlbum.isSystem && (
                  <span className="px-2 py-0.5 text-[10px] uppercase font-mono tracking-wider rounded bg-zinc-800 text-zinc-400">
                    System
                  </span>
                )}
              </div>
              {selectedAlbum.description && (
                <p className="text-xs text-zinc-400 mt-0.5">{selectedAlbum.description}</p>
              )}
            </div>
          </div>

          <div className="text-xs text-zinc-500 font-mono">
            {albumAssets.length} items • Referenced without duplicate bytes
          </div>
        </div>

        {/* Album Assets Grid */}
        {albumAssets.length === 0 ? (
          <div className="text-center py-20 text-zinc-500 text-sm">
            This album is currently empty.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {albumAssets.map((asset) => (
              <div
                key={asset.id}
                onClick={() => onSelectAsset(asset)}
                className="group relative aspect-square rounded-xl overflow-hidden bg-zinc-900 cursor-pointer hover:ring-2 hover:ring-zinc-600 transition-all select-none"
              >
                <img
                  src={asset.thumbnailUrl}
                  alt={asset.filename}
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2.5">
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
    <div className="space-y-6 pb-20">
      {/* Header with New Album button */}
      <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
        <div>
          <h2 className="text-lg font-bold text-zinc-100">Albums & Collections</h2>
          <p className="text-xs text-zinc-400">
            Membership is by content reference (Requirement 3.5). Items in multiple albums are stored once.
          </p>
        </div>

        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-lg transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4 text-blue-400" />
          <span>New Album</span>
        </button>
      </div>

      {/* Create Album Modal / Inline card */}
      {isCreating && (
        <form
          onSubmit={handleCreateSubmit}
          className="bg-zinc-900 border border-zinc-700/80 p-4 rounded-xl space-y-3 animate-fade-in max-w-md"
        >
          <h3 className="text-sm font-semibold text-zinc-200">Create New Album</h3>
          <div>
            <label className="text-[11px] text-zinc-400 block mb-1">Album Title</label>
            <input
              type="text"
              required
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Kyoto Trip 2024"
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-[11px] text-zinc-400 block mb-1">Description (Optional)</label>
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Memories and highlights..."
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex items-center justify-end space-x-2 pt-2">
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              className="px-3 py-1.5 text-xs rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-3.5 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg shadow-sm"
            >
              Create
            </button>
          </div>
        </form>
      )}

      {/* Albums Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {albums.map((album) => {
          // Find cover asset
          const coverAsset =
            assets.find((a) => a.id === album.coverAssetId) ||
            assets.find((a) => a.albumIds.includes(album.id));

          return (
            <div
              key={album.id}
              onClick={() => setSelectedAlbumId(album.id)}
              className="group bg-zinc-900 border border-zinc-800/90 rounded-2xl overflow-hidden hover:border-zinc-700 hover:shadow-xl transition-all cursor-pointer flex flex-col"
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
                  <FolderArchive className="w-12 h-12 text-zinc-700" />
                )}

                {/* Badge */}
                <div className="absolute top-2.5 right-2.5">
                  <span className="bg-black/70 backdrop-blur-md px-2 py-0.5 rounded-full text-xs font-mono text-zinc-300 flex items-center space-x-1">
                    <Layers className="w-3 h-3 text-amber-400" />
                    <span>{album.assetCount}</span>
                  </span>
                </div>
              </div>

              {/* Album Info */}
              <div className="p-4 flex-1 flex flex-col justify-between">
                <div>
                  <h3 className="font-semibold text-zinc-100 group-hover:text-blue-400 transition-colors text-base truncate">
                    {album.title}
                  </h3>
                  {album.description && (
                    <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                      {album.description}
                    </p>
                  )}
                </div>

                <div className="mt-4 pt-3 border-t border-zinc-800/80 flex items-center justify-between text-[11px] text-zinc-500">
                  <span className="flex items-center space-x-1">
                    <Calendar className="w-3 h-3" />
                    <span>{new Date(album.createdAt).toLocaleDateString()}</span>
                  </span>
                  {album.isSystem && (
                    <span className="text-blue-400 font-mono flex items-center space-x-0.5">
                      <Sparkles className="w-3 h-3" />
                      <span>Takeout</span>
                    </span>
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
