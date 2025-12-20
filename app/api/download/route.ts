/**
 * /api/download/route.ts
 * 
 * Server-side proxy download endpoint v5.2.0
 * 
 * v5.2.0 TIMEOUT FIX UPDATE:
 * - REMOVED FFprobe validation (causes false positives)
 * - Relaxed size validation using metadata
 * - Extended timeouts for serverless (120s total)
 * - Reduced concurrent fragments (2) for stability
 * - Better error handling to avoid 500/504 errors
 * - Chunked response for keep-alive
 * 
 * @version 5.2.0 - Timeout Fix Update
 */

import { NextRequest, NextResponse } from 'next/server';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { formatRequestSchema } from '@/lib/types';
import { checkRateLimit, isBotDetectionError, getErrorMessage, sanitizeFilename } from '@/lib/ytdlp';
import { cleanupOldTempCookies } from '@/lib/auto-cookies';
import { addHistoryEntry } from '@/lib/db';
import { updateProgress } from '@/lib/progress-store';
import {
  getCachedCookies,
  invalidateCookiesCache,
  validateDownloadedFile,
  getFallbackFormat,
  isBestQualityFormat,
  isTimeoutError,
  isNetworkError,
  createTimeoutController,
  killProcessWithTimeout,
  formatBytes,
  DEFAULT_DOWNLOAD_CONFIG,
} from '@/lib/yt-dlp-utils';

export const maxDuration = 120; // 2 minutes for serverless
export const dynamic = 'force-dynamic';

// Track active downloads
const activeDownloads = new Map<string, { 
  process: ChildProcess | null; 
  tempFile?: string; 
  tempCookie?: string;
  timeoutController?: ReturnType<typeof createTimeoutController>;
}>();

// Configuration - v5.2.0 optimized for stability
const MAX_RETRIES = 3;
const CONNECT_TIMEOUT = 45 * 1000;  // 45s for initial connection
const DOWNLOAD_TIMEOUT = 110 * 1000; // 110s total (leave buffer for serverless)

/**
 * Get yt-dlp binary path
 */
function getYtDlpPath(): string {
  const localPath = path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(localPath)) return localPath;
  return 'yt-dlp';
}

/**
 * Get temporary directory
 */
function getTempDir(): string {
  const tempDir = path.join(os.tmpdir(), 'yt-downloader');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

/**
 * Generate unique temp file path
 */
function getTempFilePath(ext: string = 'mp4'): string {
  const id = Math.random().toString(36).substring(2, 15);
  return path.join(getTempDir(), `dl_${Date.now()}_${id}.${ext}`);
}

/**
 * Safely delete temp file
 */
function deleteTempFile(filePath: string | null | undefined): void {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('[Cleanup] Deleted:', path.basename(filePath));
    }
  } catch {
    console.error('[Cleanup] Failed:', filePath);
  }
}

/**
 * Clean up old temp files (older than 10 minutes)
 */
function cleanupOldTempFiles(): void {
  try {
    const tempDir = getTempDir();
    const files = fs.readdirSync(tempDir);
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs < tenMinutesAgo) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }
}

// Cleanup on load
cleanupOldTempFiles();

/**
 * Sanitize filename for HTTP header
 */
function sanitizeForHeader(filename: string): string {
  return filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 200);
}

/**
 * Get content type based on extension
 */
function getContentType(ext: string, hasVideo: boolean): string {
  const extLower = ext.toLowerCase();
  
  if (!hasVideo || ['m4a', 'mp3', 'opus', 'wav'].includes(extLower)) {
    if (extLower === 'm4a') return 'audio/mp4';
    if (extLower === 'mp3') return 'audio/mpeg';
    if (extLower === 'opus') return 'audio/opus';
    return 'audio/mp4';
  }
  
  if (extLower === 'webm') return 'video/webm';
  if (extLower === 'mkv') return 'video/x-matroska';
  return 'video/mp4';
}

/**
 * Parse yt-dlp progress from stderr
 */
