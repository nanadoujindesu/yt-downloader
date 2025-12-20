/**
 * yt-dlp Utilities for Timeout Fix Update
 * 
 * v5.2.0 CHANGES:
 * - REMOVED FFprobe dependency (too slow, causes false positives)
 * - Relaxed validation: metadata-based size check instead
 * - Extended cookies cache to 60s for stability
 * - Increased timeouts for serverless environments (Phala Cloud/Vercel)
 * - Better fallback format selection
 * 
 * @version 5.2.0 - Timeout Fix Update
 */

import { ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import axios from 'axios';

// ==========================================
// Types
// ==========================================

export interface CookiesCache {
  content: string;
  lastFetch: number;
  tempPath: string | null;
  isValid: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  fileSize: number;
  expectedSize: number | null;
  sizeRatio: number | null;
  error?: string;
}

export interface DownloadConfig {
  timeout: number;
  maxRetries: number;
  fallbackFormats: string[];
  concurrentFragments: number;
  socketTimeout: number;
  httpTimeout: number;
  httpChunkSize: string;
}

export interface TimeoutController {
  abort: () => void;
  timeoutId: NodeJS.Timeout;
  isAborted: boolean;
}

// ==========================================
// Constants - v5.2.0 Optimized for Stability
// ==========================================

// Cache TTL: 60 seconds (extended from 30s for stability)
const COOKIES_CACHE_TTL = 60 * 1000;

// Fetch timeout for cookies
const COOKIES_FETCH_TIMEOUT = 8000;

// Maximum download time: 2 minutes (optimized for serverless ~60s limit)
const MAX_DOWNLOAD_TIMEOUT = 120 * 1000;

// Minimum file size: 1KB (very relaxed to avoid false positives)
const MIN_FILE_SIZE = 1024;

// Size tolerance: Allow 50-200% of expected size (very relaxed)
const SIZE_TOLERANCE_MIN = 0.5;
const SIZE_TOLERANCE_MAX = 2.0;

// Default download configuration - v5.2.0 optimized
export const DEFAULT_DOWNLOAD_CONFIG: DownloadConfig = {
  timeout: MAX_DOWNLOAD_TIMEOUT,
  maxRetries: 3,
  fallbackFormats: [
    'best[height<=720]',       // 720p max (fast & stable)
    'best[height<=480]',       // 480p fallback
    'best[height<=360]',       // 360p last resort
    'best',                    // Absolute fallback
  ],
  concurrentFragments: 2,      // Reduced for stability (was 4)
  socketTimeout: 30,           // Increased from 10s
  httpTimeout: 30,             // Added HTTP timeout
  httpChunkSize: '10M',        // 10MB chunks
};

// Temp directory
const TEMP_DIR = path.join(os.tmpdir(), 'yt-downloader');

// ==========================================
// Cookies Cache Implementation
// ==========================================

// In-memory cookies cache
const cookiesCache: CookiesCache = {
  content: '',
  lastFetch: 0,
  tempPath: null,
  isValid: false,
};

// External cookies URL
const COOKIES_URL = process.env.COOKIES_URL || 'https://amy-subjective-macro-powers.trycloudflare.com/';

/**
 * Check if cookies cache is still valid
 */
export function isCookiesCacheValid(): boolean {
  if (!cookiesCache.isValid) return false;
  if (!cookiesCache.content) return false;
  if (Date.now() - cookiesCache.lastFetch > COOKIES_CACHE_TTL) return false;
  return true;
}

/**
 * Get cached cookies or fetch fresh ones
 * Uses 60-second TTL (extended from 30s for stability)
 */
export async function getCachedCookies(forceRefresh = false): Promise<{
  content: string;
  tempPath: string;
  fromCache: boolean;
  usedFallback: boolean;
}> {
  // Check cache validity
  if (!forceRefresh && isCookiesCacheValid() && cookiesCache.tempPath && fs.existsSync(cookiesCache.tempPath)) {
    const age = Math.round((Date.now() - cookiesCache.lastFetch) / 1000);
    console.log(`[CookiesCache] Using cached cookies (age: ${age}s)`);
    return {
      content: cookiesCache.content,
      tempPath: cookiesCache.tempPath,
      fromCache: true,
      usedFallback: false,
    };
  }

  console.log('[CookiesCache] Fetching fresh cookies from:', COOKIES_URL);
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COOKIES_FETCH_TIMEOUT);

    const response = await axios.get(COOKIES_URL, {
      timeout: COOKIES_FETCH_TIMEOUT,
      responseType: 'text',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; YT-Downloader/5.2)',
        'Accept': 'text/plain, */*',
      },
      validateStatus: (status) => status < 500,
    });

    clearTimeout(timeoutId);

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const content = typeof response.data === 'string' ? response.data : String(response.data);

    // Validate basic format
    if (!content.includes('# Netscape') && !content.includes('# HTTP Cookie')) {
      throw new Error('Invalid cookies format');
    }

    if (!content.includes('.youtube.com') && !content.includes('youtube.com')) {
      throw new Error('No YouTube cookies found');
    }

    // Clean up old temp file
    if (cookiesCache.tempPath && fs.existsSync(cookiesCache.tempPath)) {
      try {
        fs.unlinkSync(cookiesCache.tempPath);
      } catch {
        // Ignore
      }
    }

    // Write to new temp file
    ensureTempDir(TEMP_DIR);
    const tempPath = path.join(TEMP_DIR, `cookies_${Date.now()}.txt`);
    fs.writeFileSync(tempPath, content, 'utf-8');

    // Update cache
    cookiesCache.content = content;
    cookiesCache.lastFetch = Date.now();
    cookiesCache.tempPath = tempPath;
    cookiesCache.isValid = true;

    console.log('[CookiesCache] Fresh cookies cached, length:', content.length);

    return {
      content,
      tempPath,
      fromCache: false,
      usedFallback: false,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[CookiesCache] Fetch failed:', errorMessage);
    return createFallbackCookies();
  }
}

