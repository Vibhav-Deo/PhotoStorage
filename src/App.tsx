import React, { useState, useEffect } from 'react';
import { Navbar, type NavTab } from './components/Navbar.tsx';
import { TimelineView } from './components/TimelineView.tsx';
import { AlbumsView } from './components/AlbumsView.tsx';
import { SearchView } from './components/SearchView.tsx';
import { SpaceReclamationView } from './components/SpaceReclamationView.tsx';
import { AssetDetailModal } from './components/AssetDetailModal.tsx';
import { TakeoutImportModal } from './components/TakeoutImportModal.tsx';
import { archiveStore } from './services/archiveStore.ts';
import type { MediaAsset, Album, SpaceReclaimAuditRecord } from './types/index.ts';

export function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<NavTab>('timeline');
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [audits, setAudits] = useState<SpaceReclaimAuditRecord[]>([]);
  const [storageStats, setStorageStats] = useState(archiveStore.getStorageStats());
  const [selectedAsset, setSelectedAsset] = useState<MediaAsset | null>(null);
  const [isTakeoutModalOpen, setIsTakeoutModalOpen] = useState(false);

  // Sync state with archiveStore
  const refreshState = () => {
    setAssets(archiveStore.getAssets());
    setAlbums(archiveStore.getAlbums());
    setAudits(archiveStore.getAuditRecords());
    setStorageStats(archiveStore.getStorageStats());
  };

  useEffect(() => {
    refreshState();
    const unsubscribe = archiveStore.subscribe(() => {
      refreshState();
    });
    return unsubscribe;
  }, []);

  const handleToggleFavorite = (assetId: string) => {
    archiveStore.toggleFavorite(assetId);
    if (selectedAsset && selectedAsset.id === assetId) {
      setSelectedAsset(archiveStore.getAssetById(assetId) || null);
    }
  };

  const handleCreateAlbum = (title: string, description?: string) => {
    archiveStore.createAlbum(title, description);
  };

  const handleReclaimSpace = (assetIds: string[]) => {
    archiveStore.reclaimSpace(assetIds);
    if (selectedAsset && assetIds.includes(selectedAsset.id)) {
      setSelectedAsset(archiveStore.getAssetById(selectedAsset.id) || null);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col selection:bg-blue-600 selection:text-white">
      {/* Navbar with tabs and storage meters */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        openTakeoutModal={() => setIsTakeoutModalOpen(true)}
        storageStats={storageStats}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 pt-5">
        {activeTab === 'timeline' && (
          <TimelineView
            assets={assets}
            onSelectAsset={(asset) => setSelectedAsset(asset)}
            onToggleFavorite={handleToggleFavorite}
          />
        )}

        {activeTab === 'albums' && (
          <AlbumsView
            albums={albums}
            assets={assets}
            onCreateAlbum={handleCreateAlbum}
            onSelectAsset={(asset) => setSelectedAsset(asset)}
          />
        )}

        {activeTab === 'search' && (
          <SearchView
            assets={assets}
            onSelectAsset={(asset) => setSelectedAsset(asset)}
          />
        )}

        {activeTab === 'reclaim' && (
          <SpaceReclamationView
            assets={assets}
            auditRecords={audits}
            onReclaimSelected={handleReclaimSpace}
            storageStats={storageStats}
          />
        )}
      </main>

      {/* Detail / Fullscreen Inspector Modal */}
      {selectedAsset && (
        <AssetDetailModal
          asset={selectedAsset}
          onClose={() => setSelectedAsset(null)}
          onToggleFavorite={handleToggleFavorite}
          onReclaimSingle={(id) => handleReclaimSpace([id])}
        />
      )}

      {/* Google Takeout / Ingest Modal */}
      <TakeoutImportModal
        isOpen={isTakeoutModalOpen}
        onClose={() => setIsTakeoutModalOpen(false)}
        onImportComplete={refreshState}
      />
    </div>
  );
}

export default App;
