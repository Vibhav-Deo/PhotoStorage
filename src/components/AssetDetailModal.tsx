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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md animate-fade-in p-2 sm:p-4">
      {/* Container */}
      <div className="relative w-full max-w-6xl h-[92vh] bg-[#0c0c0e] border border-white/[0.1] rounded-2xl overflow-hidden flex flex-col lg:flex-row shadow-2xl">
        {/* Close Button Top Right */}
        <button
          onClick={onClose}
          className="absolute top-3.5 right-3.5 z-30 p-1.5 rounded-md bg-black/60 hover:bg-white/[0.1] border border-white/[0.1] text-zinc-400 hover:text-white transition-colors"
        >
          <X className="w-4 h-4" />
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
              className="absolute top-4 left-4 z-10 flex items-center gap-1.5 px-3 py-1 rounded-md bg-black/70 hover:bg-black/90 border border-white/[0.15] text-sky-400 text-xs font-medium backdrop-blur-md cursor-pointer transition-all shadow-lg active:scale-95"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{showLiveMotion ? 'PLAYING LIVE' : 'HOLD FOR LIVE'}</span>
            </button>
          )}

          {/* Bottom quick actions */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-[#121215]/90 backdrop-blur-md px-2 py-1 rounded-lg border border-white/[0.1] text-xs text-zinc-300 opacity-90 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => onToggleFavorite(asset.id)}
              className={`p-1.5 rounded-md hover:bg-white/[0.08] transition-colors ${
                asset.isFavorite ? 'text-rose-400' : 'text-zinc-400 hover:text-white'
              }`}
              title="Toggle Favorite"
            >
              <Heart className={`w-4 h-4 ${asset.isFavorite ? 'fill-current' : ''}`} />
            </button>

            <a
              href={asset.url}
              download={asset.filename}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
              title="Download original file"
            >
              <Download className="w-4 h-4" />
            </a>

            <button
              onClick={() => {
                navigator.clipboard.writeText(window.location.href);
              }}
              className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
              title="Copy link"
            >
              <Share2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Right Side: EXIF & Archive Inspection Panel */}
        <div className="w-full lg:w-96 border-t lg:border-t-0 lg:border-l border-white/[0.08] bg-[#121215] p-5 overflow-y-auto space-y-5">
          {/* Header */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono uppercase tracking-wider text-blue-400">
                {asset.kind.replace('_', ' ')}
              </span>
              <span className="text-xs font-mono text-zinc-500">{asset.mime}</span>
            </div>
            <h2 className="text-base font-semibold text-white truncate mt-1">
              {asset.filename}
            </h2>
            <div className="text-xs text-zinc-400 mt-0.5 flex items-center gap-2 font-mono tabular-nums">
              <span>{asset.width} × {asset.height}</span>
              <span className="text-zinc-600">·</span>
              <span>{formatBytes(asset.byteSize)}</span>
            </div>
          </div>

          {/* Content Address & Object Key */}
          <div className="bg-[#09090b] rounded-lg p-3 border border-white/[0.06] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>SHA-256 Content Key</span>
              </span>
              <button
                onClick={copyHashToClipboard}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 font-mono"
              >
                {copiedHash ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
            <div className="bg-[#121215] p-2 rounded text-[10px] font-mono text-zinc-300 break-all select-all border border-white/[0.04]">
              {asset.hash}
            </div>

            <div className="text-[11px] text-zinc-400 space-y-1 pt-1.5 border-t border-white/[0.06] font-mono">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">Storage Tier:</span>
                <span className="text-zinc-300 capitalize">
                  {asset.storageTier.replace('_', ' ')}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-500">S3 Key:</span>
                <span className="text-zinc-300 text-[10px] truncate max-w-[170px]" title={keys.orig}>
                  {keys.orig}
                </span>
              </div>
            </div>
          </div>

          {/* Capture Date & Provenance */}
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-zinc-400" />
              <span>Capture Info</span>
            </h4>
            <div className="bg-[#09090b] rounded-lg p-3 border border-white/[0.06] text-xs space-y-1.5">
              <div className="text-zinc-200 font-medium">{capturedDate}</div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                <span className="text-zinc-500">Source:</span>
                <span className="text-zinc-300 font-mono">
                  {asset.capturedAtSource === 'sidecar'
                    ? 'Takeout Sidecar JSON'
                    : asset.capturedAtSource === 'exif'
                    ? 'EXIF DateTimeOriginal'
                    : 'File Modification Time'}
                </span>
              </div>
            </div>
          </div>

          {/* Camera & Lens EXIF */}
          {(asset.exif.cameraMake || asset.exif.cameraModel) && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <Camera className="w-3.5 h-3.5 text-zinc-400" />
                <span>Camera & Exposure</span>
              </h4>
              <div className="bg-[#09090b] rounded-lg p-3 border border-white/[0.06] text-xs space-y-2">
                <div className="text-zinc-200 font-medium">
                  {asset.exif.cameraMake} {asset.exif.cameraModel}
                </div>
                {asset.exif.lens && (
                  <div className="text-[11px] text-zinc-400">{asset.exif.lens}</div>
                )}
                <div className="grid grid-cols-4 gap-1.5 pt-1 font-mono text-[11px] text-zinc-300 tabular-nums">
                  <div className="bg-[#121215] p-1.5 rounded text-center border border-white/[0.04]">
                    <span className="text-[9px] text-zinc-500 block">Focal</span>
                    {asset.exif.focalLength || '—'}
                  </div>
                  <div className="bg-[#121215] p-1.5 rounded text-center border border-white/[0.04]">
                    <span className="text-[9px] text-zinc-500 block">Aperture</span>
                    {asset.exif.aperture || '—'}
                  </div>
                  <div className="bg-[#121215] p-1.5 rounded text-center border border-white/[0.04]">
                    <span className="text-[9px] text-zinc-500 block">Shutter</span>
                    {asset.exif.shutterSpeed || '—'}
                  </div>
                  <div className="bg-[#121215] p-1.5 rounded text-center border border-white/[0.04]">
                    <span className="text-[9px] text-zinc-500 block">ISO</span>
                    {asset.exif.iso || '—'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Location / GPS */}
          {asset.location && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-zinc-400" />
                <span>Location</span>
              </h4>
              <div className="bg-[#09090b] rounded-lg p-3 border border-white/[0.06] text-xs space-y-1">
                <div className="text-zinc-200 font-medium">{asset.location.placeName}</div>
                <div className="text-[11px] font-mono text-zinc-500 tabular-nums">
                  {asset.location.lat.toFixed(4)}°, {asset.location.lon.toFixed(4)}°
                </div>
              </div>
            </div>
          )}

          {/* OCR Extracted Text */}
          {asset.ocrText && (
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-zinc-400" />
                <span>Extracted Text (OCR)</span>
              </h4>
              <div className="bg-[#09090b] rounded-lg p-3 border border-white/[0.06] text-xs font-mono text-zinc-300 leading-relaxed max-h-24 overflow-y-auto">
                {asset.ocrText}
              </div>
            </div>
          )}

          {/* Semantic Tags (CLIP) */}
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Semantic Tags
            </h4>
            <div className="flex flex-wrap gap-1.5 text-xs font-mono text-zinc-400">
              {asset.semanticTags.map((tag) => (
                <span
                  key={tag}
                  className="px-2 py-0.5 bg-[#09090b] rounded text-zinc-300 border border-white/[0.06]"
                >
                  #{tag}
                </span>
              ))}
            </div>
          </div>

          {/* Space Reclamation Action */}
          <div className="pt-2 border-t border-white/[0.06]">
            {asset.isLocalPurged ? (
              <div className="p-2.5 rounded-lg bg-amber-950/20 border border-amber-800/30 flex items-center gap-2 text-xs text-amber-300">
                <Cloud className="w-4 h-4 shrink-0" />
                <span>Original purged locally · Retained in S3</span>
              </div>
            ) : (
              <button
                onClick={() => onReclaimSingle(asset.id)}
                className="w-full py-2 px-3 rounded-lg bg-white/[0.04] hover:bg-rose-950/30 hover:text-rose-300 hover:border-rose-800/40 border border-white/[0.08] text-xs font-medium text-zinc-200 transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <HardDrive className="w-3.5 h-3.5" />
                <span>Purge Local Copy ({formatBytes(asset.byteSize)})</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
