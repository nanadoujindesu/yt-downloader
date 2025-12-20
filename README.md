# 🎬 YouTube Downloader v5.4.2 - Final Merge Fix

A modern, production-ready web application for downloading YouTube videos using yt-dlp. Features **reliable audio downloads (MP3/M4A)**, **streaming proxy**, **auto-cookies**, and is optimized for serverless environments.

**🚀 Designed for Phala Cloud, Vercel, and VPS platforms with strict timeout limits**

![Next.js](https://img.shields.io/badge/Next.js-14-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue?style=flat-square&logo=typescript)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.4-38B2AC?style=flat-square&logo=tailwind-css)
![DaisyUI](https://img.shields.io/badge/DaisyUI-4.12-5A0EF8?style=flat-square)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

## 🔧 What's New in v5.4.2 - Final Merge Fix

### 🎬 Critical Video Merge Fix (FINAL)
This update **definitively fixes** recommended video formats downloading as **audio-only MP4** (no video stream).

#### Issue Reported
```
User reported: Downloaded "MiawAug Ketakutan Bisa Sembunyi Di Dalam Gamenya!_.mp4" 
plays sound but shows black screen/no video. MP4 contains only audio stream.
Previous fix v5.4.1 did not fully resolve the issue.
```

#### Root Cause (Final Analysis)
The format selection was not explicitly requiring a **video codec** (vcodec). YouTube provides both video-only and audio-only streams. Without the `vcodec^=avc1` filter, yt-dlp could select incompatible streams or fail to include the video stream in the merge.

#### Solution (Final Fix)
```typescript
// v5.4.2 FINAL FIX: Force H.264 (avc1) video codec selection
formatStr = 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1]+bestaudio/bestvideo+bestaudio/best';

// Use --remux-video instead of --merge-output-format for proper container handling
args.push(
  '-f', formatStr,
  '--remux-video', 'mp4',                              // Force remux into proper MP4 with video
  '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac', // Copy video, encode audio
  '--force-overwrites',                                 // Clean temp file
  '--no-continue',                                      // Don't resume partial downloads
);
```

#### Key Changes from v5.4.1
| Aspect | v5.4.1 | v5.4.2 |
|--------|--------|--------|
| Video Codec | Not specified | `vcodec^=avc1` (H.264) |
| Container | `--merge-output-format mp4` | `--remux-video mp4` |
| Postprocessor | `-c:v copy -c:a aac -strict experimental` | `-c:v copy -c:a aac` |
| Temp Files | Default | `--force-overwrites --no-continue` |

#### Testing the Fix
1. Download a video using **"Best Quality"** or **"1080p"** (merge formats with badge)
2. Play the downloaded `.mp4` in VLC or any media player
3. **Verify video is visible** (not black screen with audio only)
4. Optional: Run `ffprobe -i video.mp4` - should show both video AND audio streams:
   ```
   Stream #0:0: Video: h264 (avc1)...
   Stream #0:1: Audio: aac...
   ```

#### ⚠️ Important Note
This is a **minimal targeted fix** - only yt-dlp args in the download route were modified. All other features (audio MP3/M4A, cookies, proxy, progress, admin panel) remain unchanged and working.

---

## 🔧 What's New in v5.4.1 - Merge Bug Fix

### 🎵 Audio/Video Fix Update
This update fixes **"Video file was corrupted"** errors for audio formats (MP3/M4A) and addresses progress getting stuck at 98%.

#### Errors Being Fixed
```
Download error: Video file was corrupted. Try a different format.
Progress stuck at 98% even when files downloaded successfully
Recommended video formats (1080p, 720p with merge) corrupting
```

#### Root Cause Analysis
The v5.3.0 streaming approach (`yt-dlp -o -` output to stdout) **doesn't work with `--extract-audio`**. When using `-x/--extract-audio`, yt-dlp must write to a file, not stdout.

#### Solution: Temp File for Audio
```
                    v5.3.0 (Streaming)                       v5.4.0 (Audio Fix)
                    
   yt-dlp -o - ──► stdout ──► response        yt-dlp ──► temp file ──► stream to response
        │                                          │
        └── Works for VIDEO only                   └── Works for AUDIO (requires -x flag)
             ▼                                          ▼
        AUDIO CORRUPT (0 bytes)                    AUDIO SUCCESS
```

### Key Changes from v5.3.0

| Feature | v5.3.0 | v5.4.0 |
|---------|--------|--------|
| Audio Download | Stdout streaming (broken) | Temp file + `--extract-audio` |
| Audio Format Args | `-f bestaudio -o -` | `-f bestaudio -x --audio-format mp3/m4a -o file` |
| Video Download | Stdout streaming | Temp file (more reliable) |
| Progress Complete | Stuck at 98% | Force 100% on exit code 0 |
| UI Audio Section | Mixed with video | **First section** with "Most Reliable" badge |
| File Validation | 10KB min | 1KB for audio, 10KB for video |

### Implementation Details

```typescript
// v5.4.0 Audio Download (FIXED)
if (isAudioOnly) {
  args.push(
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--extract-audio',           // KEY: This flag requires file output
    '--audio-format', 'mp3',     // Convert to mp3
    '--audio-quality', '0',      // Best quality
    '-o', tempFile,              // Output to temp file (not stdout!)
  );
}

// Force progress to 100% on success
proc.on('close', (code) => {
  if (code === 0) {
    updateProgress(progressId, { progress: 100, phase: 'complete' });
  }
});
```

### UI Updates

**Audio Formats Now Prioritized:**
- Audio section appears **first** with green "Most Reliable" badge
- Fast download indicator on audio formats
- Video merge formats show warning about potential timeouts
- Better tooltips explaining format differences

## 🛡️ Proxy Support

### Configure Proxies

**Option 1: Environment Variable**
```yaml
# docker-compose.yml
environment:
  - PROXY_LIST=http://user:pass@proxy1:8080,http://proxy2:8080
  # or
  - PROXIES=socks5://proxy:1080
```

**Option 2: Admin Panel**
Navigate to Admin → Settings → Proxies and add your proxy list.

### Why Use Proxies?
- Bypass YouTube IP blocks
- Improve download speeds
- Distribute requests across IPs
- Avoid rate limiting

## ⚠️ Serverless Deployment Notes

### Phala Cloud / Vercel Recommendations

1. **Streaming works within limits** - No more 408 timeouts on normal videos
2. **Very long videos (>10 min)** - May still timeout; consider lower quality
3. **Proxy rotation** - Helps if YouTube blocks your server IP
4. **Keep-alive heartbeats** - Prevent gateway from closing idle connections

### Recommended docker-compose.yml

```yaml
version: '3.8'
services:
  youtube-downloader:
    image: mpratamamail/youtube-downloader:5.3.0
    container_name: youtube-downloader
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=your-secure-password
      - JWT_SECRET=your-jwt-secret-key
      - COOKIES_URL=https://your-cookies-server.com/cookies.txt
      # Optional: Add proxies
      - PROXY_LIST=http://proxy1:8080,http://proxy2:8080
    volumes:
      - youtube_data:/data
    restart: unless-stopped

volumes:
  youtube_data:
```

## ✨ Features

### Core Functionality
- 🎬 **Video Downloads** - Various resolutions (4K, 1080p, 720p, etc.)
- 🎵 **Audio Extraction** - MP3, M4A formats
- 📋 **Playlist Support** - Browse and download individual videos
- 🔄 **Streaming Proxy** - Pure stdout streaming, no temp file wait
- 📱 **YouTube Shorts** - Full support
- 📏 **File Size Display** - Estimated file size for each format
- ⬇️ **Progress Tracking** - Real-time SSE progress

### 🎛️ Admin Panel
- 🔐 **Secure Authentication** - JWT-based login
- 📊 **Dashboard** - Real-time statistics
- 📜 **History Logs** - Track all activity
- ⚙️ **Site Settings** - Customize appearance
- 🌐 **Proxy Management** - Add/remove proxies
- 👤 **Profile Management** - Change password

### 2025 Bot Detection Fixes
- 🍪 **Auto-Fetch Cookies** - Fresh cookies from external URL
- 🎭 **Random User-Agent** - Rotation to avoid detection
- 🔐 **Consent Cookies** - Automatic bypass fallback
- ⏱️ **Request Throttling** - Avoids rate limits
- 🌍 **Geo Bypass** - Works around regional restrictions
- 🔄 **Proxy Rotation** - Distribute requests across IPs

### Modern UI/UX
- �� **Beautiful Design** - DaisyUI components
- 🌙 **Dark/Light Mode** - System-aware toggle
- ✨ **Animations** - Framer Motion
- 📱 **Fully Responsive** - Mobile-first
- 🔔 **Toast Notifications** - Real-time feedback

## 🚀 Quick Start

### Docker (Recommended)

```bash
# Pull latest image
docker pull mpratamamail/youtube-downloader:5.3.0

# Run with docker-compose
docker-compose up -d
```

### Local Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_USERNAME` | `admin` | Admin panel username |
| `ADMIN_PASSWORD` | `admin123` | Admin panel password |
| `JWT_SECRET` | random | Secret for JWT tokens |
| `COOKIES_URL` | cloudflare tunnel | External cookies URL |
| `PROXY_LIST` | (none) | Comma-separated proxy URLs |

### Proxy URL Formats

```
http://proxy:8080
http://user:pass@proxy:8080
socks5://proxy:1080
socks5://user:pass@proxy:1080
```

## 📊 Streaming Flow (v5.3.0)

```
┌─────────────────┐     yt-dlp stdout     ┌─────────────────┐
│   yt-dlp        │ ────────────────────► │   Response      │
│   -o -          │    (immediate)        │   Stream        │
└─────────────────┘                       └────────┬────────┘
                                                   │
         ┌─────────────────────────────────────────┤
         │                                         │
         ▼                                         ▼
┌────────────────┐                       ┌────────────────┐
│  Keep-Alive    │                       │  Chunked       │
│  Heartbeat     │                       │  Transfer      │
│  every 10s     │                       │  to Client     │
└────────────────┘                       └────────────────┘
```

**Key points:**
- No temp file wait (chunks stream immediately)
- Keep-alive prevents gateway timeout
- Chunked transfer allows progressive download
- Client starts receiving data within seconds

## 🐛 Troubleshooting

### "408 Request Timeout"
- **v5.3.0 should fix this** - Streaming eliminates full-file wait
- If still occurs: Video may be too long, try lower quality
- Check if proxies are configured (may help with slow sources)

### "Download timed out"
- Very long videos (>10 min) may still timeout
- Solution: Select 480p or below for long videos
- Enable proxy rotation if available

### "YouTube blocked the request"
- Bot detection triggered
- Wait a few minutes; cookies will auto-refresh
- Add proxies to rotate IP addresses

### Server not responding
- Check COOKIES_URL accessibility
- Verify proxy configuration if using
- Check server logs for errors

## 📝 Changelog

### v5.4.2 (2025-12-20) - Final Merge Fix
- 🎬 **CRITICAL FIX** - Force H.264 (avc1) video codec selection to guarantee video stream
- 🔧 **--remux-video mp4** - Replaced --merge-output-format for proper container remux
- 🧹 **Clean temp files** - Added --force-overwrites and --no-continue
- ✅ **Issue resolved**: MP4 files now contain both video AND audio streams

### v5.4.1 (2025-12-20) - Merge Bug Fix
- 🎬 **Video merge fix** - Added `--prefer-ffmpeg` and `--postprocessor-args` to ensure video stream is included
- 🔧 **Format string improvement** - Better fallback chain for video+audio merge combinations
- 📝 **Minimal change** - Only yt-dlp args modified, no other code changes
- ⚠️ **Partial fix**: Some videos still had audio-only issue (fixed in v5.4.2)

### v5.4.0 (2025-12-XX) - Audio/Video Fix
- 🎵 **Audio download fix** - Use temp file + `--extract-audio` for MP3/M4A
- 📊 **Progress fix** - Force 100% on successful completion
- ✅ **Validation relaxed** - 1KB min for audio, 10KB for video

### v5.3.0 (2025-01-XX) - Streaming Fix
- 🚀 **Pure streaming** - `stdout` to response (no temp file wait)
- 💓 **Keep-alive heartbeats** - 10s interval to prevent gateway timeout
- 🔄 **Proxy rotation** - Support via env/admin panel
- 🍪 **Extended cache** - 120s cookies cache for stability
- 📦 **Chunked transfer** - Immediate data flow to client
- ⬇️ **Single fragment** - Better stability for streaming

### v5.2.0 (2025-01-XX) - Timeout Fix
- Removed FFprobe validation
- Relaxed size validation (50-200% tolerance)
- Extended timeouts (120s)
- Reduced concurrent fragments (2)

### v5.1.0 (2025-01-XX)
- Added FFprobe validation (removed in v5.2.0)
- Added auto-fallback formats
- Added cookies caching

### v5.0.0 (2025-01-XX)
- Auto-fetch cookies from external URL
- Removed manual cookies management
- Real-time cookie sync

## 📄 License

MIT License - See [LICENSE](LICENSE) file

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing`)
5. Open a Pull Request

---

**⭐ Star this repo if it helps you!**