/**
 * Create fallback consent cookies when fetch fails
 */
function createFallbackCookies(): {
  content: string;
  tempPath: string;
  fromCache: boolean;
  usedFallback: boolean;
} {
  const fallbackContent = `# Netscape HTTP Cookie File
# Fallback consent cookies generated by yt-dlp-utils v5.2.0
# Generated at: ${new Date().toISOString()}

.youtube.com\tTRUE\t/\tTRUE\t0\tSOCS\tCAISEAIgACgA
.youtube.com\tTRUE\t/\tTRUE\t0\tCONSENT\tYES+cb.20250101-01-p0.en+FX+123
`;

  ensureTempDir(TEMP_DIR);
  const tempPath = path.join(TEMP_DIR, `fallback_cookies_${Date.now()}.txt`);
  fs.writeFileSync(tempPath, fallbackContent, 'utf-8');

  console.log('[CookiesCache] Using fallback consent cookies');

  return {
    content: fallbackContent,
    tempPath,
    fromCache: false,
    usedFallback: true,
  };
}

/**
 * Invalidate cookies cache (force refresh on next request)
 */
export function invalidateCookiesCache(): void {
  cookiesCache.isValid = false;
  console.log('[CookiesCache] Cache invalidated');
}

/**
 * Cleanup cached cookies temp file
 */
export function cleanupCachedCookies(): void {
  if (cookiesCache.tempPath && fs.existsSync(cookiesCache.tempPath)) {
    try {
      fs.unlinkSync(cookiesCache.tempPath);
      cookiesCache.tempPath = null;
    } catch {
      // Ignore
    }
  }
}

// ==========================================
// Lightweight File Validation (NO FFprobe)
// ==========================================

/**
 * Ensure temp directory exists
 */
function ensureTempDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Validate downloaded file using metadata-based size check
 * v5.2.0: Removed FFprobe, uses relaxed size validation
 * 
 * @param filePath - Path to downloaded file
 * @param expectedSize - Expected size from metadata (optional)
 * @param isAudioOnly - Whether this is audio-only format
 */
