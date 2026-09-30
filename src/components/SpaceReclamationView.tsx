import React, { useState } from 'react';
import type { MediaAsset, SpaceReclaimAuditRecord } from '../types/index.ts';
import {
  CheckCircle,
  AlertTriangle,
  History,
  Trash2,
} from 'lucide-react';

interface SpaceReclamationViewProps {
  assets: MediaAsset[];
  auditRecords: SpaceReclaimAuditRecord[];
  onReclaimSelected: (assetIds: string[]) => void;
  storageStats: {
    totalBytes: number;
    localBytes: number;
    reclaimedBytes: number;
    purgedAssets: number;
    verifiedAssets: number;
  };
}

export const SpaceReclamationView: React.FC<SpaceReclamationViewProps> = ({
  assets,
  auditRecords,
  onReclaimSelected,
  storageStats,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Eligible assets: must be verified in cloud AND not yet purged from device
  const eligibleAssets = assets.filter(
    (a) => a.verificationStatus === 'verified' && !a.isLocalPurged,
  );

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const selectAllEligible = () => {
    setSelectedIds(new Set(eligibleAssets.map((a) => a.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  // Bytes that would be freed by currently selected assets
  const selectedBytes = Array.from(selectedIds).reduce((acc, id) => {
    const asset = assets.find((a) => a.id === id);
    return acc + (asset ? asset.byteSize : 0);
  }, 0);

  const handleConfirmPurge = () => {
    onReclaimSelected(Array.from(selectedIds));
    setSelectedIds(new Set());
    setShowConfirmModal(false);
  };

  return (
    <div className="space-y-8 pb-24">
      {/* Top Header & Metrics Dashboard */}
      <div className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-200">
              Verified Space Reclamation
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5 max-w-2xl">
              Safely reclaim local device storage. Deletions are permitted only after remote S3 SHA-256 checksum verification and cached derivative confirmation.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              disabled={selectedIds.size === 0}
              onClick={() => setShowConfirmModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:pointer-events-none text-white text-xs font-medium transition-all shadow-sm cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Purge Selected ({formatBytes(selectedBytes)})</span>
            </button>
          </div>
        </div>

        {/* 3 Metric Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-4 rounded-xl bg-[#121215] border border-white/[0.08]">
            <div className="text-xs text-zinc-400">Total Cloud Archive</div>
            <div className="text-lg font-semibold text-white font-mono tabular-nums mt-1">
              {formatBytes(storageStats.totalBytes)}
            </div>
            <div className="text-[11px] text-zinc-500 font-mono mt-0.5">
              {storageStats.verifiedAssets} objects stored
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#121215] border border-white/[0.08]">
            <div className="text-xs text-zinc-400">Total Space Reclaimed</div>
            <div className="text-lg font-semibold text-emerald-400 font-mono tabular-nums mt-1">
              {formatBytes(storageStats.reclaimedBytes)}
            </div>
            <div className="text-[11px] text-zinc-500 font-mono mt-0.5">
              Permanently freed on device
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#121215] border border-white/[0.08]">
            <div className="text-xs text-zinc-400">Eligible for Purge</div>
            <div className="text-lg font-semibold text-zinc-200 font-mono tabular-nums mt-1">
              {formatBytes(eligibleAssets.reduce((s, a) => s + a.byteSize, 0))}
            </div>
            <div className="text-[11px] text-zinc-500 font-mono mt-0.5">
              {eligibleAssets.length} verified local originals
            </div>
          </div>
        </div>
      </div>

      {/* Eligible Items for Reclamation */}
      <div className="space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-zinc-300">Eligible Items</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-500 font-mono tabular-nums">{eligibleAssets.length} verified</span>
          </div>

          {eligibleAssets.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={selectAllEligible}
                className="px-2.5 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 border border-white/[0.06] transition-colors"
              >
                Select All
              </button>
              <button
                onClick={clearSelection}
                className="px-2.5 py-1 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {/* Eligible Assets Table/List */}
        {eligibleAssets.length === 0 ? (
          <div className="text-center py-16 bg-[#121215]/50 rounded-xl border border-white/[0.06]">
            <CheckCircle className="w-6 h-6 text-emerald-400 mx-auto mb-2 opacity-80" />
            <p className="text-xs text-zinc-300 font-medium">All verified space is currently reclaimed</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Incoming media becomes eligible automatically once remote checksum verification completes.
            </p>
          </div>
        ) : (
          <div className="bg-[#121215] border border-white/[0.08] rounded-xl overflow-hidden divide-y divide-white/[0.06]">
            {eligibleAssets.map((asset) => {
              const isSelected = selectedIds.has(asset.id);
              return (
                <div
                  key={asset.id}
                  onClick={() => toggleSelect(asset.id)}
                  className={`p-3 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                    isSelected ? 'bg-blue-600/10' : 'hover:bg-white/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(asset.id)}
                      className="rounded bg-zinc-900 border-zinc-700 text-blue-600 focus:ring-0 cursor-pointer"
                    />
                    <img
                      src={asset.thumbnailUrl}
                      alt={asset.filename}
                      className="w-10 h-10 rounded-md object-cover bg-zinc-950 shrink-0 border border-white/[0.08]"
                    />
                    <div className="min-w-0 space-y-0.5">
                      <div className="text-xs font-mono text-zinc-200 truncate">
                        {asset.filename}
                      </div>
                      <div className="text-[11px] text-zinc-500 flex items-center gap-1.5 font-mono tabular-nums">
                        <span>{new Date(asset.capturedAt).toLocaleDateString()}</span>
                        <span className="text-zinc-700">·</span>
                        <span>{formatBytes(asset.byteSize)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="text-[11px] font-mono tabular-nums text-emerald-400">
                      Verified SHA-256
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* User-Inspectable Audit Trail (Requirement 6.10) */}
      <div className="space-y-3 pt-6 border-t border-white/[0.06]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-zinc-400" />
            <h3 className="font-semibold text-zinc-200 text-xs uppercase tracking-wider">
              Reclamation Audit Trail
            </h3>
            <span className="text-xs text-zinc-500 font-mono tabular-nums">({auditRecords.length} records)</span>
          </div>
          <span className="text-[11px] text-zinc-500 font-mono">Immutable Log</span>
        </div>

        <div className="bg-[#121215] border border-white/[0.08] rounded-xl overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#09090b] text-zinc-400 border-b border-white/[0.06] font-mono text-[11px]">
              <tr>
                <th className="p-3">Timestamp</th>
                <th className="p-3">SHA-256 Content Key</th>
                <th className="p-3">Verification Method</th>
                <th className="p-3">Bytes Freed</th>
                <th className="p-3 text-right">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04] text-zinc-300 font-mono text-[11px] tabular-nums">
              {auditRecords.map((audit) => (
                <tr key={audit.id} className="hover:bg-white/[0.02]">
                  <td className="p-3 whitespace-nowrap text-zinc-400">
                    {new Date(audit.freedAt).toLocaleTimeString()} {new Date(audit.freedAt).toLocaleDateString()}
                  </td>
                  <td className="p-3 text-zinc-300 max-w-[200px] truncate" title={audit.hash}>
                    {audit.hash}
                  </td>
                  <td className="p-3 text-zinc-400">
                    {audit.verificationMethod === 'provider_checksum'
                      ? 'AWS S3 Checksum SHA-256'
                      : 'Hash Readback'}
                  </td>
                  <td className="p-3 text-emerald-400">
                    {formatBytes(audit.byteSize)}
                  </td>
                  <td className="p-3 text-right text-emerald-400 font-medium">
                    Verified Purge
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
          <div className="bg-[#121215] border border-white/[0.1] rounded-xl max-w-md w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-400">
              <div className="p-2 rounded-lg bg-rose-950/60 border border-rose-800/40">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-semibold text-white">
                Confirm Local Space Reclamation
              </h3>
            </div>

            <div className="text-xs text-zinc-300 space-y-2.5 leading-relaxed">
              <p>
                Purging <strong className="text-white">{selectedIds.size} local files</strong> will free <strong className="text-emerald-400 font-mono">{formatBytes(selectedBytes)}</strong> on this device.
              </p>
              <div className="bg-[#09090b] p-3 rounded-lg border border-white/[0.06] text-[11px] text-zinc-400 space-y-1">
                <div className="font-medium text-zinc-300">Safety Guarantees:</div>
                <p>• Byte-for-byte SHA-256 checksums confirmed in AWS S3.</p>
                <p>• Fast thumbnails and 2048px previews remain accessible.</p>
                <p>• If iCloud sync is active, purging locally prompts standard Photos deletion.</p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmPurge}
                className="px-3.5 py-1.5 rounded-md text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white shadow-sm transition-all cursor-pointer"
              >
                Confirm & Reclaim {formatBytes(selectedBytes)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
