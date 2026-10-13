#!/usr/bin/env bash
# End-to-end check that a backup carries 附件 (spec 用户故事 5、38):
#
#   scripts/backup-restore-smoke.sh
#
# 1. starts a throwaway compose project (SMOKE_SOURCE, default dida-smoke-src),
#    creates a user, a 任务 and uploads an attachment over HTTP;
# 2. runs scripts/backup.sh on it, restores the file with scripts/restore.sh
#    into a second throwaway project (SMOKE_TARGET, default dida-smoke-dst);
# 3. logs in on the restored copy and downloads the attachment: the bytes
#    must match, and another user must get 404.
# Both projects are removed with `down -v` at the end. Needs `.env` (CI copies
# .env.example) and curl. Never touches the `dida-clone` project.
set -euo pipefail

cd "$(dirname "$0")/.."
src="${SMOKE_SOURCE:-dida-smoke-src}"
dst="${SMOKE_TARGET:-dida-smoke-dst}"
src_port="${SMOKE_SOURCE_PORT:-18291}"
dst_port="${SMOKE_TARGET_PORT:-18292}"
for p in "$src" "$dst"; do
  [ "$p" != "dida-clone" ] || { echo "error: refusing to use the live project name dida-clone" >&2; exit 1; }
done
[ -f .env ] || { echo "error: .env missing (cp .env.example .env)" >&2; exit 1; }

work="$(mktemp -d)"
cleanup() {
  COMPOSE_PROJECT_NAME="$src" docker compose down -v >/dev/null 2>&1 || true
  COMPOSE_PROJECT_NAME="$dst" docker compose down -v >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

user=smoke
password="smoke-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"

# login <port> <username> <password> <cookie jar>
login() {
  curl -fsS -c "$4" -H 'content-type: application/json' \
    -d "{\"username\":\"$2\",\"password\":\"$3\"}" "http://127.0.0.1:$1/api/auth/login" >/dev/null
}

echo "==> starting source project '$src' on 127.0.0.1:$src_port"
COMPOSE_PROJECT_NAME="$src" APP_PORT="$src_port" docker compose up -d --build --wait
printf '%s\n' "$password" | COMPOSE_PROJECT_NAME="$src" docker compose exec -T app dida create-user "$user" >/dev/null
printf '%s\n' "$password" | COMPOSE_PROJECT_NAME="$src" docker compose exec -T app dida create-user other >/dev/null
login "$src_port" "$user" "$password" "$work/src.cookies"

task_id="$(curl -fsS -b "$work/src.cookies" -H 'content-type: application/json' -d '{"title":"备份里的附件"}' \
  "http://127.0.0.1:$src_port/api/tasks" | sed -E 's/.*"id":"([0-9a-f-]{36})".*/\1/')"
head -c 3000000 /dev/urandom >"$work/original.bin"
attachment_id="$(curl -fsS -b "$work/src.cookies" -H 'content-type: application/octet-stream' --data-binary "@$work/original.bin" \
  "http://127.0.0.1:$src_port/api/tasks/$task_id/attachments?name=smoke.bin" | sed -E 's/.*"id":"([0-9a-f-]{36})".*/\1/')"
echo "    uploaded attachment $attachment_id ($(wc -c <"$work/original.bin") bytes) to task $task_id"

echo "==> backup of '$src'"
COMPOSE_PROJECT_NAME="$src" scripts/backup.sh "$work/smoke.tar.gz"
# Lists go to files first: `tar … | grep -q` under pipefail fails with SIGPIPE
# (141) whenever grep stops reading before tar has written its last entry.
tar -tzf "$work/smoke.tar.gz" >"$work/backup.list"
grep -qx attachments.tar "$work/backup.list" || { echo "error: attachments.tar is not in the backup" >&2; exit 1; }
tar -xzOf "$work/smoke.tar.gz" attachments.tar >"$work/attachments.tar"
tar -tf "$work/attachments.tar" >"$work/attachments.list"
grep -q "attachments/.*/$attachment_id\$" "$work/attachments.list" \
  || { echo "error: the attachment file is not in attachments.tar" >&2; exit 1; }

echo "==> restore into '$dst' on 127.0.0.1:$dst_port"
COMPOSE_PROJECT_NAME="$dst" APP_PORT="$dst_port" scripts/restore.sh "$work/smoke.tar.gz" --yes
COMPOSE_PROJECT_NAME="$src" docker compose down -v >/dev/null # the copy must stand on its own

login "$dst_port" "$user" "$password" "$work/dst.cookies"
curl -fsS -b "$work/dst.cookies" -o "$work/restored.bin" "http://127.0.0.1:$dst_port/api/attachments/$attachment_id/content"
cmp "$work/original.bin" "$work/restored.bin"
echo "    restored attachment matches ($(sha256sum <"$work/restored.bin" | cut -c1-16)…)"

login "$dst_port" other "$password" "$work/other.cookies"
status="$(curl -sS -o /dev/null -w '%{http_code}' -b "$work/other.cookies" "http://127.0.0.1:$dst_port/api/attachments/$attachment_id/content")"
[ "$status" = 404 ] || { echo "error: another user got $status instead of 404" >&2; exit 1; }
status="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$dst_port/api/attachments/$attachment_id/content")"
[ "$status" = 401 ] || { echo "error: anonymous download got $status instead of 401" >&2; exit 1; }
echo "==> OK: attachments survive backup and restore; other users get 404, anonymous 401"
