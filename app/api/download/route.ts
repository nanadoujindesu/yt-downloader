/**
 * /api/download/route.ts
 * 
 * Server-side proxy download endpoint v5.4.2
 * 
 * v5.4.2 FINAL MERGE FIX:
 * - CRITICAL FIX: Force H.264 (avc1) video codec selection to ensure video stream is included
 * - Use --remux-video mp4 instead of --merge-output-format for proper container remux
 * - Added --force-overwrites and --no-continue for clean temp files
 * - Format string now explicitly requires vcodec^=avc1 for compatibility
 * 
 * v5.4.1 MERGE BUG FIX:
 * - Added --prefer-ffmpeg and --postprocessor-args (partial fix, still had issues)
 * 
 * v5.4.0 AUDIO/VIDEO FIX UPDATE:
 * - AUDIO FIX: Use temp file + --extract-audio for MP3/M4A (streaming doesn't work with -x)
 * - PROGRESS FIX: Force 100% on successful completion
 * - CORRUPTION FIX: Relaxed validation, proper content types
 * 
 * Key Issues Fixed:
 * - v5.4.2: MP4 files with audio-only (no video) - now forces H.264 video codec selection
 * - v5.4.1: Initial merge fix attempt (incomplete)
 * - "Video file was corrupted" on audio formats: Audio needs temp file, not stdout streaming
 * - Progress stuck at 98%: Force 100% on process exit code 0
 * 
 * @version 5.4.2 - Final Merge Fix
 */

import { NextRequest } from 'next/server';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { formatRequestSchema } from '@/lib/types';
import { checkRateLimit, sanitizeFilename } from '@/lib/ytdlp';
import { addHistoryEntry } from '@/lib/db';
import { updateProgress, clearProgress } from '@/lib/progress-store';
import {
  getCachedCookies,
  invalidateCookiesCache,
  getRandomProxy,
} from '@/lib/yt-dlp-utils';

// Vercel/Phala: Max execution time
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

// Track active downloads for cleanup
const activeDownloads = new Map<string, {
  process: ChildProcess | null;
  tempFile?: string;
  cookiePath?: string;
}>();

// Config
const DOWNLOAD_TIMEOUT = 240000; // 4 minutes
const MIN_AUDIO_SIZE = 1024; // 1KB minimum for audio
const MIN_VIDEO_SIZE = 10240; // 10KB minimum for video

/**
 * Get yt-dlp binary path
 */
function getYtDlpPath(): string {
  const localPath = path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(localPath)) return localPath;
  return 'yt-dlp';
}

/**
 * Ensure temp directory exists and return path
 */
function getTempDir(): string {
  const dir = path.join(os.tmpdir(), 'yt-downloader');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Generate unique temp file path
 */
function getTempFilePath(ext: string): string {
  const id = Math.random().toString(36).substring(2, 10);
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
  } catch { /* ignore */ }
}

/**
 * Parse yt-dlp progress from stderr
 */
function parseProgress(line: string): { progress: number; speed: string; eta: string; phase: string } | null {
  // Download progress: [download]  45.2% of 10.5MiB at 1.2MiB/s ETA 00:05
  const downloadMatch = line.match(/\[download\]\s+(\d+\.?\d*)%.*?at\s+([^\s]+).*?ETA\s+(\S+)/);
  if (downloadMatch) {
    return {
      progress: parseFloat(downloadMatch[1]),
      speed: downloadMatch[2],
      eta: downloadMatch[3],
      phase: 'downloading',
    };
  }
  
  // Merger/FFmpeg phase
  if (line.includes('[Merger]') || line.includes('[ffmpeg]') || line.includes('Merging')) {
    return { progress: 95, speed: '', eta: '', phase: 'merging' };
  }
  
  // ExtractAudio phase
  if (line.includes('[ExtractAudio]') || line.includes('Extracting audio')) {
    return { progress: 90, speed: '', eta: '', phase: 'extracting' };
  }
  
  return null;
}

/**
 * Clean up download resources
 */
function cleanupDownload(downloadId: string) {
  const download = activeDownloads.get(downloadId);
  if (download) {
    if (download.process && !download.process.killed) {
      try { download.process.kill('SIGTERM'); } catch { /* ignore */ }
    }
    deleteTempFile(download.tempFile);
    deleteTempFile(download.cookiePath);
    activeDownloads.delete(downloadId);
  }
  clearProgress(downloadId);
}

/**
 * Clean up old temp files (older than 10 minutes)
 */
