#!/bin/bash
# ============================================
# PTO Tracker - Deploy from local to server
# Run this from your Mac
# ============================================
set -e

# === EDIT THESE ===
SERVER_IP="134.209.163.235"
SERVER_USER="root"
APP_DIR="/opt/pto-tracker"
# ==================

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Deploying PTO Tracker to $SERVER_IP..."

# Upload app files (excluding node_modules, data, .env)
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude '.env' \
  --exclude 'uploads' \
  --exclude '.git' \
  --exclude 'deploy' \
  "$PROJECT_DIR/" "$SERVER_USER@$SERVER_IP:$APP_DIR/"

echo "Installing dependencies on server..."
ssh $SERVER_USER@$SERVER_IP "cd $APP_DIR && npm install --production"

echo "Restarting application..."
ssh $SERVER_USER@$SERVER_IP "cd $APP_DIR && pm2 restart pto-tracker || pm2 start ecosystem.config.js"

echo ""
echo "Deploy complete! App should be live at https://cfalarambla.com"