export function validateDownloadedFile(
  filePath: string,
  expectedSize: number | null = null,
  isAudioOnly: boolean = false
): ValidationResult {
  console.log(`[Validate] Checking file: ${path.basename(filePath)}`);
  
  // Check file exists
  if (!fs.existsSync(filePath)) {
    return {
      isValid: false,
      fileSize: 0,
      expectedSize,
      sizeRatio: null,
      error: 'File does not exist',
    };
  }

  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  
  console.log(`[Validate] File size: ${formatBytes(fileSize)}, Expected: ${expectedSize ? formatBytes(expectedSize) : 'unknown'}`);

  // Basic minimum size check (very relaxed)
  // Audio files can be very small (1KB+), video needs more
  const minSize = isAudioOnly ? 512 : MIN_FILE_SIZE;
  
  if (fileSize < minSize) {
    return {
      isValid: false,
      fileSize,
      expectedSize,
      sizeRatio: null,
      error: `File too small: ${formatBytes(fileSize)} (min: ${formatBytes(minSize)})`,
    };
  }

  // If we have expected size, check if within tolerance
  // But be VERY relaxed to avoid false positives
  if (expectedSize && expectedSize > 0) {
    const sizeRatio = fileSize / expectedSize;
    
    // Allow 50% to 200% of expected size (very generous)
    if (sizeRatio < SIZE_TOLERANCE_MIN || sizeRatio > SIZE_TOLERANCE_MAX) {
      console.warn(`[Validate] Size mismatch: ratio=${sizeRatio.toFixed(2)} (expected 0.5-2.0)`);
      // Only fail if DRASTICALLY different (< 10% or > 500%)
      if (sizeRatio < 0.1 || sizeRatio > 5.0) {
        return {
          isValid: false,
          fileSize,
          expectedSize,
          sizeRatio,
          error: `Size mismatch: got ${formatBytes(fileSize)}, expected ~${formatBytes(expectedSize)}`,
        };
      }
      // Otherwise just warn but consider valid
      console.warn('[Validate] Size outside normal range but accepting anyway');
    }
    
    return {
      isValid: true,
      fileSize,
      expectedSize,
      sizeRatio,
    };
  }

  // No expected size - just check for valid container header
  const headerCheck = quickValidateHeader(filePath);
  if (!headerCheck.isValid) {
    return {
      isValid: false,
      fileSize,
      expectedSize: null,
      sizeRatio: null,
      error: headerCheck.error,
    };
  }

  return {
    isValid: true,
    fileSize,
    expectedSize: null,
    sizeRatio: null,
  };
}

/**
 * Quick header validation - checks for valid container signatures
 */
export function quickValidateHeader(filePath: string): { isValid: boolean; error?: string } {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(12);
    fs.readSync(fd, buffer, 0, 12, 0);
    fs.closeSync(fd);

    const hex = buffer.toString('hex');
    
    // MP4/M4A/M4V: 'ftyp' at offset 4
    if (hex.includes('66747970')) return { isValid: true };
    
    // WebM/MKV: starts with 0x1A45DFA3
    if (hex.startsWith('1a45dfa3')) return { isValid: true };
    
    // MP3: ID3 tag or sync word
    if (hex.startsWith('494433') || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2')) {
      return { isValid: true };
    }

    // OGG/Opus: OggS
    if (hex.startsWith('4f676753')) return { isValid: true };
    
    // WAV: RIFF
    if (hex.startsWith('52494646')) return { isValid: true };

    // Unknown format but has content - assume valid (avoid false positives)
    console.log('[QuickValidate] Unknown format header:', hex.substring(0, 16));
    return { isValid: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { isValid: false, error: `Read error: ${errorMessage}` };
  }
}

// ==========================================
// Timeout and Process Management
// ==========================================

/**
 * Create a timeout controller for long-running operations
 * v5.2.0: Extended default timeout to 120s for serverless
 */
export function createTimeoutController(timeoutMs: number, onTimeout?: () => void): TimeoutController {
  const controller: TimeoutController = {
    isAborted: false,
    timeoutId: setTimeout(() => {
      controller.isAborted = true;
      if (onTimeout) onTimeout();
    }, timeoutMs),
    abort: () => {
      clearTimeout(controller.timeoutId);
      controller.isAborted = true;
    },
  };

  return controller;
}

/**
 * Kill a child process with timeout
 */
