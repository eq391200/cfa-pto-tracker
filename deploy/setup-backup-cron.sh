#!/bin/bash
# Setup automated daily backup cron job
# Run on server: bash deploy/setup-backup-cron.sh

APP_DIR="/opt/pto-tracker"
NODE_PATH=$(which node)
LOG_FILE="/var/log/admin-hub-backup.log"

CRON_LINE="0 2 * * * cd $APP_DIR && $NODE_PATH server/backup.js >> $LOG_FILE 2>&1"

# Check if cron already exists
if crontab -l 2>/dev/null | grep -q "server/backup.js"; then
  echo "Backup cron already configured:"
  crontab -l | grep "backup.js"
  echo ""
  echo "To remove: crontab -e (and delete the line)"
else
  # Add to existing crontab
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  echo "✓ Backup cron installed: Daily at 2:00 AM"
  echo "  Logs: $LOG_FILE"
  echo ""
  echo "Verify with: crontab -l"
fi

# Also setup weekly digest cron if not present
DIGEST_CRON="0 9 * * 1 cd $APP_DIR && $NODE_PATH server/weekly-digest.js >> /var/log/admin-hub-digest.log 2>&1"
if ! crontab -l 2>/dev/null | grep -q "weekly-digest.js"; then
  (crontab -l 2>/dev/null; echo "$DIGEST_CRON") | crontab -
  echo "✓ Weekly digest cron installed: Monday at 9:00 AM"
fi

# Anniversary check (1st of every month at 8 AM)
ANNIV_CRON="0 8 1 * * cd $APP_DIR && $NODE_PATH server/anniversary-check.js >> /var/log/admin-hub-anniversary.log 2>&1"
if ! crontab -l 2>/dev/null | grep -q "anniversary-check.js"; then
  (crontab -l 2>/dev/null; echo "$ANNIV_CRON") | crontab -
  echo "✓ Anniversary check cron installed: 1st of every month at 8:00 AM"
fi

echo ""
echo "Current crontab:"
crontab -l
