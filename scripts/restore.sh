#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into a compose project.
#
#   scripts/restore.sh <backup.tar.gz> [--yes]
#
# REPLACES the database and attachments of the target project (default
# `dida-clone`; override with COMPOSE_PROJECT_NAME, port with APP_PORT).
# Needs the original `.env` in this directory (same APP_ENCRYPTION_KEY).
#
# Example — restore next to the live deployment for a check:
#   COMPOSE_PROJECT_NAME=dida-restore APP_PORT=8091 scripts/restore.sh backups/x.tar.gz --yes
set -euo pipefail

usage() { echo "usage: $0 <backup.tar.gz> [--yes]" >&2; exit 2; }
[ $# -ge 1 ] || usage
backup="$1"
confirm="${2:-}"
[ -f "$backup" ] || { echo "error: $backup not found" >&2; exit 1; }
backup="$(cd "$(dirname "$backup")" && pwd)/$(basename "$backup")"

cd "$(dirname "$0")/.."
project="${COMPOSE_PROJECT_NAME:-dida-clone}"
export COMPOSE_PROJECT_NAME="$project"
[ -f .env ] || { echo "error: .env missing — copy the .env of the original server here first" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tar -C "$work" -xzf "$backup"
grep -q '"format": "dida-clone-backup"' "$work/manifest.json" 2>/dev/null \
  || { echo "error: $backup is not a dida-clone backup" >&2; exit 1; }
for f in db.dump attachments.tar; do
  [ -s "$work/$f" ] || { echo "error: backup is missing $f" >&2; exit 1; }
done

if [ "$confirm" != "--yes" ]; then
  echo "This replaces ALL data of compose project '$project' with $(basename "$backup")."
  read -r -p "Type the project name to continue: " answer
  [ "$answer" = "$project" ] || { echo "aborted"; exit 1; }
fi

echo "==> starting postgres of project '$project'"
docker compose up -d --wait postgres
docker compose stop app >/dev/null 2>&1 || true

echo "==> restoring database"
docker compose exec -T postgres psql -U dida -d dida -v ON_ERROR_STOP=1 -q \
  -c 'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker compose exec -T postgres pg_restore -U dida -d dida --no-owner --exit-on-error <"$work/db.dump"

echo "==> restoring attachments"
docker compose run --rm --no-deps -T --entrypoint sh app \
  -c 'rm -rf /data/attachments && tar -C /data -xf -' <"$work/attachments.tar"

echo "==> starting app"
docker compose up -d --wait app
echo "==> restored $(basename "$backup") into project '$project'"
