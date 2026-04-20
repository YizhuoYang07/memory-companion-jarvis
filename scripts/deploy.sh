#!/bin/bash
# Deploy to production via rsync + Docker Compose
# Usage: bash scripts/deploy.sh
#
# Prerequisites:
#   - SSH key access to your server
#   - Docker + Docker Compose installed on server (see scripts/bootstrap-digitalocean.sh)
#   - .env file present at REMOTE_DIR on the server
#
# Configure these for your environment:
REMOTE="your-user@your-server-ip"
REMOTE_DIR="/home/your-user/memory-companion"

set -euo pipefail

# Use SSH control socket to avoid multiple password prompts
SOCK="/tmp/deploy-$$"
echo "=== Establishing SSH connection ==="
ssh -M -f -N -o ControlPath="$SOCK" "$REMOTE"
trap "ssh -O exit -o ControlPath='$SOCK' '$REMOTE' 2>/dev/null" EXIT

SSH="ssh -o ControlPath=$SOCK"
RSYNC_SSH="ssh -o ControlPath=$SOCK"

echo ""
echo "=== Step 1: Sync project to production ==="
rsync -avz --delete -e "$RSYNC_SSH" \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'data/*.db' \
  --exclude 'data/*.db-journal' \
  --exclude 'backups/' \
  --exclude '.env' \
  --exclude '.DS_Store' \
  --exclude 'apps/' \
  --exclude 'image/' \
  ./ "$REMOTE:$REMOTE_DIR/"

echo ""
echo "=== Step 2: Rebuild and restart on production ==="
$SSH "$REMOTE" "cd $REMOTE_DIR && docker compose -f compose.prod.yml build && docker compose -f compose.prod.yml up -d"

echo ""
echo "=== Step 3: Check service status ==="
$SSH "$REMOTE" "cd $REMOTE_DIR && docker compose -f compose.prod.yml ps"

echo ""
echo "=== Step 4: Verify health ==="
sleep 3
$SSH "$REMOTE" "cd $REMOTE_DIR && docker compose -f compose.prod.yml logs --tail=20 personal-memory-system"

echo ""
echo "=== Deploy complete ==="
echo "Next: run re-extraction if needed:"
echo "  ssh $REMOTE \"cd $REMOTE_DIR && docker compose -f compose.prod.yml exec personal-memory-system node scripts/re-extract.js --dry-run\""
