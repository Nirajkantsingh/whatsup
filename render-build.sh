#!/usr/bin/env bash
set -e

echo "Installing dependencies..."
npm install

echo "Installing Chromium..."
apt-get update && apt-get install -y chromium || true

# Also install via Puppeteer as fallback
export PUPPETEER_CACHE_DIR=/opt/render/project/src/.cache/puppeteer
npx puppeteer browsers install chrome || true

echo "Checking Chrome locations..."
which chromium || true
which chromium-browser || true
which google-chrome || true
find /opt/render/project/src/.cache -name "chrome" -type f 2>/dev/null || true

echo "Build complete!"
