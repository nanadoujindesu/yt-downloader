# ===========================================
# Multi-stage Dockerfile for YouTube Downloader v5.2.0
# ===========================================
#
# 🚀 PHALA CLOUD & VPS DEPLOYMENT READY
#
# v5.2.0 TIMEOUT FIX UPDATE:
# - REMOVED FFprobe dependency (causes false positives)
# - Relaxed validation using metadata-based size check
# - Extended timeouts for serverless (120s total)
# - Reduced concurrent fragments (2) for stability
# - Cookies cache extended to 60s
# - Better error handling to avoid 500/504
#
# v5.0 CHANGES (retained):
# - Auto-fetch cookies from external URL
# - Smart fallback to consent cookies
# - better-sqlite3 native module support
#
# Build: docker build -t yourusername/youtube-downloader:5.2.0 .
# Push:  docker push yourusername/youtube-downloader:5.2.0
# Run:   docker-compose up -d
#
# ===========================================

# Stage 1: Dependencies
FROM node:20-alpine AS deps

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache libc6-compat python3 make g++

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./
COPY scripts ./scripts

# Install all dependencies INCLUDING native modules
# better-sqlite3 needs to be compiled here
RUN npm ci --legacy-peer-deps

# ===========================================
# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Copy dependencies from deps stage (including compiled better-sqlite3)
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time environment variables
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build the application
RUN npm run build

# ===========================================
# Stage 3: Runner (Production)
FROM node:20-alpine AS runner
WORKDIR /app

# Install runtime dependencies for yt-dlp, SQLite, and native modules
# v5.2.0: ffmpeg kept for merging, ffprobe not required for validation
RUN apk add --no-cache \
    curl \
    python3 \
    ffmpeg \
    ca-certificates \
    sqlite \
    # Required for better-sqlite3 runtime
    libstdc++ \
    && rm -rf /var/cache/apk/*

# Environment variables
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Create directories (removed /data/cookies - now auto-fetched)
RUN mkdir -p /app/bin /app/tmp /app/logs /data /data/uploads \
    && chown -R nextjs:nodejs /app /data

# Copy built application
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# CRITICAL: Copy better-sqlite3 native module from deps stage
# This ensures the compiled .node binary is available at runtime
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/bindings ./node_modules/bindings
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

# Also copy drizzle-orm and its dependencies
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm

# Download yt-dlp binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /app/bin/yt-dlp \
    && chmod +x /app/bin/yt-dlp \
    && chown nextjs:nodejs /app/bin/yt-dlp

# Verify yt-dlp
RUN /app/bin/yt-dlp --version

# Switch to non-root user
USER nextjs

EXPOSE 3000
VOLUME ["/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Labels
LABEL org.opencontainers.image.title="YouTube Downloader"
LABEL org.opencontainers.image.description="Production-ready YouTube downloader with timeout fix, auto-cookies, and fallback formats"
LABEL org.opencontainers.image.version="5.2.0"

# Start the application
CMD ["node", "server.js"]
