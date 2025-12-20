'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FiDownload, FiLoader, FiAlertCircle, FiCheck, FiX } from 'react-icons/fi';
import toast from 'react-hot-toast';
import type { VideoFormat } from '@/lib/types';

interface DownloadButtonProps {
  videoUrl: string;
  format: VideoFormat | null;
  videoTitle: string;
}

interface DownloadProgress {
  status: 'idle' | 'preparing' | 'downloading' | 'merging' | 'verifying' | 'processing' | 'complete' | 'error' | 'retrying' | 'timeout';
  progress: number;
  bytesDownloaded: number;
  totalBytes: number;
  message?: string;
  error?: string;
  isTimeout?: boolean;
  suggestion?: string;
}

/**
 * DownloadButton Component
 * 
 * v5.2.0 Features:
 * - Real-time progress via Server-Sent Events (SSE)
 * - Extended timeout handling (120s for serverless)
 * - Better error messages for timeout/network issues
 * - Graceful fallback quality suggestions
 */
export default function DownloadButton({
  videoUrl,
  format,
  videoTitle,
}: DownloadButtonProps) {
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({
    status: 'idle',
    progress: 0,
    bytesDownloaded: 0,
    totalBytes: 0,
  });
  const abortControllerRef = useRef<AbortController | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const downloadIdRef = useRef<string>('');

  // Cleanup EventSource on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Connect to SSE for progress updates
  const connectSSE = useCallback((downloadId: string) => {
    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(`/api/download-progress?id=${downloadId}`);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Update progress based on SSE data
        if (data.phase === 'error') {
          setDownloadProgress(prev => ({
            ...prev,
            status: 'error',
            error: data.error || data.message,
            message: data.message,
            isCorruption: data.isCorruption,
            suggestion: data.suggestion,
          }));
          eventSource.close();
        } else if (data.phase === 'complete' && data.fileReady) {
          // File is ready, SSE will be closed after download starts
          setDownloadProgress(prev => ({
            ...prev,
            progress: 100,
            message: 'File ready, starting download...',
          }));
        } else if (data.phase === 'verifying') {
          // v5.2.0: Lightweight verification phase
          setDownloadProgress(prev => ({
            ...prev,
            status: 'verifying',
            progress: data.progress || 95,
            message: data.message || 'Verifying download...',
          }));
        } else if (data.phase === 'merging') {
          setDownloadProgress(prev => ({
            ...prev,
            status: 'merging',
            progress: data.progress || 88,
            message: data.message || 'Merging video and audio...',
          }));
        } else if (data.phase === 'downloading') {
          setDownloadProgress(prev => ({
            ...prev,
            status: 'downloading',
            progress: data.progress || prev.progress,
            message: data.message,
          }));
        } else if (data.phase === 'preparing') {
          setDownloadProgress(prev => ({
            ...prev,
            status: 'preparing',
            progress: data.progress || prev.progress,
            message: data.message || 'Preparing download...',
          }));
        } else if (data.phase === 'timeout') {
          // v5.2.0: Handle timeout with retrying state
          setDownloadProgress(prev => ({
            ...prev,
            status: 'timeout',
            progress: data.progress || 0,
            message: data.message || 'Timeout - retrying with lower quality...',
            isTimeout: true,
          }));
        }
      } catch {
        // Ignore parse errors (heartbeats, etc.)
      }
    };

    eventSource.onerror = () => {
      // Connection error - may be normal when download completes
      eventSource.close();
    };

    return eventSource;
  }, []);

  const handleDownload = async () => {
    if (!format) {
      toast.error('Please select a format first');
      return;
    }

    // Generate unique download ID for SSE tracking
    const downloadId = `dl_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    downloadIdRef.current = downloadId;

    // Create abort controller for cancellation
    abortControllerRef.current = new AbortController();

    setDownloadProgress({
      status: 'preparing',
      progress: 0,
      bytesDownloaded: 0,
      totalBytes: 0,
      message: 'Connecting to server...',
    });

    // Connect to SSE for real-time progress
    connectSSE(downloadId);

    try {
      // Make request to proxy download endpoint
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: videoUrl,
          formatId: format.formatId,
          title: videoTitle,
          ext: format.ext,
          hasVideo: format.hasVideo,
          downloadId, // Pass ID for SSE correlation
        }),
        signal: abortControllerRef.current.signal,
      });

      // Close SSE connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      // Check if response is JSON (error) or blob (success)
      const contentType = response.headers.get('content-type');
      
      if (contentType?.includes('application/json')) {
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || 'Download failed');
        }
        // Shouldn't reach here for successful downloads
        throw new Error('Unexpected response format');
      }

      // Get content length for progress tracking
      const contentLength = response.headers.get('content-length');
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
      const filename = response.headers.get('x-download-filename') || 
                       `${videoTitle}.${format.ext}`;

      setDownloadProgress({
        status: 'processing',
        progress: 98,
        bytesDownloaded: 0,
        totalBytes,
        message: 'Receiving file...',
      });

      // Use ReadableStream for progress tracking
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to read response stream');
      }

      const chunks: Uint8Array[] = [];
      let bytesDownloaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        chunks.push(value);
        bytesDownloaded += value.length;

        const progress = totalBytes > 0 
          ? Math.round((bytesDownloaded / totalBytes) * 100) 
          : 98;

        setDownloadProgress({
          status: 'processing',
          progress: Math.min(progress, 99),
          bytesDownloaded,
          totalBytes,
          message: `Receiving: ${formatFileSize(bytesDownloaded)}${totalBytes > 0 ? ` / ${formatFileSize(totalBytes)}` : ''}`,
        });
      }

      setDownloadProgress(prev => ({ 
        ...prev, 
        status: 'processing',
        progress: 100,
        message: 'Saving file...',
      }));

      // Combine chunks into blob - use spread to create proper ArrayBuffer copies
      const blob = new Blob(chunks.map(chunk => new Uint8Array(chunk).buffer as ArrayBuffer), { 
        type: response.headers.get('content-type') || 'video/mp4' 
      });

      // Verify blob size (basic corruption check)
      if (blob.size < 1024) {
        throw new Error('Downloaded file appears to be corrupted (too small)');
      }

      // Create download link
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      
      // Cleanup
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 100);

      setDownloadProgress({
        status: 'complete',
        progress: 100,
        bytesDownloaded,
        totalBytes,
        message: 'Download complete!',
      });

      toast.success('Download complete!', { icon: '🎉' });

      // Reset after a delay
      setTimeout(() => {
        setDownloadProgress({
          status: 'idle',
          progress: 0,
          bytesDownloaded: 0,
          totalBytes: 0,
        });
      }, 3000);

    } catch (error: any) {
      console.error('Download error:', error);
      
      // Close SSE connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      
      if (error.name === 'AbortError') {
        toast.error('Download cancelled');
        setDownloadProgress({
          status: 'idle',
          progress: 0,
          bytesDownloaded: 0,
          totalBytes: 0,
        });
        return;
      }

      // Provide helpful error messages
      const errorMessage = error.message || 'Download failed';
      let toastMessage = errorMessage;
      let isTimeout = false;
      let suggestion = '';
      
      // v5.2.0: Enhanced error detection and messaging
      if (errorMessage.includes('timed out') || errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
        toastMessage = 'Download timed out. Try a lower quality format.';
        isTimeout = true;
        suggestion = 'Try selecting 720p or below for faster downloads';
      } else if (errorMessage.includes('corrupted') || errorMessage.includes('Corruption') || errorMessage.includes('corrupt')) {
        toastMessage = 'Video file was corrupted. Try a different format.';
        suggestion = 'Try selecting a different format';
      } else if (errorMessage.includes('bot') || errorMessage.includes('Bot') || errorMessage.includes('blocked')) {
        toastMessage = 'YouTube blocked the request. Try again in a few minutes.';
        suggestion = 'Try again in a few minutes';
      } else if (errorMessage.includes('Fragment')) {
        toastMessage = 'Download interrupted. Please try again.';
        suggestion = 'Click Download to retry';
      }

      setDownloadProgress({
        status: 'error',
        progress: 0,
        bytesDownloaded: 0,
        totalBytes: 0,
        error: errorMessage,
        message: errorMessage,
        isTimeout,
        suggestion,
      });

      // Show toast with specific message
      toast.error(toastMessage, { 
        duration: 6000,
        icon: isTimeout ? '⏱️' : '❌',
      });
      
      // Show suggestion toast if available
      if (suggestion) {
        setTimeout(() => {
          toast(suggestion, { 
            duration: 5000,
            icon: '💡',
          });
        }, 1000);
      }

      // Reset after showing error
      setTimeout(() => {
        setDownloadProgress({
          status: 'idle',
          progress: 0,
          bytesDownloaded: 0,
          totalBytes: 0,
        });
      }, 5000);
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
  };

  const isDownloading = ['preparing', 'downloading', 'merging', 'verifying', 'processing', 'retrying', 'timeout'].includes(downloadProgress.status);
  const disabled = !format || isDownloading;

  const getStatusText = () => {
    // Use SSE message if available
    if (downloadProgress.message) {
      return downloadProgress.message;
    }
    
    switch (downloadProgress.status) {
      case 'preparing':
        return 'Preparing download...';
      case 'downloading':
        return `Downloading: ${downloadProgress.progress}%`;
      case 'verifying':
        return 'Verifying download...';
      case 'merging':
        return 'Merging video and audio...';
      case 'retrying':
        return downloadProgress.message || 'Retrying download...';
      case 'timeout':
        return 'Timeout - retrying with lower quality...';
      case 'processing':
        return downloadProgress.totalBytes > 0
          ? `Receiving: ${formatFileSize(downloadProgress.bytesDownloaded)} / ${formatFileSize(downloadProgress.totalBytes)}`
          : `Processing: ${formatFileSize(downloadProgress.bytesDownloaded)}`;
      case 'complete':
        return 'Download complete!';
      case 'error':
        return downloadProgress.error || 'Download failed';
      default:
        return null;
    }
  };

  // Get status-specific color for progress bar
  const getProgressBarColor = () => {
    switch (downloadProgress.status) {
      case 'preparing':
        return 'bg-warning';
      case 'merging':
        return 'bg-secondary';
      case 'verifying':
        return 'bg-info';
      case 'retrying':
      case 'timeout':
        return 'bg-warning animate-pulse';
      case 'error':
        return 'bg-error';
      case 'complete':
        return 'bg-success';
      default:
        return 'bg-primary';
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.4 }}
      className="card bg-base-200 shadow-xl"
    >
      <div className="card-body p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:gap-4">
          {/* Selected format info */}
          <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-4">
            <div className="flex-1 text-center sm:text-left w-full">
              {format ? (
                <div>
                  <p className="font-medium text-base-content text-sm sm:text-base">
                    Ready to download
                  </p>
                  <p className="text-xs sm:text-sm text-base-content/60">
                    {format.quality} • {format.ext.toUpperCase()}
                    {format.filesize && ` • ${formatFileSize(format.filesize)}`}
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-center sm:justify-start gap-2 text-warning">
                  <FiAlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span className="text-xs sm:text-sm">Select a format above to download</span>
                </div>
              )}
            </div>

            {/* Download/Cancel button */}
            <div className="flex gap-2 w-full sm:w-auto">
              {isDownloading ? (
                <motion.button
                  onClick={handleCancel}
                  className="btn btn-error btn-md sm:btn-lg gap-2 w-full sm:w-auto min-h-[52px] sm:min-h-[56px]"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <FiX className="w-5 h-5" />
                  <span>Cancel</span>
                </motion.button>
              ) : (
                <motion.button
                  onClick={handleDownload}
                  disabled={disabled}
                  className={`
                    btn btn-md sm:btn-lg gap-2 sm:gap-3 shadow-lg w-full sm:w-auto sm:min-w-[200px]
                    min-h-[52px] sm:min-h-[56px]
                    ${disabled 
                      ? 'btn-disabled' 
                      : downloadProgress.status === 'complete'
                        ? 'btn-success'
                        : downloadProgress.status === 'error'
                          ? 'btn-error'
                          : 'btn-primary glow-primary-hover'
                    }
                  `}
                  whileHover={{ scale: disabled ? 1 : 1.02 }}
                  whileTap={{ scale: disabled ? 1 : 0.95 }}
                >
                  {downloadProgress.status === 'complete' ? (
                    <>
                      <FiCheck className="w-5 h-5" />
                      <span>Downloaded!</span>
                    </>
                  ) : downloadProgress.status === 'error' ? (
                    <>
                      <FiAlertCircle className="w-5 h-5" />
                      <span>Try Again</span>
                    </>
                  ) : (
                    <>
                      <FiDownload className="w-5 h-5" />
                      <span>Download Now</span>
                    </>
                  )}
                </motion.button>
              )}
            </div>
          </div>

          {/* Progress bar with real-time updates */}
          <AnimatePresence>
            {isDownloading && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="space-y-2"
              >
                <div className="flex items-center justify-between text-xs sm:text-sm">
                  <span className="text-base-content/70 flex items-center gap-2">
                    {(downloadProgress.status === 'preparing' || downloadProgress.status === 'merging') && (
                      <FiLoader className="w-3 h-3 animate-spin" />
                    )}
                    {getStatusText()}
                  </span>
                  {downloadProgress.progress > 0 && (
                    <span className="text-base-content/70 font-medium">{downloadProgress.progress}%</span>
                  )}
                </div>
                <div className="w-full bg-base-300 rounded-full h-2 sm:h-3 overflow-hidden">
                  <motion.div
                    className={`h-full rounded-full transition-colors ${getProgressBarColor()} ${
                      downloadProgress.status === 'preparing' || downloadProgress.status === 'merging'
                        ? 'animate-pulse' 
                        : ''
                    }`}
                    initial={{ width: 0 }}
                    animate={{ 
                      width: downloadProgress.progress > 0 
                        ? `${downloadProgress.progress}%` 
                        : downloadProgress.status === 'preparing'
                          ? '15%'
                          : '5%'
                    }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
                
                {/* Phase indicator badges */}
                <div className="flex gap-2 flex-wrap">
                  <span className={`badge badge-xs ${downloadProgress.status === 'preparing' || downloadProgress.status === 'retrying' || downloadProgress.status === 'timeout' ? 'badge-warning' : 'badge-ghost'}`}>
                    Prepare
                  </span>
                  <span className={`badge badge-xs ${downloadProgress.status === 'downloading' ? 'badge-primary' : 'badge-ghost'}`}>
                    Download
                  </span>
                  <span className={`badge badge-xs ${downloadProgress.status === 'merging' ? 'badge-secondary' : 'badge-ghost'}`}>
                    Merge
                  </span>
                  <span className={`badge badge-xs ${downloadProgress.status === 'verifying' ? 'badge-info' : 'badge-ghost'}`}>
                    Verify
                  </span>
                  <span className={`badge badge-xs ${downloadProgress.status === 'processing' ? 'badge-info' : 'badge-ghost'}`}>
                    Transfer
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Note */}
        <p className="text-[10px] sm:text-xs text-base-content/50 text-center mt-3 sm:mt-4">
          {isDownloading 
            ? downloadProgress.status === 'merging'
              ? 'Merging video and audio tracks. This ensures your video plays correctly.'
              : downloadProgress.status === 'verifying'
              ? 'Quick verification to ensure file is playable.'
              : downloadProgress.status === 'retrying' || downloadProgress.status === 'timeout'
              ? 'Retrying with a lower quality for better reliability.'
              : 'Download is streamed through our server. Large files may take longer.'
            : 'Downloads are verified for playability. Large files may timeout - try lower quality if needed.'
          }
        </p>
      </div>
    </motion.div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}
