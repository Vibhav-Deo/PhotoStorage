import React, { useState } from 'react';
import type { MediaAsset, SpaceReclaimAuditRecord } from '../types/index.ts';
import {
  ShieldCheck,
  Cloud,
  CheckCircle,
  AlertTriangle,
  History,
  Trash2,
  Lock,
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
    <div className="space-y-6 pb-20">
      {/* Header Overview */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
              <h2 className="text-xl font-bold text-zinc-100">Verified Space Reclamation</h2>
            </div>
            <p className="text-xs text-zinc-400 max-w-2xl leading-relaxed">
              Safely delete local originals that have been independently verified against AWS S3 via SHA-256 readback checksums. Browse thumbnails, metadata, and preview caches are retained indefinitely (Requirement 6).
            </p>
          </div>

          <div className="flex items-center space-x-3 bg-zinc-950 px-4 py-3 rounded-xl border border-zinc-800 shrink-0">
            <div className="text-right">
              <div className="text-xs text-zinc-400">Total Space Reclaimed</div>
              <div className="text-lg font-bold text-emerald-400 font-mono">
                {formatBytes(storageStats.reclaimedBytes)}
              </div>
            </div>
            <Cloud className="w-6 h-6 text-emerald-400/80" />
          </div>
        </div>

        {/* Verification Architecture Checklist */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3 border-t border-zinc-800 text-xs">
          <div className="flex items-start space-x-2 text-zinc-300">
            <CheckCircle className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold text-zinc-200">1. SHA-256 Checksum Verified</span>
              <p className="text-[11px] text-zinc-500">Bytes match byte-for-byte in remote S3 bucket.</p>
            </div>
          </div>
          <div className="flex items-start space-x-2 text-zinc-300">
            <CheckCircle className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold text-zinc-200">2. Hot Tier Derivatives Present</span>
              <p className="text-[11px] text-zinc-500">256px thumbnail & 2048px preview stored in S3 Standard.</p>
            </div>
          </div>
          <div className="flex items-start space-x-2 text-zinc-300">
            <Lock className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
            <div>
              <span className="font-semibold text-zinc-200">3. Immutable Audit Record</span>
              <p className="text-[11px] text-zinc-500">Persisted prior to local purge; non-pruned trail.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Eligible Items for Reclamation */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-zinc-800">
          <div className="flex items-center space-x-2">
            <h3 className="font-semibold text-zinc-100 text-sm">
              Eligible for Local Purge ({eligibleAssets.length} items)
            </h3>
            <span className="text-xs text-zinc-500 font-mono">
              ({formatBytes(eligibleAssets.reduce((s, a) => s + a.byteSize, 0))} reclaimable)
            </span>
          </div>

          <div className="flex items-center space-x-2 text-xs">
            {eligibleAssets.length > 0 && (
              <>
                <button
                  onClick={selectAllEligible}
                  className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                >
                  Select All
                </button>
                <button
                  onClick={clearSelection}
                  className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
                >
                  Clear
                </button>
              </>
            )}

            <button
              disabled={selectedIds.size === 0}
              onClick={() => setShowConfirmModal(true)}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:pointer-events-none text-white font-semibold transition-all shadow-md cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>
                Purge Selected ({formatBytes(selectedBytes)})
              </span>
            </button>
          </div>
        </div>

        {/* Eligible Assets Table/List */}
        {eligibleAssets.length === 0 ? (
          <div className="text-center py-12 bg-zinc-900/40 rounded-2xl border border-zinc-800/80">
            <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-2 opacity-80" />
            <p className="text-sm text-zinc-300 font-medium">All verified space has been reclaimed!</p>
            <p className="text-xs text-zinc-500 mt-1">
              New photos ingested will become eligible once remote checksum verification completes.
            </p>
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden divide-y divide-zinc-800">
            {eligibleAssets.map((asset) => {
              const isSelected = selectedIds.has(asset.id);
              return (
                <div
                  key={asset.id}
                  onClick={() => toggleSelect(asset.id)}
                  className={`p-3 flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                    isSelected ? 'bg-blue-950/30' : 'hover:bg-zinc-850'
                  }`}
                >
                  <div className="flex items-center space-x-3 min-w-0">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(asset.id)}
                      className="rounded bg-zinc-800 border-zinc-700 text-blue-600 focus:ring-0 cursor-pointer"
                    />
                    <img
                      src={asset.thumbnailUrl}
                      alt={asset.filename}
                      className="w-12 h-12 rounded-lg object-cover bg-zinc-950 shrink-0"
                    />
                    <div className="min-w-0 space-y-0.5">
                      <div className="text-sm font-medium text-zinc-200 truncate font-mono">
                        {asset.filename}
                      </div>
                      <div className="text-xs text-zinc-400 flex items-center space-x-2">
                        <span>{new Date(asset.capturedAt).toLocaleDateString()}</span>
                        <span>•</span>
                        <span className="font-mono">{formatBytes(asset.byteSize)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="px-2 py-0.5 text-[11px] rounded bg-emerald-950 text-emerald-300 border border-emerald-800/60 font-mono">
                      Verified 100%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* User-Inspectable Audit Trail (Requirement 6.10) */}
      <div className="space-y-3 pt-6 border-t border-zinc-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <History className="w-4 h-4 text-zinc-400" />
            <h3 className="font-semibold text-zinc-200 text-sm">
              Reclamation Audit Trail ({auditRecords.length} records)
            </h3>
          </div>
          <span className="text-[11px] text-zinc-500 font-mono">Immutable Log</span>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-950 text-zinc-400 border-b border-zinc-800 font-mono">
              <tr>
                <th className="p-3">Time</th>
                <th className="p-3">SHA-256 Digest</th>
                <th className="p-3">Verification Method</th>
                <th className="p-3">Bytes Freed</th>
                <th className="p-3 text-right">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 text-zinc-300 font-mono">
              {auditRecords.map((audit) => (
                <tr key={audit.id} className="hover:bg-zinc-850">
                  <td className="p-3 whitespace-nowrap text-zinc-400">
                    {new Date(audit.freedAt).toLocaleTimeString()} {new Date(audit.freedAt).toLocaleDateString()}
                  </td>
                  <td className="p-3 text-[11px] text-zinc-300 max-w-[180px] truncate" title={audit.hash}>
                    {audit.hash}
                  </td>
                  <td className="p-3 text-[11px] text-zinc-400">
                    {audit.verificationMethod === 'provider_checksum'
                      ? 'AWS S3 Checksum SHA-256'
                      : 'Hash Readback'}
                  </td>
                  <td className="p-3 text-emerald-400 font-semibold">
                    {formatBytes(audit.byteSize)}
                  </td>
                  <td className="p-3 text-right">
                    <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/50 text-[10px]">
                      SUCCESS
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Confirmation Modal (Requirement 6.6 & 6.7) */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-fade-in">
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center space-x-3 text-rose-400">
              <div className="p-2.5 rounded-xl bg-rose-950/60 border border-rose-800/60">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <h3 className="text-base font-bold text-zinc-100">
                Confirm Local Space Reclamation
              </h3>
            </div>

            <div className="text-xs text-zinc-300 space-y-2 leading-relaxed">
              <p>
                You are about to purge <strong className="text-white">{selectedIds.size} local originals</strong>, freeing <strong className="text-emerald-400">{formatBytes(selectedBytes)}</strong> of device storage.
              </p>
              <div className="bg-zinc-900 p-3 rounded-xl border border-zinc-800 text-[11px] text-zinc-400 space-y-1">
                <div className="font-semibold text-zinc-300">Safety Disclosure (Requirement 6.7):</div>
                <p>
                  • Stored objects in S3 are verified via remote SHA-256 checksums.
                </p>
                <p>
                  • Thumbnails and 2048px previews will remain visible in your timeline.
                </p>
                <p>
                  • If iCloud Photos sync is enabled on device, purging local files will also remove them from iCloud library after 30 days.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end space-x-3 pt-2">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-semibold text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmPurge}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/20 transition-all cursor-pointer"
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