function cleanupOldTempFiles(): void {
  try {
    const tempDir = getTempDir();
    const files = fs.readdirSync(tempDir);
    const now = Date.now();
    
    for (const file of files) {
      if (file.startsWith('dl_')) {
        const filePath = path.join(tempDir, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > 10 * 60 * 1000) {
          fs.unlinkSync(filePath);
        }
      }
    }
  } catch { /* ignore */ }
}

/**
 * Main download handler - uses temp file for reliability
 */
export async function POST(request: NextRequest) {
  const downloadId = `dl_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  let tempFile: string | null = null;
  
  console.log(`[Download ${downloadId}] Request started`);

  // Cleanup old files periodically
  cleanupOldTempFiles();

  try {
    // Rate limiting
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] ||
               request.headers.get('x-real-ip') || 'unknown';
    
    if (!checkRateLimit(ip)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Too many requests. Please wait a moment.' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Parse request body
    const body = await request.json();
    const validation = formatRequestSchema.safeParse(body);
    
    if (!validation.success) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid request parameters' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { url, format, quality, title: rawTitle, clientDownloadId, ext: requestExt } = validation.data;
    const progressId = clientDownloadId || downloadId;
    
    // Determine if audio-only based on format/quality/ext
    const isAudioOnly = format === 'audio' || 
                        quality === 'audio-only' || 
                        requestExt === 'mp3' || 
                        requestExt === 'm4a' ||
                        (quality && quality.toLowerCase().includes('audio'));
    
    // Determine output extension
    let outputExt: string;
    if (isAudioOnly) {
      outputExt = requestExt === 'm4a' ? 'm4a' : 'mp3';
    } else {
      outputExt = 'mp4';
    }
    
    // Sanitize title and create filename
    const title = sanitizeFilename(rawTitle || 'download');
    const filename = `${title}.${outputExt}`;
    
    // Content type based on format
    const contentType = outputExt === 'mp3' ? 'audio/mpeg' : 
                        outputExt === 'm4a' ? 'audio/mp4' : 
                        'video/mp4';

    console.log(`[Download ${downloadId}] URL: ${url}`);
    console.log(`[Download ${downloadId}] Audio: ${isAudioOnly}, Ext: ${outputExt}, Format: ${format}, Quality: ${quality}`);

    // Update progress: preparing
    updateProgress(progressId, {
      progress: 5,
      message: 'Preparing download...',
      phase: 'preparing',
    });

    // Get cookies
    let cookiePath: string | null = null;
    try {
      const cookies = await getCachedCookies();
      cookiePath = cookies.tempPath;
      console.log(`[Download ${downloadId}] Cookies ready`);
    } catch {
      console.warn(`[Download ${downloadId}] Cookie fetch failed, continuing without`);
    }

    // Create temp file path
    tempFile = getTempFilePath(outputExt);
    console.log(`[Download ${downloadId}] Temp file: ${tempFile}`);

    // Build yt-dlp arguments
    const args: string[] = [url];
    
    if (isAudioOnly) {
      // AUDIO DOWNLOAD - use --extract-audio for reliable conversion
      // This is the KEY FIX: audio needs temp file output, not stdout streaming
      args.push(
        '-f', 'bestaudio[ext=m4a]/bestaudio/best',
        '--extract-audio',
        '--audio-format', outputExt === 'm4a' ? 'm4a' : 'mp3',
        '--audio-quality', '0', // Best quality
        '-o', tempFile,
      );
      console.log(`[Download ${downloadId}] Audio mode: extracting to ${outputExt}`);
    } else {
      // VIDEO DOWNLOAD - use format string with proper merge
      // v5.4.2 FINAL MERGE FIX: Force H.264 (avc1) video codec to ensure video stream is included
      // Issue: Without vcodec filter, yt-dlp may select audio-only or incompatible video streams
      let formatStr: string;
      
      if (format && format !== 'best' && format !== 'audio') {
        // Specific format ID requested - wrap with merge-compatible fallbacks using avc1 codec
        // Fix audio-only MP4: force avc1 video codec for compatibility and stream inclusion
        formatStr = `${format}/bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1]+bestaudio/bestvideo+bestaudio/best`;
      } else if (quality) {
        // Quality-based selection with explicit H.264 (avc1) video codec requirement
        const height = quality.replace('p', '');
        if (height === 'best' || quality === 'best') {
          // v5.4.2: Force avc1 codec for best compatibility, ensures video stream is selected
          formatStr = 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1]+bestaudio/bestvideo+bestaudio/best';
        } else {
          // Height-limited selection with avc1 codec priority for video stream guarantee
          formatStr = `bestvideo[ext=mp4][height<=${height}][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=${height}][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=${height}][vcodec^=avc1]+bestaudio/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
        }
      } else {
        // Default: 720p max for stability with avc1 codec for proper video+audio merge
        formatStr = 'bestvideo[ext=mp4][height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=720][vcodec^=avc1]+bestaudio/bestvideo[height<=720]+bestaudio/best[height<=720]/best';
      }
      
      // v5.4.2 FINAL MERGE FIX: Use --remux-video instead of --merge-output-format
      // --remux-video forces proper remuxing into MP4 container with video stream
      args.push(
        '-f', formatStr,
        '--remux-video', 'mp4',           // Force remux into proper MP4 container with video
        '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac',  // Copy video stream, encode audio to AAC
        '--force-overwrites',             // Clean temp file handling
        '--no-continue',                  // Don't resume partial downloads (ensure clean file)
        '-o', tempFile,
      );
      console.log(`[Download ${downloadId}] Video mode: format=${formatStr} (v5.4.2 final merge fix)`);
    }

    // Common args
    args.push(
      '--no-playlist',
      '--no-warnings',
      '--progress',
      '--newline',
      '--socket-timeout', '60',
      '--retries', '10',
      '--fragment-retries', '10',
      '--no-part',
      '--no-mtime',
    );

    // Add cookies if available
    if (cookiePath && fs.existsSync(cookiePath)) {
      args.push('--cookies', cookiePath);
    }

    // Add proxy if configured
    const proxy = getRandomProxy();
    if (proxy) {
      args.push('--proxy', proxy);
      console.log(`[Download ${downloadId}] Using proxy`);
    }

    console.log(`[Download ${downloadId}] Starting yt-dlp...`);

    // Spawn yt-dlp process
    const ytdlpPath = getYtDlpPath();
    const proc = spawn(ytdlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    // Track this download
    activeDownloads.set(downloadId, {
      process: proc,
      tempFile,
      cookiePath: cookiePath || undefined,
    });

    // Update progress: downloading
    updateProgress(progressId, {
      progress: 10,
      message: 'Starting download...',
      phase: 'downloading',
    });

    // Promise to wait for download completion
    const downloadResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      let errorOutput = '';
      let lastProgress = 0;
      let lastPhase = 'downloading';
      
      // Timeout handler
      const timeout = setTimeout(() => {
        console.error(`[Download ${downloadId}] Timeout after ${DOWNLOAD_TIMEOUT}ms`);
        proc.kill('SIGTERM');
        resolve({ success: false, error: 'Download timed out. Try a lower quality or shorter video.' });
      }, DOWNLOAD_TIMEOUT);

      // Handle stdout (usually empty for file output)
      proc.stdout?.on('data', () => {});

      // Handle stderr - progress info
      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        errorOutput += text;

        // Parse and update progress
        const lines = text.split('\n');
        for (const line of lines) {
          const progress = parseProgress(line);
          if (progress) {
            // Update phase
            if (progress.phase !== lastPhase) {
              lastPhase = progress.phase;
              console.log(`[Download ${downloadId}] Phase: ${progress.phase}`);
            }
            
            // Calculate overall progress (0-100)
            let overallProgress: number;
            if (progress.phase === 'downloading') {
              overallProgress = Math.round(10 + (progress.progress * 0.75)); // 10-85%
            } else if (progress.phase === 'extracting') {
              overallProgress = 88;
            } else if (progress.phase === 'merging') {
              overallProgress = 92;
            } else {
              overallProgress = Math.max(lastProgress, progress.progress);
            }
            
            if (overallProgress > lastProgress) {
              lastProgress = overallProgress;
              updateProgress(progressId, {
                progress: Math.min(overallProgress, 95), // Cap at 95 until complete
                message: progress.phase === 'merging' ? 'Merging video and audio...' :
                         progress.phase === 'extracting' ? 'Extracting audio...' :
                         `Downloading... ${progress.progress.toFixed(0)}%${progress.speed ? ` (${progress.speed})` : ''}`,
                phase: progress.phase,
                speed: progress.speed || undefined,
                eta: progress.eta || undefined,
              });
            }
          }

          // Check for errors
          if (line.includes('ERROR') || line.includes('error:')) {
            console.error(`[Download ${downloadId}] yt-dlp error: ${line}`);
          }
        }
      });

      // Handle process completion
      proc.on('close', (code) => {
        clearTimeout(timeout);
        
        if (code === 0) {
          console.log(`[Download ${downloadId}] yt-dlp completed successfully`);
          
          // CRITICAL: Force progress to 100% on success
          updateProgress(progressId, {
            progress: 100,
            message: 'Download complete!',
            phase: 'complete',
          });
          
          resolve({ success: true });
        } else {
          console.error(`[Download ${downloadId}] yt-dlp failed with code ${code}`);
          
          // Determine error message
          let errorMsg = 'Download failed';
          if (errorOutput.includes('bot') || errorOutput.includes('Sign in') || errorOutput.includes('confirm')) {
            errorMsg = 'YouTube blocked the request. Cookies may be expired.';
            invalidateCookiesCache();
          } else if (errorOutput.includes('unavailable') || errorOutput.includes('not available') || errorOutput.includes('Private')) {
            errorMsg = 'Video is unavailable, private, or region-locked.';
          } else if (errorOutput.includes('format') || errorOutput.includes('no suitable')) {
            errorMsg = 'Requested format not available. Try a different quality.';
          } else if (errorOutput.includes('ffmpeg') || errorOutput.includes('merge')) {
            errorMsg = 'Failed to merge video/audio. Try audio-only or different quality.';
          }
          
          resolve({ success: false, error: errorMsg });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`[Download ${downloadId}] Process error:`, err.message);
        resolve({ success: false, error: `Process error: ${err.message}` });
      });
    });

    // Handle download result
    if (!downloadResult.success) {
      updateProgress(progressId, {
        progress: 0,
        message: downloadResult.error || 'Download failed',
        phase: 'error',
        error: downloadResult.error,
      });
      
      cleanupDownload(downloadId);
      
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: downloadResult.error,
          suggestion: isAudioOnly ? 'Try a different audio format' : 'Try a lower quality or audio-only',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'X-Error': 'true' } }
      );
    }

    // Check if file exists and has content
    if (!tempFile || !fs.existsSync(tempFile)) {
      console.error(`[Download ${downloadId}] Temp file not found: ${tempFile}`);
      cleanupDownload(downloadId);
      return new Response(
        JSON.stringify({ success: false, error: 'Download failed - no output file' }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'X-Error': 'true' } }
      );
    }

    const fileStats = fs.statSync(tempFile);
    const minSize = isAudioOnly ? MIN_AUDIO_SIZE : MIN_VIDEO_SIZE;
    
    console.log(`[Download ${downloadId}] File size: ${fileStats.size} bytes (min: ${minSize})`);

    if (fileStats.size < minSize) {
      console.error(`[Download ${downloadId}] File too small: ${fileStats.size} < ${minSize}`);
      cleanupDownload(downloadId);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'Downloaded file is too small or corrupted',
          suggestion: 'Try a different format or quality',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'X-Error': 'true' } }
      );
    }

    // Log to history
    addHistoryEntry({
      url: url,
      title: title,
      format: isAudioOnly ? `audio/${outputExt}` : `video/${quality || 'auto'}`,
      success: true,
    }).catch(() => {});

    console.log(`[Download ${downloadId}] Streaming file to client: ${fileStats.size} bytes`);

    // Stream file to response
    const fileStream = fs.createReadStream(tempFile);
    const readableStream = new ReadableStream({
      start(controller) {
        fileStream.on('data', (chunk) => {
          controller.enqueue(chunk);
        });
        fileStream.on('end', () => {
          controller.close();
          // Cleanup after stream completes
          deleteTempFile(tempFile);
          activeDownloads.delete(downloadId);
        });
        fileStream.on('error', (err) => {
          console.error(`[Download ${downloadId}] Stream error:`, err);
          controller.error(err);
          cleanupDownload(downloadId);
        });
      },
      cancel() {
        fileStream.destroy();
        cleanupDownload(downloadId);
      },
    });

    return new Response(readableStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(fileStats.size),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Cache-Control': 'no-cache, no-store',
        'X-Download-Id': downloadId,
      },
    });

  } catch (error) {
    console.error(`[Download ${downloadId}] Fatal error:`, error);
    cleanupDownload(downloadId);

    const errorMsg = error instanceof Error ? error.message : 'Download failed';
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: errorMsg,
        suggestion: 'Try again or use a different format',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'X-Error': 'true' } }
    );
  }
}

/**
 * Handle download cancellation
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const downloadId = searchParams.get('id');

    if (downloadId && activeDownloads.has(downloadId)) {
      cleanupDownload(downloadId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: false, error: 'Download not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ success: false }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
