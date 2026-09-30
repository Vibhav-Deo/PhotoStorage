import React, { useState, useEffect } from 'react';
import { Navbar, type NavTab } from './components/Navbar.tsx';
import { TimelineView } from './components/TimelineView.tsx';
import { AlbumsView } from './components/AlbumsView.tsx';
import { SearchView } from './components/SearchView.tsx';
import { SpaceReclamationView } from './components/SpaceReclamationView.tsx';
import { AssetDetailModal } from './components/AssetDetailModal.tsx';
import { TakeoutImportModal } from './components/TakeoutImportModal.tsx';
import { archiveStore } from './services/archiveStore.ts';
import {
  completeSignIn,
  getStoredSession,
  signOut,
  startSignIn,
  type WebAuthSession,
} from './services/cognitoAuth.ts';
import type { MediaAsset, Album, SpaceReclaimAuditRecord } from './types/index.ts';

export function App(): React.ReactElement {
  const [authSession, setAuthSession] = useState<WebAuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('timeline');
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [audits, setAudits] = useState<SpaceReclaimAuditRecord[]>([]);
  const [storageStats, setStorageStats] = useState(archiveStore.getStorageStats());
  const [selectedAsset, setSelectedAsset] = useState<MediaAsset | null>(null);
  const [isTakeoutModalOpen, setIsTakeoutModalOpen] = useState(false);

  useEffect(() => {
    completeSignIn()
      .then((session) => setAuthSession(session ?? getStoredSession()))
      .catch((error: unknown) => {
        setAuthError(error instanceof Error ? error.message : 'Sign-in failed');
      })
      .finally(() => setAuthLoading(false));
  }, []);

  if (authLoading) {
    return <div className="min-h-screen bg-[#09090b] text-zinc-100 p-8">Checking sign-in...</div>;
  }

  if (!authSession) {
    return (
      <div className="min-h-screen bg-[#09090b] text-zinc-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-8">
          <p className="text-sm uppercase tracking-[0.2em] text-zinc-500">Photo Archive</p>
          <h1 className="mt-3 text-3xl font-semibold">Your private library</h1>
          <p className="mt-3 text-zinc-400">Sign in to access your archive.</p>
          {authError && <p className="mt-4 text-sm text-red-400">{authError}</p>}
          <button
            className="mt-8 w-full rounded-lg bg-white px-4 py-3 font-medium text-black hover:bg-zinc-200"
            onClick={() => {
              setAuthError(null);
              void startSignIn().catch((error: unknown) => {
                setAuthError(error instanceof Error ? error.message : 'Unable to start sign-in');
              });
            }}
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

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
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col selection:bg-blue-600 selection:text-white">
      {/* Navbar with tabs and storage meters */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        openTakeoutModal={() => setIsTakeoutModalOpen(true)}
        storageStats={storageStats}
      />

      <button
        className="fixed right-4 top-4 z-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
        onClick={() => void signOut(authSession).then(() => setAuthSession(null))}
      >
        Sign out
      </button>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 pt-6">
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
          <SearchView assets={assets} onSelectAsset={(asset) => setSelectedAsset(asset)} />
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
