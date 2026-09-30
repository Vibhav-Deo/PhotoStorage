import React from 'react';
import {
  Image as ImageIcon,
  FolderArchive,
  Search,
  HardDriveDownload,
  Trash2,
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

  const navItems: { id: NavTab; label: string; icon: React.ReactNode }[] = [
    { id: 'timeline', label: 'Timeline', icon: <ImageIcon className="w-4 h-4" /> },
    { id: 'albums', label: 'Albums', icon: <FolderArchive className="w-4 h-4" /> },
    { id: 'search', label: 'Search', icon: <Search className="w-4 h-4" /> },
    { id: 'reclaim', label: 'Reclaim', icon: <Trash2 className="w-4 h-4" /> },
  ];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/[0.08] bg-[#09090b]/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto h-14 px-4 sm:px-6 flex items-center justify-between gap-4">
        {/* Zone 1: Brand (Single wordmark text element, no badges, no tagline) */}
        <div
          onClick={() => setActiveTab('timeline')}
          className="flex items-center gap-2.5 cursor-pointer select-none group"
        >
          <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-white/[0.1] flex items-center justify-center text-zinc-200 group-hover:border-zinc-500 transition-colors">
            <ImageIcon className="w-4 h-4 text-blue-400" />
          </div>
          <span className="font-semibold text-sm tracking-tight text-white">
            Photo Archive
          </span>
        </div>

        {/* Zone 2: Navigation Links (Clean text with subtle active indicator) */}
        <nav className="flex items-center gap-1 sm:gap-2">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`relative flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150 ${
                  isActive
                    ? 'text-white bg-white/[0.08] shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03]'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Primary Actions & Clean Tabular Stats */}
        <div className="flex items-center gap-3">
          <div className="hidden lg:flex items-center gap-2 text-xs text-zinc-400 font-mono tabular-nums">
            <span>{storageStats.verifiedAssets} items</span>
            <span className="text-zinc-600">·</span>
            <span>{formatBytes(storageStats.totalBytes)}</span>
          </div>

          <button
            onClick={openTakeoutModal}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 active:bg-blue-700 rounded-md shadow-sm transition-colors cursor-pointer"
          >
            <HardDriveDownload className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Import Takeout</span>
            <span className="sm:hidden">Import</span>
          </button>
        </div>
      </div>
    </header>
  );
};
