import React from 'react';
import {
  Image as ImageIcon,
  FolderArchive,
  Search,
  HardDriveDownload,
  Trash2,
  CloudCheck,
  Upload,
} from 'lucide-react';

export type NavTab = 'timeline' | 'albums' | 'search' | 'reclaim';

interface NavbarProps {
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  openTakeoutModal: () => void;
  storageStats: {
    totalBytes: number;
    localBytes: number;
    reclaimedBytes: number;
    totalAssets: number;
    verifiedAssets: number;
  };
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  openTakeoutModal,
  storageStats,
}) => {
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md px-4 sm:px-6 py-3 transition-colors">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Brand / Logo */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3 cursor-pointer" onClick={() => setActiveTab('timeline')}>
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-blue-500/20 text-white font-bold">
              <ImageIcon className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-semibold text-zinc-100 text-lg tracking-tight">Photo Archive</span>
                <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-blue-950 text-blue-300 border border-blue-800/60">
                  v1.0 Local-First
                </span>
              </div>
              <p className="text-xs text-zinc-400">Content-Addressed • Zero-Knowledge Storage</p>
            </div>
          </div>

          {/* Quick upload button on mobile */}
          <button
            onClick={openTakeoutModal}
            className="md:hidden flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import</span>
          </button>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex items-center space-x-1 sm:space-x-2 overflow-x-auto py-1 scrollbar-none">
          <button
            onClick={() => setActiveTab('timeline')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'timeline'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <ImageIcon className="w-4 h-4 text-blue-400" />
            <span>Timeline</span>
          </button>

          <button
            onClick={() => setActiveTab('albums')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'albums'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <FolderArchive className="w-4 h-4 text-amber-400" />
            <span>Albums</span>
          </button>

          <button
            onClick={() => setActiveTab('search')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'search'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <Search className="w-4 h-4 text-emerald-400" />
            <span>Semantic Search</span>
          </button>

          <button
            onClick={() => setActiveTab('reclaim')}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'reclaim'
                ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <Trash2 className="w-4 h-4 text-rose-400" />
            <span>Reclaim Space</span>
          </button>
        </nav>

        {/* Action Controls & Storage stats */}
        <div className="hidden md:flex items-center space-x-3">
          <div className="text-right text-xs">
            <div className="flex items-center space-x-1.5 text-zinc-300">
              <CloudCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>{storageStats.verifiedAssets} Verified</span>
              <span className="text-zinc-600">•</span>
              <span className="text-zinc-400">{formatBytes(storageStats.totalBytes)}</span>
            </div>
            <div className="text-[11px] text-zinc-500">
              {formatBytes(storageStats.reclaimedBytes)} reclaimed
            </div>
          </div>

          <button
            onClick={openTakeoutModal}
            className="flex items-center space-x-2 px-3.5 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg shadow-sm hover:shadow-blue-500/25 transition-all cursor-pointer"
          >
            <HardDriveDownload className="w-4 h-4" />
            <span>Google Takeout / Import</span>
          </button>
        </div>
      </div>
    </header>
  );
};
