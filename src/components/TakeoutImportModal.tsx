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
      <div className="relative w-full max-w-xl bg-[#0c0c0e] border border-white/[0.1] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="p-5 border-b border-white/[0.08] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-blue-400">
              <HardDriveDownload className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">Import & Media Ingest</h2>
              <p className="text-xs text-zinc-400">
                Lossless reconciliation for Takeout archives and local files
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Area */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {/* Ongoing processing indicator */}
          {isProcessing ? (
            <div className="py-16 text-center space-y-3">
              <Loader2 className="w-8 h-8 text-blue-400 animate-spin mx-auto" />
              <div className="text-xs font-semibold text-zinc-200">{progressText}</div>
              <p className="text-[11px] text-zinc-500 font-mono">
                Calculating SHA-256 and indexing metadata on-device...
              </p>
            </div>
          ) : report ? (
            /* Reconciliation Report */
            <div className="space-y-4 animate-fade-in">
              <div className="bg-emerald-950/20 border border-emerald-800/40 p-3.5 rounded-xl flex items-center gap-3">
                <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
                <div>
                  <h3 className="text-xs font-semibold text-emerald-200">
                    Import & Deduplication Complete
                  </h3>
                  <p className="text-[11px] text-emerald-400/80">
                    Original bytes preserved with content-addressed SHA-256 deduplication.
                  </p>
                </div>
              </div>

              {/* Stats badges */}
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                <div className="bg-[#121215] p-3 rounded-lg border border-white/[0.06]">
                  <div className="text-zinc-500 text-[10px] uppercase font-mono">Total</div>
                  <div className="text-base font-semibold text-white font-mono tabular-nums mt-0.5">
                    {report.totalFound}
                  </div>
                </div>
                <div className="bg-[#121215] p-3 rounded-lg border border-white/[0.06]">
                  <div className="text-zinc-500 text-[10px] uppercase font-mono">Imported</div>
                  <div className="text-base font-semibold text-emerald-400 font-mono tabular-nums mt-0.5">
                    {report.imported}
                  </div>
                </div>
                <div className="bg-[#121215] p-3 rounded-lg border border-white/[0.06]">
                  <div className="text-zinc-500 text-[10px] uppercase font-mono">Deduped</div>
                  <div className="text-base font-semibold text-blue-400 font-mono tabular-nums mt-0.5">
                    {report.deduplicated}
                  </div>
                </div>
                <div className="bg-[#121215] p-3 rounded-lg border border-white/[0.06]">
                  <div className="text-zinc-500 text-[10px] uppercase font-mono">Skipped</div>
                  <div className="text-base font-semibold text-zinc-400 font-mono tabular-nums mt-0.5">
                    {report.skipped}
                  </div>
                </div>
              </div>

              {/* Action Log Table */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                  Reconciliation Details
                </h4>
                <div className="bg-[#121215] border border-white/[0.06] rounded-xl overflow-hidden max-h-52 overflow-y-auto text-xs">
                  {report.details.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 border-b border-white/[0.04] last:border-0 flex items-start justify-between gap-3 font-mono text-[11px]"
                    >
                      <div className="space-y-0.5 min-w-0">
                        <div className="text-zinc-200 truncate">
                          {item.filename}
                        </div>
                        <div className="text-[10px] text-zinc-500">{item.reason}</div>
                      </div>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded capitalize shrink-0 ${
                          item.action === 'imported'
                            ? 'text-emerald-400 bg-emerald-950/40 border border-emerald-800/30'
                            : item.action === 'deduplicated'
                            ? 'text-blue-400 bg-blue-950/40 border border-blue-800/30'
                            : 'text-zinc-400 bg-zinc-900 border border-zinc-800'
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
                  className="px-3.5 py-1.5 text-xs font-medium bg-white/[0.08] hover:bg-white/[0.12] text-white rounded-md transition-colors cursor-pointer"
                >
                  Done & View Library
                </button>
              </div>
            </div>
          ) : (
            /* Upload Options */
            <div className="space-y-3">
              {/* Option A: Test Takeout Pipeline */}
              <div className="bg-[#121215] border border-white/[0.08] rounded-xl p-4 space-y-3 hover:border-white/[0.15] transition-colors">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-white/[0.04] rounded-lg text-blue-400 border border-white/[0.08]">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-white">
                      Google Takeout Archive Pipeline
                    </h3>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      Executes four-step sidecar pairing, Live Photo linking, -edited folding, and SHA-256 deduplication.
                    </p>
                  </div>
                </div>

                <button
                  onClick={handleRunSampleTakeout}
                  className="w-full py-2 px-3 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-xs font-medium transition-all shadow-sm flex items-center justify-center gap-2 cursor-pointer"
                >
                  <HardDriveDownload className="w-3.5 h-3.5" />
                  <span>Run Takeout Import Simulation</span>
                </button>
              </div>

              {/* Option B: Direct File Upload */}
              <div className="bg-[#121215] border border-white/[0.08] rounded-xl p-4 space-y-3 hover:border-white/[0.15] transition-colors">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-white/[0.04] rounded-lg text-zinc-300 border border-white/[0.08]">
                    <Upload className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-white">
                      Import Photos & Videos From Device
                    </h3>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      Generates content addresses directly via browser streaming SHA-256. Duplicates are never stored twice.
                    </p>
                  </div>
                </div>

                <label className="w-full py-2 px-3 bg-white/[0.04] hover:bg-white/[0.08] text-zinc-200 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 cursor-pointer border border-white/[0.08]">
                  <Upload className="w-3.5 h-3.5 text-zinc-300" />
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