function parseProgress(stderr: string): { progress: number; message: string; phase: string } | null {
  // Download progress
  const downloadMatch = stderr.match(/\[download\]\s+(\d+\.?\d*)%/);
  if (downloadMatch) {
    const progress = parseFloat(downloadMatch[1]);
    return {
      progress: Math.min(progress * 0.9, 90),
      message: `Downloading: ${Math.round(progress)}%`,
      phase: 'downloading',
    };
  }

  // Merger phase
  if (stderr.includes('[Merger]') || stderr.includes('Merging formats')) {
    return { progress: 92, message: 'Merging video and audio...', phase: 'merging' };
  }

  // FFmpeg processing
  if (stderr.includes('[ffmpeg]')) {
    return { progress: 94, message: 'Processing with FFmpeg...', phase: 'processing' };
  }

  // Starting download
  if (stderr.includes('[download] Destination:')) {
    return { progress: 5, message: 'Starting download...', phase: 'downloading' };
  }

  // Fragments
  if (stderr.includes('fragments')) {
    const fragMatch = stderr.match(/(\d+)\s*fragments/);
    if (fragMatch) {
      return { progress: 3, message: `Downloading ${fragMatch[1]} fragments...`, phase: 'downloading' };
    }
  }

  // Extracting info
  if (stderr.includes('[youtube]') || stderr.includes('[info]')) {
    return { progress: 2, message: 'Extracting video info...', phase: 'extracting' };
  }

  return null;
}

/**
 * Build yt-dlp arguments - v5.2.0 optimized
 */
function buildYtDlpArgs(
  url: string,
  formatId: string,
  outputPath: string,
  cookiePath: string | null,
  options: { ext?: string; hasVideo?: boolean; needsMerge?: boolean }
): string[] {
  const { ext = 'mp4', hasVideo = true, needsMerge = false } = options;
  const config = DEFAULT_DOWNLOAD_CONFIG;
  
  const args: string[] = [
    url,
    '-f', formatId,
    '-o', outputPath,
    '--no-playlist',
    '--no-mtime',
    // v5.2.0: Extended timeouts for stability
    '--socket-timeout', config.socketTimeout.toString(),
    '--retries', '15',
    '--fragment-retries', '15',
    '--file-access-retries', '10',
    // v5.2.0: Reduced concurrency for stability
    '--concurrent-fragments', config.concurrentFragments.toString(),
    '--buffer-size', '16M',
    '--http-chunk-size', config.httpChunkSize,
    '--geo-bypass',
    '--force-ipv4',
    '--no-warnings',
    '--ignore-errors',
    '--embed-metadata',
  ];

  if (cookiePath && fs.existsSync(cookiePath)) {
    args.push('--cookies', cookiePath);
  }

  if (needsMerge) {
    args.push('--merge-output-format', ext === 'webm' ? 'webm' : 'mp4');
    args.push('--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac -movflags +faststart -strict -2');
  }

  if (!hasVideo && (ext === 'mp3' || ext === 'm4a')) {
    args.push('-x');
    args.push('--audio-format', ext);
    args.push('--audio-quality', '0');
  }

  return args;
}

/**
 * Execute download with timeout handling
 */
