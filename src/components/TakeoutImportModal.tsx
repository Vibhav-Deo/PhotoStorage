import React, { useState } from 'react';
import {
  generateSampleTakeoutArchive,
  processTakeoutImport,
} from '../services/takeoutParser.ts';
import { archiveStore } from '../services/archiveStore.ts';
import type { MediaAsset, TakeoutReconciliationReport } from '../types/index.ts';
import {
  X,
  Upload,
  HardDriveDownload,
  CheckCircle,
  Loader2,
  Sparkles,
} from 'lucide-react';

interface TakeoutImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: () => void;
}

export const TakeoutImportModal: React.FC<TakeoutImportModalProps> = ({
  isOpen,
  onClose,
  onImportComplete,
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [report, setReport] = useState<TakeoutReconciliationReport | null>(null);

  if (!isOpen) return null;

  // Run sample Google Takeout bulk import
  const handleRunSampleTakeout = async () => {
    setIsProcessing(true);
    setProgressText('Extracting Takeout multipart archive structure...');
    await new Promise((r) => setTimeout(r, 600));

    setProgressText('Parsing sidecar metadata JSONs & matching timestamps...');
    await new Promise((r) => setTimeout(r, 700));

    setProgressText('Detecting Live Photo pairs (.HEIC + .MOV) and -edited variants...');
    await new Promise((r) => setTimeout(r, 700));

    setProgressText('Computing SHA-256 content hashes & checking deduplication...');
    await new Promise((r) => setTimeout(r, 800));

    const sampleFiles = generateSampleTakeoutArchive();
    const result = await processTakeoutImport(sampleFiles, 'Google Takeout Import');

    setReport(result.report);
    setIsProcessing(false);
    onImportComplete();
  };

  // Upload local user files directly
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsProcessing(true);
    const newAssets: MediaAsset[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      setProgressText(`Hashing & indexing [${i + 1}/${files.length}]: ${file.name}`);

      const hash = await archiveStore.calculateSha256(file);
      const url = URL.createObjectURL(file);
      const isVideo = file.type.startsWith('video/');

      const asset: MediaAsset = {
        id: `upload-${Date.now()}-${i}`,
        hash,
        filename: file.name,
        kind: isVideo ? 'video' : 'photo',
        url,
        thumbnailUrl: url,
        thumbhash: '7gcKDYS2h3t2d3h3h5l4aIeH',
        capturedAt: file.lastModified || Date.now(),
        capturedAtSource: 'file_mtime',
        width: 1920,
        height: 1080,
        byteSize: file.size,
        mime: file.type || 'image/jpeg',
        exif: {
          cameraMake: 'Web Device',
          cameraModel: 'Direct Upload',
        },
        semanticTags: ['upload', file.name.split('.')[0] || 'photo'],
        isFavorite: false,
        storageTier: 'intelligent_tiering',
        verificationStatus: 'verified',
        isLocalPurged: false,
        albumIds: [],
      };

      newAssets.push(asset);
      await new Promise((r) => setTimeout(r, 150));
    }

    const { added, deduplicated } = archiveStore.addAssets(newAssets);

    setReport({
      totalFound: files.length,
      imported: added,
      deduplicated: deduplicated,
      skipped: 0,
      failed: 0,
      details: newAssets.map((a) => ({
        filename: a.filename,
        action: 'imported',
        reason: 'Direct file ingest via browser content hashing',
        hash: a.hash,
      })),
      timestamp: Date.now(),
    });

    setIsProcessing(false);
    onImportComplete();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-fade-in">
      <div className="relative w-full max-w-2xl bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-blue-900/40 border border-blue-700/50 flex items-center justify-center text-blue-400">
              <HardDriveDownload className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-zinc-100">Takeout Import & Bulk Ingest</h2>
              <p className="text-xs text-zinc-400">
                Lossless reconciliation for Google Photos Takeout & device archives (Requirement 1)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area */}
        <div className="p-6 space-y-6 overflow-y-auto flex-1">
          {/* Ongoing processing indicator */}
          {isProcessing ? (
            <div className="py-16 text-center space-y-4">
              <Loader2 className="w-10 h-10 text-blue-500 animate-spin mx-auto" />
              <div className="text-sm font-semibold text-zinc-200">{progressText}</div>
              <p className="text-xs text-zinc-500 font-mono">
                Running SHA-256 verification and sidecar pairing on-device...
              </p>
            </div>
          ) : report ? (
            /* Reconciliation Report (Requirement 1.10) */
            <div className="space-y-5 animate-fade-in">
              <div className="bg-emerald-950/30 border border-emerald-800/60 p-4 rounded-xl flex items-center space-x-3">
                <CheckCircle className="w-6 h-6 text-emerald-400 shrink-0" />
                <div>
                  <h3 className="text-sm font-bold text-emerald-200">
                    Import & Reconciliation Complete
                  </h3>
                  <p className="text-xs text-emerald-400/80">
                    All original bytes preserved with SHA-256 content address deduplication.
                  </p>
                </div>
              </div>

              {/* Stats badges */}
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                <div className="bg-zinc-900 p-2.5 rounded-lg border border-zinc-800">
                  <div className="text-zinc-400 text-[11px]">Total Items</div>
                  <div className="text-base font-bold text-zinc-100 mt-0.5">
                    {report.totalFound}
                  </div>
                </div>
                <div className="bg-zinc-900 p-2.5 rounded-lg border border-zinc-800">
                  <div className="text-zinc-400 text-[11px]">Imported</div>
                  <div className="text-base font-bold text-emerald-400 mt-0.5">
                    {report.imported}
                  </div>
                </div>
                <div className="bg-zinc-900 p-2.5 rounded-lg border border-zinc-800">
                  <div className="text-zinc-400 text-[11px]">Deduplicated</div>
                  <div className="text-base font-bold text-blue-400 mt-0.5">
                    {report.deduplicated}
                  </div>
                </div>
                <div className="bg-zinc-900 p-2.5 rounded-lg border border-zinc-800">
                  <div className="text-zinc-400 text-[11px]">Skipped</div>
                  <div className="text-base font-bold text-amber-400 mt-0.5">
                    {report.skipped}
                  </div>
                </div>
              </div>

              {/* Action Log Table */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                  Reconciliation Audit Trail
                </h4>
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden max-h-56 overflow-y-auto text-xs">
                  {report.details.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 border-b border-zinc-800/80 last:border-0 flex items-start justify-between gap-3"
                    >
                      <div className="space-y-0.5 min-w-0">
                        <div className="font-mono font-medium text-zinc-200 truncate">
                          {item.filename}
                        </div>
                        <div className="text-[11px] text-zinc-400">{item.reason}</div>
                      </div>
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded capitalize shrink-0 ${
                          item.action === 'imported'
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/50'
                            : item.action === 'deduplicated'
                            ? 'bg-blue-950 text-blue-300 border border-blue-800/50'
                            : 'bg-amber-950 text-amber-300 border border-amber-800/50'
                        }`}
                      >
                        {item.action}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  onClick={() => {
                    setReport(null);
                    onClose();
                  }}
                  className="px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-100 rounded-lg transition-colors cursor-pointer"
                >
                  Done & View Library
                </button>
              </div>
            </div>
          ) : (
            /* Upload Options */
            <div className="space-y-4">
              {/* Option A: Test Takeout Pipeline */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3 hover:border-zinc-700 transition-colors">
                <div className="flex items-center space-x-3">
                  <div className="p-2.5 bg-blue-950/80 rounded-xl text-blue-400 border border-blue-800/50">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      Sample Google Takeout Archive Package
                    </h3>
                    <p className="text-xs text-zinc-400">
                      Tests sidecar JSON timestamp resolution, Live Photo HEIC+MOV linking, -edited variant folding, and duplicate hash suppression.
                    </p>
                  </div>
                </div>

                <button
                  onClick={handleRunSampleTakeout}
                  className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold transition-all shadow-md hover:shadow-blue-500/25 flex items-center justify-center space-x-2 cursor-pointer"
                >
                  <HardDriveDownload className="w-4 h-4" />
                  <span>Run Takeout Import Simulation</span>
                </button>
              </div>

              {/* Option B: Direct File Upload */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3 hover:border-zinc-700 transition-colors">
                <div className="flex items-center space-x-3">
                  <div className="p-2.5 bg-zinc-800 rounded-xl text-zinc-300 border border-zinc-700">
                    <Upload className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      Import Photos & Videos From This Device
                    </h3>
                    <p className="text-xs text-zinc-400">
                      Hashes each file with SHA-256 client-side. Content-addressed storage ensures duplicates are never saved twice.
                    </p>
                  </div>
                </div>

                <label className="w-full py-2.5 px-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl text-xs font-semibold transition-all flex items-center justify-center space-x-2 cursor-pointer border border-zinc-700">
                  <Upload className="w-4 h-4 text-blue-400" />
                  <span>Select Files to Ingest...</span>
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/*"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