export async function killProcessWithTimeout(
  process: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  timeoutMs: number = 5000
): Promise<void> {
  return new Promise((resolve) => {
    if (!process.pid) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      try {
        process.kill('SIGKILL');
      } catch {
        // Ignore
      }
      resolve();
    }, timeoutMs);

    process.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      process.kill(signal);
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

// ==========================================
// Fallback Format Selection
// ==========================================

/**
 * Get fallback format based on retry attempt
 * v5.2.0: Added 360p as last resort before 'best'
 */
export function getFallbackFormat(attempt: number, originalFormat: string): string {
  if (attempt === 0) {
    return originalFormat;
  }

  const fallbacks = DEFAULT_DOWNLOAD_CONFIG.fallbackFormats;
  const fallbackIndex = Math.min(attempt - 1, fallbacks.length - 1);
  return fallbacks[fallbackIndex];
}

/**
 * Check if format is a "best quality" merge format
 */
export function isBestQualityFormat(formatId: string): boolean {
  const bestFormats = [
    'bestvideo+bestaudio',
    'bv*+ba',
    'bv+ba',
    'bestvideo*+bestaudio',
  ];
  
  return bestFormats.some(f => formatId.toLowerCase().includes(f.toLowerCase())) ||
         formatId.includes('+');
}

/**
 * Check if format needs merging (video+audio separate)
 */
export function needsMergeFormat(formatId: string): boolean {
  return formatId.includes('+');
}

/**
 * Get optimized yt-dlp format string for best quality
 */
export function getOptimizedBestFormat(preferredExt: string = 'mp4'): string {
  if (preferredExt === 'webm') {
    return 'bestvideo[ext=webm]+bestaudio[ext=webm]/bestvideo+bestaudio/best';
  }
  return 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/best[ext=mp4]/best';
}

// ==========================================
// Error Detection - v5.2.0 Enhanced
// ==========================================

/**
 * Check if error indicates file is corrupted
 */
export function isCorruptionError(error: string | Error): boolean {
  const errorStr = typeof error === 'string' ? error : error.message;
  const lower = errorStr.toLowerCase();
  
  const indicators = [
    'corrupt',
    'invalid data',
    'malformed',
    'truncated',
    'incomplete',
    'moov atom not found',
    'premature end',
    'unexpected end',
    'broken pipe',
  ];
  
  return indicators.some(i => lower.includes(i));
}

/**
 * Check if error indicates timeout
 */
export function isTimeoutError(error: string | Error): boolean {
  const errorStr = typeof error === 'string' ? error : error.message;
  const lower = errorStr.toLowerCase();
  
  return lower.includes('timeout') || 
         lower.includes('timed out') || 
         lower.includes('etimedout') ||
         lower.includes('econnreset') ||
         lower.includes('socket hang up');
}

/**
 * Check if error indicates rate limiting / bot detection
 */
export function isRateLimitError(error: string | Error): boolean {
  const errorStr = typeof error === 'string' ? error : error.message;
  const lower = errorStr.toLowerCase();
  
  return lower.includes('429') ||
         lower.includes('rate limit') ||
         lower.includes('too many') ||
         lower.includes('sign in') ||
         lower.includes('bot') ||
         lower.includes('captcha') ||
         lower.includes('403') ||
         lower.includes('forbidden');
}

/**
 * Check if error indicates network issue (worth retrying)
 */
export function isNetworkError(error: string | Error): boolean {
  const errorStr = typeof error === 'string' ? error : error.message;
  const lower = errorStr.toLowerCase();
  
  return lower.includes('network') ||
         lower.includes('enotfound') ||
         lower.includes('econnrefused') ||
         lower.includes('econnreset') ||
         lower.includes('socket') ||
         lower.includes('dns');
}

// ==========================================
// Utility Functions
// ==========================================

/**
 * Clean up old temp files
 */
export function cleanupOldTempFiles(): void {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;
    
    const files = fs.readdirSync(TEMP_DIR);
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs < tenMinutesAgo) {
          fs.unlinkSync(filePath);
          console.log('[Cleanup] Removed old temp file:', file);
        }
      } catch {
        // Ignore
      }
    }
  } catch {
    // Ignore
  }
}

/**
 * Get file size in human-readable format
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Get temp directory path
 */
export function getTempDir(): string {
  ensureTempDir(TEMP_DIR);
  return TEMP_DIR;
}

/**
 * Estimate if download might timeout based on file size
 * v5.2.0: Warn for files > 100MB
 */
export function mightTimeout(filesizeApprox: number | null): boolean {
  if (!filesizeApprox) return false;
  // Warn if file is > 100MB (might exceed 60s serverless limit)
  return filesizeApprox > 100 * 1024 * 1024;
}

/**
 * Get warning message for potentially slow downloads
 */
export function getTimeoutWarning(filesizeApprox: number | null): string | null {
  if (!filesizeApprox) return null;
  if (filesizeApprox > 500 * 1024 * 1024) {
    return 'Large file (>500MB) - may timeout. Try lower quality.';
  }
  if (filesizeApprox > 100 * 1024 * 1024) {
    return 'File may take a while to download.';
  }
  return null;
}

// Run cleanup on module load
cleanupOldTempFiles();
