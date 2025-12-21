'use client';

/**
 * FormatSelector.tsx
 * 
 * v5.4.0 AUDIO/VIDEO FIX UPDATE:
 * - Prioritizes audio formats (MP3/M4A) as most reliable
 * - Shows "Recommended" badge on audio formats
 * - Updated video format warnings
 * - Better organization: Audio First, then Video
 */

import { useState, useMemo, forwardRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiVideo, FiMusic, FiFilter, FiCheck, FiAlertTriangle, FiInfo, FiCheckCircle } from 'react-icons/fi';
import type { VideoFormat } from '@/lib/types';
import clsx from 'clsx';

interface FormatSelectorProps {
  formats: VideoFormat[];
  selectedFormat: VideoFormat | null;
  onSelect: (format: VideoFormat) => void;
}

type FilterType = 'all' | 'video' | 'audio';

function formatFileSize(bytes: number | null): string {
  if (!bytes) return 'Unknown';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function formatBitrate(tbr?: number): string {
  if (!tbr) return '';
  return `${Math.round(tbr)} kbps`;
}

export default function FormatSelector({ formats, onSelect, selectedFormat }: FormatSelectorProps) {
  const [filter, setFilter] = useState<FilterType>('all');

  const filteredFormats = useMemo(() => {
    switch (filter) {
      case 'video':
        return formats.filter(f => f.hasVideo);
      case 'audio':
        return formats.filter(f => !f.hasVideo && f.hasAudio);
      default:
        return formats;
    }
  }, [formats, filter]);

  // v5.4.0: Separate formats into categories
  // Audio formats are most reliable, prioritize them
  const audioFormats = filteredFormats.filter(f => !f.hasVideo && f.hasAudio);
  
  // Video formats - recommended (merged) vs individual
  const videoFormats = filteredFormats.filter(f => f.hasVideo);
  const recommendedVideoFormats = videoFormats.filter(
    (f) => f.formatId.includes('+') || f.formatId.includes('best')
  );
  const individualVideoFormats = videoFormats.filter(
    (f) => !f.formatId.includes('+') && !f.formatId.includes('best')
  );

  const filterButtons: { type: FilterType; icon: typeof FiVideo; label: string }[] = [
    { type: 'all', icon: FiFilter, label: 'All' },
    { type: 'video', icon: FiVideo, label: 'Video' },
    { type: 'audio', icon: FiMusic, label: 'Audio' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      className="card bg-base-200 shadow-xl"
    >
      <div className="card-body p-3 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 mb-4">
          <h3 className="card-title text-lg sm:text-xl">Select Format</h3>
          
          <div className="join w-full sm:w-auto">
            {filterButtons.map(({ type, icon: Icon, label }) => (
              <button
                key={type}
                onClick={() => setFilter(type)}
                className={clsx(
                  'btn btn-sm join-item gap-1 sm:gap-2 flex-1 sm:flex-none',
                  filter === type ? 'btn-primary' : 'btn-ghost'
                )}
              >
                <Icon className="w-4 h-4" />
                <span className="text-xs sm:text-sm">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* v5.4.0: Audio Formats FIRST - Most Reliable */}
        {audioFormats.length > 0 && filter !== 'video' && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <h4 className="text-sm font-semibold text-success uppercase tracking-wide flex items-center gap-1">
                <FiCheckCircle className="w-4 h-4" />
                Audio Formats
              </h4>
              <span className="badge badge-sm badge-success">Most Reliable</span>
              <div className="tooltip tooltip-right" data-tip="Audio downloads are faster and most reliable. Recommended for music.">
                <FiInfo className="w-3.5 h-3.5 text-base-content/40 cursor-help" />
              </div>
            </div>
            <div className="grid gap-2">
              <AnimatePresence mode="popLayout">
                {audioFormats.slice(0, 10).map((format, index) => (
                  <FormatCard
                    key={format.formatId}
                    format={format}
                    isSelected={selectedFormat?.formatId === format.formatId}
                    onClick={() => onSelect(format)}
                    index={index}
                    isReliable={true}
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}

        {/* 
         * REMOVED: Best Quality Video (Recommended Merge Formats) Section
         * 
         * Final removal of merge UI section as per user instruction—unfixable bug causing audio-only MP4.
         * The recommended video formats (Best Quality, 1080p, 720p, 480p with video+audio merge)
         * persistently failed despite multiple fix attempts, resulting in corrupted downloads or
         * audio-only MP4 files. This section has been permanently removed to preserve app stability.
         * 
         * Users should use:
         * - Audio Formats (MP3/M4A) for music - most reliable
         * - Individual Formats for video - downloads single stream as-is
         */}

        {/* Individual video formats */}
        {individualVideoFormats.length > 0 && filter !== 'audio' && (
          <div>
            <h4 className="text-sm font-semibold text-base-content/60 mb-3 uppercase tracking-wide">
              Individual Formats
            </h4>
            <div className="grid gap-2 max-h-64 overflow-y-auto pr-2">
              <AnimatePresence mode="popLayout">
                {individualVideoFormats.slice(0, 20).map((format, index) => (
                  <FormatCard
                    key={format.formatId}
                    format={format}
                    isSelected={selectedFormat?.formatId === format.formatId}
                    onClick={() => onSelect(format)}
                    index={index}
                    isReliable={false}
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}

        {filteredFormats.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-8 text-base-content/50"
          >
            No formats available for this filter
          </motion.div>
        )}

        {individualVideoFormats.length > 20 && (
          <div className="text-center text-sm text-base-content/50 mt-4">
            Showing top 20 video formats out of {individualVideoFormats.length}
          </div>
        )}
      </div>
    </motion.div>
  );
}

interface FormatCardProps {
  format: VideoFormat;
  isSelected: boolean;
  onClick: () => void;
  index: number;
  isReliable?: boolean;
}

/**
 * FormatCard component wrapped with forwardRef to fix React warning:
 * "Function components cannot be given refs" when used inside AnimatePresence
 * with mode="popLayout". The ref is forwarded to the motion.div element.
 * 
 * v5.4.0: Added isReliable prop to show reliability badge on audio formats
 */
const FormatCard = forwardRef<HTMLDivElement, FormatCardProps>(
  function FormatCard({ format, isSelected, onClick, index, isReliable }, ref) {
    const size = formatFileSize(format.filesize || format.filesizeApprox);
    
    return (
      <motion.div
        ref={ref}
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 20 }}
        transition={{ delay: index * 0.02 }}
        onClick={onClick}
        className={clsx(
          'flex items-center gap-2 sm:gap-3 p-2 sm:p-3 rounded-lg cursor-pointer transition-all',
          isSelected 
            ? 'bg-primary/10 border-2 border-primary' 
            : 'bg-base-100 border-2 border-transparent hover:bg-base-100/80'
        )}
      >
        {/* Selection indicator */}
        <div className={clsx(
          'w-4 h-4 sm:w-5 sm:h-5 rounded-full border-2 flex items-center justify-center transition-all flex-shrink-0',
          isSelected ? 'border-primary bg-primary' : 'border-base-300'
        )}>
          {isSelected && (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 500 }}
            >
              <FiCheck className="w-2 h-2 sm:w-3 sm:h-3 text-primary-content" />
            </motion.div>
          )}
        </div>

        {/* Format icon */}
        <div className="flex-shrink-0">
          {format.hasVideo ? (
            <FiVideo className="w-4 h-4 sm:w-5 sm:h-5 text-primary" />
          ) : (
            <FiMusic className="w-4 h-4 sm:w-5 sm:h-5 text-secondary" />
          )}
        </div>

        {/* Format info */}
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate text-sm sm:text-base flex items-center gap-1">
            {format.quality}
            {/* v5.4.0: Reliable badge for audio formats */}
            {isReliable && (
              <span className="badge badge-xs badge-success badge-outline ml-1">fast</span>
            )}
            {/* Warning for Best Quality video formats - may timeout */}
            {!isReliable && (format.formatId.includes('+') || format.formatId.includes('best')) && format.hasVideo && (
              <div className="tooltip tooltip-top" data-tip="Requires merging video+audio. May be slower.">
                <FiAlertTriangle className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-warning" />
              </div>
            )}
          </div>
          <div className="text-[10px] sm:text-xs text-base-content/60 flex items-center gap-1 sm:gap-2 flex-wrap">
            <span className="badge badge-xs">{format.ext.toUpperCase()}</span>
            {format.vbr && <span>{formatBitrate(format.vbr)}</span>}
            {!format.vbr && format.abr && <span>{formatBitrate(format.abr)}</span>}
            {/* Merge indicator for video - v5.4.0: Updated warning */}
            {format.formatId.includes('+') && (
              <span className="badge badge-xs badge-warning badge-outline">merge</span>
            )}
          </div>
        </div>

        {/* Size */}
        <div className="text-xs sm:text-sm text-base-content/70 flex-shrink-0 font-medium">
          {size}
        </div>
      </motion.div>
    );
  }
);