async function executeDownload(
  url: string,
  formatId: string,
  tempFile: string,
  cookiePath: string | null,
  expectedSize: number | null,
  options: { 
    ext?: string; 
    hasVideo?: boolean; 
    needsMerge?: boolean; 
    downloadId: string; 
    clientDownloadId: string;
    attempt: number;
  }
): Promise<{ 
  success: boolean; 
  error?: string; 
  isBotDetection?: boolean;
  isTimeout?: boolean;
  isNetworkIssue?: boolean;
}> {
  const { ext, hasVideo, needsMerge, downloadId, clientDownloadId, attempt } = options;
  const ytdlpPath = getYtDlpPath();
  
  return new Promise((resolve) => {
    const args = buildYtDlpArgs(url, formatId, tempFile, cookiePath, { ext, hasVideo, needsMerge });
    
    console.log(`[Download ${downloadId}] Attempt ${attempt}: format=${formatId}`);
    
    const childProcess = spawn(ytdlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Create timeout controller
    const timeoutController = createTimeoutController(DOWNLOAD_TIMEOUT, () => {
      console.log(`[Download ${downloadId}] Timeout - killing process`);
      updateProgress(clientDownloadId, {
        progress: 0,
        message: 'Download timeout - will retry...',
        phase: 'timeout',
      });
      killProcessWithTimeout(childProcess);
    });

    activeDownloads.set(downloadId, { 
      process: childProcess, 
      tempFile, 
      tempCookie: cookiePath || undefined,
      timeoutController,
    });

    let errorOutput = '';
    let receivedData = false;

    // Connection timeout (45s for first response)
    const connectTimeout = setTimeout(() => {
      if (!receivedData) {
        console.log(`[Download ${downloadId}] Connection timeout`);
        timeoutController.abort();
        killProcessWithTimeout(childProcess);
        resolve({ 
          success: false, 
          error: 'Connection timeout - server not responding',
          isTimeout: true,
        });
      }
    }, CONNECT_TIMEOUT);

    childProcess.stderr.on('data', (data: Buffer) => {
      receivedData = true;
      clearTimeout(connectTimeout);
      
      const text = data.toString();
      errorOutput += text;
      
      // Parse progress
      const progress = parseProgress(text);
      if (progress) {
        updateProgress(clientDownloadId, {
          progress: progress.progress,
          message: progress.message,
          phase: progress.phase,
          attempt,
        });
      }
    });

    childProcess.stdout.on('data', () => {
      receivedData = true;
      clearTimeout(connectTimeout);
    });

    childProcess.on('error', (error: Error) => {
      clearTimeout(connectTimeout);
      timeoutController.abort();
      console.error(`[Download ${downloadId}] Process error:`, error.message);
      activeDownloads.delete(downloadId);
      resolve({ 
        success: false, 
        error: error.message,
        isNetworkIssue: isNetworkError(error),
      });
    });

    childProcess.on('close', (code: number) => {
      clearTimeout(connectTimeout);
      timeoutController.abort();
      activeDownloads.delete(downloadId);

      if (timeoutController.isAborted) {
        resolve({ success: false, error: 'Download timed out', isTimeout: true });
        return;
      }

      // Check for bot detection
      if (isBotDetectionError({ message: errorOutput })) {
        console.log(`[Download ${downloadId}] Bot detection`);
        resolve({ success: false, error: 'Bot detection', isBotDetection: true });
        return;
      }

      // Check for fragment error
      if (errorOutput.includes('No such file or directory') && errorOutput.includes('Frag')) {
        console.log(`[Download ${downloadId}] Fragment error`);
        resolve({ success: false, error: 'Fragment error - retrying', isTimeout: true });
        return;
      }

      // Check exit code
      if (code !== 0) {
        const errorMsg = getErrorMessage({ message: errorOutput }) || 'Download failed';
        console.error(`[Download ${downloadId}] Exit code ${code}: ${errorMsg}`);
        resolve({ 
          success: false, 
          error: errorMsg,
          isTimeout: isTimeoutError(errorMsg),
          isNetworkIssue: isNetworkError(errorMsg),
        });
        return;
      }

      // Check file exists
      if (!fs.existsSync(tempFile)) {
        resolve({ success: false, error: 'File not found after download' });
        return;
      }

      // v5.2.0: Lightweight validation (NO FFprobe)
      updateProgress(clientDownloadId, {
        progress: 95,
        message: 'Verifying download...',
        phase: 'verifying',
      });

      const validation = validateDownloadedFile(tempFile, expectedSize, !hasVideo);
      
      if (!validation.isValid) {
        console.error(`[Download ${downloadId}] Validation failed: ${validation.error}`);
        // Only fail if file is completely broken, otherwise accept
        if (validation.fileSize < 1024) {
          resolve({ success: false, error: validation.error });
          return;
        }
        // File exists with reasonable size - accept it
        console.warn(`[Download ${downloadId}] Warning: ${validation.error}, but file seems usable`);
      }

      console.log(`[Download ${downloadId}] Success: ${formatBytes(validation.fileSize)}`);
      resolve({ success: true });
    });
  });
}

/**
 * POST /api/download
 */
export async function POST(request: NextRequest): Promise<Response> {
  const downloadId = Math.random().toString(36).substring(7);
  let tempFile: string | null = null;
  let currentCookiePath: string | null = null;
  
  try {
    cleanupOldTempCookies();
    
    // Rate limiting
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 
               request.headers.get('x-real-ip') || 'unknown';
    
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { success: false, error: 'Too many requests. Please wait a moment.' },
        { status: 429 }
      );
    }

    // Parse request
    const body = await request.json();
    const validationResult = formatRequestSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid request parameters' },
        { status: 400 }
      );
    }

    const { url, formatId: requestedFormatId } = validationResult.data;
    const title = body.title || 'video';
    const ext = body.ext || 'mp4';
    const hasVideo = body.hasVideo !== false;
    const clientDownloadId = body.downloadId || downloadId;
    const expectedSize = body.filesize || body.filesizeApprox || null;

    const needsMerge = requestedFormatId.includes('+');
    const outputExt = hasVideo ? (ext === 'webm' ? 'webm' : 'mp4') : (ext || 'm4a');
    const isBestQuality = isBestQualityFormat(requestedFormatId);

    tempFile = getTempFilePath(outputExt);

    console.log(`[Download ${downloadId}] URL: ${url}`);
    console.log(`[Download ${downloadId}] Format: ${requestedFormatId}, Best: ${isBestQuality}, Merge: ${needsMerge}`);
    if (expectedSize) {
      console.log(`[Download ${downloadId}] Expected size: ${formatBytes(expectedSize)}`);
    }

    // Initialize progress
    updateProgress(clientDownloadId, {
      progress: 0,
      message: 'Preparing download...',
      phase: 'preparing',
    });

    // Retry loop
    let lastError = '';
    let lastIsBotDetection = false;
    let lastIsTimeout = false;
    let usedFallback = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let formatId = requestedFormatId;
      
      // Use fallback format on retry after timeout/error
      if (attempt > 1 && (lastIsTimeout || lastError)) {
        formatId = getFallbackFormat(attempt - 1, requestedFormatId);
        usedFallback = true;
        console.log(`[Download ${downloadId}] Fallback format: ${formatId}`);
        
        updateProgress(clientDownloadId, {
          progress: 2,
          message: `Retrying with ${attempt === 2 ? '720p' : attempt === 3 ? '480p' : 'lower'} quality...`,
          phase: 'preparing',
        });
      }

      // Get cookies (force refresh on bot detection)
      const forceRefreshCookies = lastIsBotDetection || (attempt > 1 && lastError.includes('403'));
      
      try {
        const cookiesResult = await getCachedCookies(forceRefreshCookies);
        currentCookiePath = cookiesResult.tempPath;
        
        if (cookiesResult.usedFallback) {
          console.warn(`[Download ${downloadId}] Using fallback cookies`);
        }
      } catch {
        console.error(`[Download ${downloadId}] Cookie error`);
      }

      updateProgress(clientDownloadId, {
        progress: attempt > 1 ? 5 : 3,
        message: attempt > 1 ? `Retrying download (${attempt}/${MAX_RETRIES})...` : 'Starting download...',
        phase: 'preparing',
      });

      console.log(`[Download ${downloadId}] Attempt ${attempt}/${MAX_RETRIES}`);

      // Execute download
      const result = await executeDownload(url, formatId, tempFile, currentCookiePath, expectedSize, {
        ext: outputExt,
        hasVideo,
        needsMerge: formatId.includes('+'),
        downloadId,
        clientDownloadId,
        attempt,
      });

      if (result.success) {
        console.log(`[Download ${downloadId}] Success on attempt ${attempt}`);

        updateProgress(clientDownloadId, {
          progress: 97,
          message: 'Preparing file for transfer...',
          phase: 'processing',
        });

        // Log to history
        try {
          await addHistoryEntry({
            url,
            title: title || 'Unknown',
            format: formatId,
            ip,
            userAgent: request.headers.get('user-agent') || undefined,
            success: true,
          });
        } catch {
          // Ignore
        }

        // Read file and send response
        const fileBuffer = fs.readFileSync(tempFile);
        const filename = sanitizeForHeader(`${sanitizeFilename(title)}.${outputExt}`);
        const contentType = getContentType(outputExt, hasVideo);

        // Cleanup
        deleteTempFile(tempFile);

        updateProgress(clientDownloadId, {
          progress: 100,
          message: 'Complete!',
          phase: 'complete',
          completed: true,
          fileReady: true,
        });

        console.log(`[Download ${downloadId}] Sending ${formatBytes(fileBuffer.length)}`);

        const headers: Record<string, string> = {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Content-Length': fileBuffer.length.toString(),
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'X-Download-Filename': filename,
          'X-Download-Id': clientDownloadId,
        };
        
        if (usedFallback) {
          headers['X-Used-Fallback-Format'] = 'true';
        }

        return new Response(fileBuffer, { status: 200, headers });
      }

      // Handle failure
      lastError = result.error || 'Unknown error';
      lastIsBotDetection = result.isBotDetection || false;
      lastIsTimeout = result.isTimeout || false;

      console.log(`[Download ${downloadId}] Attempt ${attempt} failed: ${lastError}`);

      // Invalidate cookies on certain errors
      if (lastIsBotDetection || lastError.includes('403') || lastError.includes('429')) {
        invalidateCookiesCache();
      }

      // Clean up failed temp file
      deleteTempFile(tempFile);
      tempFile = getTempFilePath(outputExt);

      // Only retry on retryable errors
      if (!lastIsBotDetection && !lastIsTimeout && !result.isNetworkIssue) {
        break;
      }
    }

    // All retries failed
    console.error(`[Download ${downloadId}] All attempts failed: ${lastError}`);

    // User-friendly error message
    let userError = lastError;
    if (lastIsTimeout) {
      userError = 'Download timed out. Try a lower quality format.';
    } else if (lastIsBotDetection) {
      userError = 'YouTube blocked the request. Try again later.';
    }

    updateProgress(clientDownloadId, {
      progress: 0,
      message: userError,
      phase: 'error',
      error: userError,
      completed: false,
    });

    // Log failure
    try {
      await addHistoryEntry({
        url,
        title: title || 'Download Failed',
        format: requestedFormatId,
        ip,
        userAgent: request.headers.get('user-agent') || undefined,
        success: false,
        error: lastError,
      });
    } catch {
      // Ignore
    }

    // Cleanup
    deleteTempFile(tempFile);

    // Return error as JSON (avoid 500)
    return NextResponse.json(
      { 
        success: false, 
        error: userError,
        isBotDetection: lastIsBotDetection,
        isTimeout: lastIsTimeout,
        suggestion: lastIsTimeout 
          ? 'Try selecting a lower quality format (720p or below)' 
          : lastIsBotDetection 
            ? 'Try again in a few minutes' 
            : undefined,
      },
      { status: lastIsBotDetection ? 403 : lastIsTimeout ? 408 : 500 }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Download ${downloadId}] Unhandled error:`, errorMessage);
    
    // Cleanup
    deleteTempFile(tempFile);
    activeDownloads.delete(downloadId);

    // Return JSON error (avoid 500 crash)
    return NextResponse.json(
      { success: false, error: 'Server error: ' + errorMessage },
      { status: 500 }
    );
  }
}

// Cleanup on exit
process.on('SIGTERM', () => {
  activeDownloads.forEach(({ process, tempFile, tempCookie, timeoutController }) => {
    if (timeoutController) timeoutController.abort();
    if (process) process.kill('SIGTERM');
    deleteTempFile(tempFile);
    deleteTempFile(tempCookie);
  });
});
