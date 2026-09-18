#!/bin/sh
set -eu
: "${DATABASE_PATH:=/data/customer-hub.db}"
: "${ATTACHMENTS_DIR:=/data/attachments}"
: "${BACKUP_DIR:=/data/backups}"
export DATABASE_PATH BACKUP_DIR
mkdir -p "$BACKUP_DIR"
node /app/dist-server/server/db/backup-cli.js
stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
tar -C "$ATTACHMENTS_DIR" -czf "$BACKUP_DIR/customer-hub-attachments-$stamp.tar.gz" .
