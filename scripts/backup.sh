#!/usr/bin/env bash
# Back up a dida-clone deployment into ONE file: database dump + attachments.
#
#   scripts/backup.sh [output.tar.gz]
#
# Targets the compose project in this directory (default `dida-clone`;
# override with COMPOSE_PROJECT_NAME). The stack must be running.
# Output defaults to backups/<project>-<UTC timestamp>.tar.gz.
set -euo pipefail

cd "$(dirname "$0")/.."
project="${COMPOSE_PROJECT_NAME:-dida-clone}"
export COMPOSE_PROJECT_NAME="$project"

out="${1:-backups/${project}-$(date -u +%Y%m%dT%H%M%SZ).tar.gz}"
mkdir -p "$(dirname "$out")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ -z "$(docker compose ps -q postgres)" ]; then
  echo "error: postgres of project '$project' is not running (docker compose up -d first)" >&2
  exit 1
fi

echo "==> dumping database of project '$project'"
docker compose exec -T postgres pg_dump -U dida -d dida --format=custom --no-owner >"$work/db.dump"

echo "==> archiving attachments"
docker compose run --rm --no-deps -T --entrypoint tar app -C /data -cf - attachments >"$work/attachments.tar"

cat >"$work/manifest.json" <<EOF
{
  "format": "dida-clone-backup",
  "version": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "project": "$project",
  "gitCommit": "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "files": ["db.dump", "attachments.tar"]
}
EOF

tar -C "$work" -czf "$out" manifest.json db.dump attachments.tar
echo "==> wrote $out ($(du -h "$out" | cut -f1))"
echo "    Keep .env together with this file: APP_ENCRYPTION_KEY is not in the backup."
