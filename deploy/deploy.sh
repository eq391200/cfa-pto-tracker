#!/bin/bash
# ============================================
# Restaurant Admin Hub - Deploy from local to server
# Run this from your Mac
# ============================================
set -e

# === EDIT THESE ===
SERVER_IP="134.209.163.235"
SERVER_USER="root"
APP_DIR="/opt/pto-tracker"
# ==================

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Deploying Restaurant Admin Hub to $SERVER_IP..."

# Upload app files (excluding node_modules, data, .env)
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude '.env' \
  --exclude 'uploads' \
  --exclude '.git' \
  --exclude 'deploy' \
  --exclude 'scripts/.venv' \
  --exclude 'scripts/__pycache__' \
  "$PROJECT_DIR/" "$SERVER_USER@$SERVER_IP:$APP_DIR/"

echo "Installing dependencies on server..."
ssh $SERVER_USER@$SERVER_IP "cd $APP_DIR && npm install --production"

echo "Setting up Python environment..."
ssh $SERVER_USER@$SERVER_IP "cd $APP_DIR && python3 -m venv scripts/.venv 2>/dev/null; scripts/.venv/bin/pip install -r scripts/requirements.txt -q"

echo "Restarting application..."
ssh $SERVER_USER@$SERVER_IP "cd $APP_DIR && pm2 restart admin-hub --update-env 2>/dev/null || pm2 start ecosystem.config.js && pm2 save"

echo ""
echo "Deploy complete! App should be live at https://cfalarambla.com"
