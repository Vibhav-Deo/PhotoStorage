import React, { useState } from 'react';
import type { MediaAsset } from '../types/index.ts';
import { archiveStore } from '../services/archiveStore.ts';
import {
  X,
  Heart,
  Share2,
  HardDrive,
  Cloud,
  MapPin,
  Camera,
  Calendar,
  FileText,
  ShieldCheck,
  Download,
  Copy,
  Check,
  Sparkles,
} from 'lucide-react';

interface AssetDetailModalProps {
  asset: MediaAsset;
  onClose: () => void;
  onToggleFavorite: (assetId: string) => void;
  onReclaimSingle: (assetId: string) => void;
}

export const AssetDetailModal: React.FC<AssetDetailModalProps> = ({
  asset,
  onClose,
  onToggleFavorite,
  onReclaimSingle,
}) => {
  const [copiedHash, setCopiedHash] = useState(false);
  const [showLiveMotion, setShowLiveMotion] = useState(false);
  const keys = archiveStore.deriveObjectKeys(asset.hash);

  const copyHashToClipboard = () => {
    navigator.clipboard.writeText(asset.hash);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const capturedDate = new Date(asset.capturedAt).toLocaleString(undefined, {
    dateStyle: 'full',
    timeStyle: 'medium',
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-xl animate-fade-in p-2 sm:p-4">
      {/* Container */}
      <div className="relative w-full max-w-6xl h-[92vh] bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden flex flex-col lg:flex-row shadow-2xl">
        {/* Close Button Top Right */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 p-2 rounded-full bg-black/60 hover:bg-zinc-800 text-zinc-300 hover:text-white transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Left Side: Media Stage */}
        <div className="flex-1 bg-black flex flex-col items-center justify-center relative overflow-hidden group">
          {asset.kind === 'video' ? (
            <video
              src={asset.url}
              controls
              autoPlay
              className="max-h-full max-w-full object-contain"
            />
          ) : showLiveMotion && asset.pairedVideoUrl ? (
            <video
              src={asset.pairedVideoUrl}
              autoPlay
              loop
              muted
              playsInline
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <img
              src={asset.url}
              alt={asset.filename}
              className="max-h-full max-w-full object-contain transition-all"
            />
          )}

          {/* Live Photo motion button */}
          {asset.kind === 'live_photo' && (
            <button
              onMouseDown={() => setShowLiveMotion(true)}
              onMouseUp={() => setShowLiveMotion(false)}
              onTouchStart={() => setShowLiveMotion(true)}
              onTouchEnd={() => setShowLiveMotion(false)}
              className="absolute top-4 left-4 z-10 flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-black/70 hover:bg-black/90 border border-zinc-700 text-blue-400 text-xs font-semibold backdrop-blur-md cursor-pointer transition-all shadow-lg active:scale-95"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{showLiveMotion ? 'PLAYING LIVE' : 'HOLD FOR LIVE'}</span>
            </button>
          )}

          {/* Bottom quick actions */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center space-x-2 bg-black/70 backdrop-blur-md px-3 py-1.5 rounded-full border border-zinc-800 text-xs text-zinc-300 opacity-90 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => onToggleFavorite(asset.id)}
              className={`p-1.5 rounded-full hover:bg-zinc-800 transition-colors ${
                asset.isFavorite ? 'text-amber-400' : 'text-zinc-400 hover:text-white'
              }`}
            >
              <Heart className={`w-4 h-4 ${asset.isFavorite ? 'fill-current' : ''}`} />
            </button>

            <a
              href={asset.url}
              download={asset.filename}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              title="Download original image"
            >
              <Download className="w-4 h-4" />
            </a>

            <button
              onClick={() => {
                navigator.clipboard.writeText(window.location.href);
              }}
              className="p-1.5 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              title="Share link"
            >
              <Share2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Right Side: EXIF & Archive Inspection Panel */}
        <div className="w-full lg:w-96 border-t lg:border-t-0 lg:border-l border-zinc-800 bg-zinc-950 p-5 overflow-y-auto space-y-6">
          {/* Header */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-blue-400">
                {asset.kind.replace('_', ' ')}
              </span>
              <span className="text-xs font-mono text-zinc-500">{asset.mime}</span>
            </div>
            <h2 className="text-lg font-semibold text-zinc-100 truncate mt-1">
              {asset.filename}
            </h2>
            <div className="text-xs text-zinc-400 mt-1 flex items-center space-x-2">
              <span>{asset.width} × {asset.height}</span>
              <span>•</span>
              <span>{formatBytes(asset.byteSize)}</span>
            </div>
          </div>

          {/* Content Address & Object Key (Requirement 3) */}
          <div className="bg-zinc-900/80 rounded-xl p-3.5 border border-zinc-800 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-300 flex items-center space-x-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>SHA-256 Content Address</span>
              </span>
              <button
                onClick={copyHashToClipboard}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center space-x-1 font-mono"
              >
                {copiedHash ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
            <div className="bg-black/60 p-2 rounded text-[11px] font-mono text-zinc-300 break-all select-all border border-zinc-800/80">
              {asset.hash}
            </div>

            <div className="text-[11px] text-zinc-400 space-y-1 pt-1 border-t border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">Tier:</span>
                <span className="text-zinc-300 font-mono capitalize">
                  {asset.storageTier.replace('_', ' ')}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">Remote Key:</span>
                <span className="text-zinc-300 font-mono text-[10px] truncate max-w-[170px]" title={keys.orig}>
                  {keys.orig}
                </span>
              </div>
            </div>
          </div>

          {/* Capture Date & Provenance */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
              <Calendar className="w-3.5 h-3.5 text-zinc-400" />
              <span>Capture Information</span>
            </h4>
            <div className="bg-zinc-900/50 rounded-xl p-3 border border-zinc-800/80 text-xs space-y-1.5">
              <div className="text-zinc-200 font-medium">{capturedDate}</div>
              <div className="flex items-center space-x-2 text-[11px] text-zinc-400">
                <span className="text-zinc-500">Provenance:</span>
                <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">
                  {asset.capturedAtSource === 'sidecar'
                    ? 'Google Takeout Sidecar JSON'
                    : asset.capturedAtSource === 'exif'
                    ? 'EXIF DateTimeOriginal'
                    : 'File Modification Timestamp'}
                </span>
              </div>
            </div>
          </div>

          {/* Camera & Lens EXIF */}
          {(asset.exif.cameraMake || asset.exif.cameraModel) && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
                <Camera className="w-3.5 h-3.5 text-zinc-400" />
                <span>Camera & Exposure</span>
              </h4>
              <div className="bg-zinc-900/50 rounded-xl p-3 border border-zinc-800/80 text-xs space-y-1.5">
                <div className="text-zinc-200 font-medium">
                  {asset.exif.cameraMake} {asset.exif.cameraModel}
                </div>
                {asset.exif.lens && (
                  <div className="text-[11px] text-zinc-400">{asset.exif.lens}</div>
                )}
                <div className="flex flex-wrap gap-2 pt-1 font-mono text-[11px] text-zinc-300">
                  {asset.exif.focalLength && (
                    <span className="bg-zinc-800/80 px-2 py-0.5 rounded">
                      {asset.exif.focalLength}
                    </span>
                  )}
                  {asset.exif.aperture && (
                    <span className="bg-zinc-800/80 px-2 py-0.5 rounded">
                      {asset.exif.aperture}
                    </span>
                  )}
                  {asset.exif.shutterSpeed && (
                    <span className="bg-zinc-800/80 px-2 py-0.5 rounded">
                      {asset.exif.shutterSpeed}
                    </span>
                  )}
                  {asset.exif.iso && (
                    <span className="bg-zinc-800/80 px-2 py-0.5 rounded">
                      ISO {asset.exif.iso}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Location / GPS */}
          {asset.location && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
                <MapPin className="w-3.5 h-3.5 text-zinc-400" />
                <span>Location</span>
              </h4>
              <div className="bg-zinc-900/50 rounded-xl p-3 border border-zinc-800/80 text-xs space-y-1">
                <div className="text-zinc-200 font-medium">{asset.location.placeName}</div>
                <div className="text-[11px] font-mono text-zinc-500">
                  {asset.location.lat.toFixed(4)}°, {asset.location.lon.toFixed(4)}°
                </div>
              </div>
            </div>
          )}

          {/* OCR Extracted Text */}
          {asset.ocrText && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
                <FileText className="w-3.5 h-3.5 text-zinc-400" />
                <span>On-Device OCR Extracted Text</span>
              </h4>
              <div className="bg-zinc-900/50 rounded-xl p-3 border border-zinc-800/80 text-xs font-mono text-zinc-300 leading-relaxed max-h-28 overflow-y-auto">
                {asset.ocrText}
              </div>
            </div>
          )}

          {/* Semantic Tags (CLIP) */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Semantic Concept Tags
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {asset.semanticTags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-0.5 text-xs bg-zinc-800/90 text-zinc-300 rounded-md border border-zinc-700/60"
                >
                  #{tag}
                </span>
              ))}
            </div>
          </div>

          {/* Verified Space Reclamation Action */}
          <div className="pt-2 border-t border-zinc-800">
            {asset.isLocalPurged ? (
              <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/50 flex items-center space-x-2 text-xs text-amber-300">
                <Cloud className="w-4 h-4 shrink-0" />
                <span>Original purged from local storage. Preserved in S3 archive.</span>
              </div>
            ) : (
              <button
                onClick={() => onReclaimSingle(asset.id)}
                className="w-full py-2.5 px-3 rounded-xl bg-zinc-900 hover:bg-rose-950/40 hover:text-rose-300 hover:border-rose-800/60 border border-zinc-800 text-xs font-semibold text-zinc-200 transition-all flex items-center justify-center space-x-2 cursor-pointer"
              >
                <HardDrive className="w-4 h-4" />
                <span>Reclaim Local Space ({formatBytes(asset.byteSize)})</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
