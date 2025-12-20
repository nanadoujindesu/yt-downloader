# 🎬 YouTube Downloader v5.2.0 - Timeout Fix Update

A modern, production-ready web application for downloading YouTube videos using yt-dlp. Features **automatic real-time cookie fetching**, **relaxed validation** (no FFprobe), and **auto-fallback formats** optimized for serverless environments.

**🚀 Designed for Phala Cloud, Vercel, and VPS platforms with ~60s timeout limits**

![Next.js](https://img.shields.io/badge/Next.js-14-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue?style=flat-square&logo=typescript)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.4-38B2AC?style=flat-square&logo=tailwind-css)
![DaisyUI](https://img.shields.io/badge/DaisyUI-4.12-5A0EF8?style=flat-square)
![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

## ✨ What's New in v5.2.0

### 🛠️ Timeout Fix Update (Emergency)
This update addresses issues from v5.1.0: false positive corruption errors, timeouts, and 500/504 server errors.

#### Problems Fixed
- **"Downloaded file appears to be corrupted (too small)"** - False positives on normal files
- **"Download timed out"** - Frequent timeouts especially on Best Quality
- **504 Gateway Timeout** - Server exceeds serverless limits
- **500 Internal Server Error** - Unhandled errors crashing the server

#### Solutions Implemented
| Issue | v5.1.0 Problem | v5.2.0 Fix |
|-------|----------------|------------|
| False corruption | FFprobe too strict | Removed FFprobe, use metadata-based size check (50-200% tolerance) |
| Timeouts | 5min timeout too long | 120s total timeout (optimized for serverless) |
| Slow downloads | 4 concurrent fragments | Reduced to 2 for stability |
| Stale cookies | 30s cache | Extended to 60s cache |
| 500 errors | Unhandled exceptions | Better try/catch, return JSON errors |
| Progress stuck | Long "Connecting..." | 45s connect timeout with retry |

### Key Changes from v5.1.0

```diff
- FFprobe validation (slow, causes false positives)
+ Lightweight metadata-based validation
+ File header signature check only

- Concurrent fragments: 4
+ Concurrent fragments: 2 (stability)

- Cookies cache: 30s
+ Cookies cache: 60s (stability)

- Download timeout: 5 minutes
+ Download timeout: 120s (serverless-optimized)

- Connect timeout: 30s
+ Connect timeout: 45s with early retry
```

### 🍪 Auto-Cookies System (v5.0)
- **Real-time Cookie Sync** - Fetches fresh cookies from external URL
- **60-second Cache** - Extended from 30s for better stability
- **Auto-Refresh** - Force refresh on 403/429 errors
- **Smart Fallback** - Uses consent cookies if fetch fails

## ⚠️ Serverless Deployment Notes

### Phala Cloud / Vercel Limits

Most serverless platforms have timeout limits (~60s). To work within these:

1. **Prefer lower quality formats** - 720p or below for reliable downloads
2. **Best Quality may timeout** - Auto-fallback to 720p → 480p if issues
3. **Large files (>100MB)** - May timeout, try lower quality
4. **Short videos** - Usually work fine at any quality

### Recommended Settings

```yaml
# docker-compose.yml for Phala Cloud
services:
  youtube-downloader:
    image: mpratamamail/youtube-downloader:5.2.0
    environment:
      - COOKIES_URL=https://your-cookies-server.com/cookies.txt
      # Optional tuning:
      - DOWNLOAD_TIMEOUT=110000  # 110s (default)
      - CONNECT_TIMEOUT=45000    # 45s (default)
```

## ✨ Features

### Core Functionality
- 🎬 **Video Downloads** - Various resolutions (4K, 1080p, 720p, etc.)
- 🎵 **Audio Extraction** - MP3, M4A formats
- 📋 **Playlist Support** - Browse and download individual videos
- 🔄 **Server-Side Proxy** - Downloads proxied with auto-cookies
- 📱 **YouTube Shorts** - Full support
- 📏 **File Size Display** - Estimated file size for each format
- ⬇️ **Progress Tracking** - Real-time SSE progress with verify phase

### 🎛️ Admin Panel
- 🔐 **Secure Authentication** - JWT-based login
- 📊 **Dashboard** - Real-time statistics
- 📜 **History Logs** - Track all activity
- ⚙️ **Site Settings** - Customize appearance
- 👤 **Profile Management** - Change password

### 2025 Bot Detection Fixes
- 🍪 **Auto-Fetch Cookies** - Fresh cookies from external URL
- 🎭 **Random User-Agent** - Rotation to avoid detection
- 🔐 **Consent Cookies** - Automatic bypass fallback
- ⏱️ **Request Throttling** - Avoids rate limits
- 🌍 **Geo Bypass** - Works around regional restrictions

### Modern UI/UX
- 🎨 **Beautiful Design** - DaisyUI components
- 🌙 **Dark/Light Mode** - System-aware toggle
- ✨ **Animations** - Framer Motion
- 📱 **Fully Responsive** - Mobile-first
- 🔔 **Toast Notifications** - Real-time feedback

## 🚀 Quick Start

### Docker (Recommended)

```bash
# Pull latest image
docker pull mpratamamail/youtube-downloader:5.2.0

# Run with docker-compose
docker-compose up -d
```

### docker-compose.yml

```yaml
version: '3.8'
services:
  youtube-downloader:
    image: mpratamamail/youtube-downloader:5.2.0
    container_name: youtube-downloader
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - ADMIN_USERNAME=admin
      - ADMIN_PASSWORD=your-secure-password
      - JWT_SECRET=your-jwt-secret-key
      - COOKIES_URL=https://your-cookies-server.com/cookies.txt
    volumes:
      - youtube_data:/data
    restart: unless-stopped

volumes:
  youtube_data:
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
| `DOWNLOAD_TIMEOUT` | `110000` | Max download time (ms) |
| `CONNECT_TIMEOUT` | `45000` | Connection timeout (ms) |

### Cookies URL Format

The external URL must serve Netscape format cookies:

```
# Netscape HTTP Cookie File
.youtube.comTRUE/TRUE0SIDyour-sid-value
.youtube.comTRUE/TRUE0HSIDyour-hsid-value
...
```

## 📊 Validation Flow (v5.2.0)

```
┌─────────────────┐     Download Complete     ┌─────────────────┐
│   yt-dlp        │ ────────────────────────► │   Lightweight   │
│   Download      │                           │   Validation    │
└─────────────────┘                           └────────┬────────┘
                                                       │
                     ┌─────────────────────────────────┼─────────────────────────────────┐
                     │                                 │                                 │
                     ▼                                 ▼                                 ▼
            ┌────────────────┐              ┌────────────────┐              ┌────────────────┐
            │   Size > 1KB   │              │  Size within   │              │   Size way     │
            │   ✅ Pass      │              │  50-200% of    │              │   off (<10%)   │
            └────────────────┘              │  expected      │              │   ❌ Retry     │
                                            │   ✅ Pass      │              └────────────────┘
                                            └────────────────┘                     │
                                                                                   ▼
                                                                          ┌────────────────┐
                                                                          │  Auto-fallback │
                                                                          │  720p → 480p   │
                                                                          └────────────────┘
```

**Key differences from v5.1.0:**
- No FFprobe spawn (was slow and error-prone)
- Very relaxed size tolerance (50-200% vs 80-120%)
- Only fails if file is < 1KB or drastically wrong size
- Accepts unknown formats (avoids false positives)

## 🐛 Troubleshooting

### "Download timed out"
- **Cause**: File too large for serverless timeout
- **Fix**: Try a lower quality (720p or below)

### "YouTube blocked the request"
- **Cause**: Bot detection triggered
- **Fix**: Wait a few minutes, cookies will auto-refresh

### "File appears corrupted"
- **Cause**: v5.2.0 should rarely show this
- **Fix**: If it happens, the file is truly broken. Try different format.

### 504 Gateway Timeout
- **Cause**: Serverless platform timeout exceeded
- **Fix**: Use lower quality, or increase platform timeout if possible

### Server not responding
- **Cause**: Network issues or YouTube blocking
- **Fix**: Check COOKIES_URL is accessible, wait and retry

## 📝 Changelog

### v5.2.0 (2025-01-XX)
- 🛠️ **Removed FFprobe** - Eliminates false positive corruption errors
- ⏱️ **Optimized timeouts** - 120s total, 45s connect (serverless-friendly)
- 🔄 **Reduced concurrency** - 2 fragments for stability
- 🍪 **Extended cache** - 60s cookies cache
- 🛡️ **Better error handling** - No more 500 crashes, returns JSON errors
- ⚡ **Relaxed validation** - 50-200% size tolerance

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
