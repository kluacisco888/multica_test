#!/usr/bin/env bash
# 迁移演练 (EURO-31, docs/acceptance-manual.md): backup → move → restore → deploy,
# exactly as README「迁移到新服务器」describes, on throwaway copies.
#
#   scripts/migration-drill.sh
#
# 1. Records the state of Multica (compose project `multica`) and the system
#    nginx, so the end can prove they were not touched.
# 2. "Old server": `git archive HEAD` into a new temp dir, `cp .env.example .env`
#    (own port, random secrets), `docker compose up -d --build`, then fills one
#    account with every kind of data over HTTP (清单, 文件夹, 标签, 任务, 子任务,
#    检查项, 附件, 评论, 过滤器, 通知渠道, 倒数日, 习惯, 打卡, 专注记录, 设置, 回收站).
# 3. Stops `app`, takes a fingerprint (row count + checksum of every table,
#    sha256 of every attachment file), runs scripts/backup.sh.
# 4. "New server": another fresh `git archive`, gets only the backup file and
#    the old `.env`, `docker compose build`, scripts/restore.sh (answering its
#    confirmation prompt), fingerprints again and diffs: must be identical.
# 5. Checks the restored deployment over HTTP (health, logins, downloads with
#    byte compare, 404/401 isolation, channel credentials still decrypt),
#    redeploys it with `docker compose up -d --build`, checks again.
# 6. `down -v` both projects, removes the drill image tag and the temp dir,
#    checks nothing of the drill is left and Multica / nginx are unchanged.
#
# Env: DRILL_OLD / DRILL_NEW (project names, default dida-drill-old / -new),
# DRILL_PORT (default 18391), DRILL_KEEP=1 (leave everything for inspection).
# Never uses the project names dida-clone or multica, never uses the repo's .env.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
old="${DRILL_OLD:-dida-drill-old}"
new="${DRILL_NEW:-dida-drill-new}"
port="${DRILL_PORT:-18391}"
image_prefix="dida-clone-app:drill"

for p in "$old" "$new"; do
  [[ "$p" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "error: bad project name '$p'" >&2; exit 1; }
  case "$p" in dida-clone | multica) echo "error: refusing project name '$p'" >&2; exit 1 ;; esac
  [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$p")$(docker volume ls -q --filter "label=com.docker.compose.project=$p")" ] \
    || { echo "error: compose project '$p' already exists; remove it first" >&2; exit 1; }
done
if ss -Hltn "sport = :$port" | grep -q .; then
  echo "error: port $port is in use; pick another with DRILL_PORT" >&2
  exit 1
fi

work="$(mktemp -d -t dida-drill.XXXXXX)"
step() { printf '\n==> %s\n' "$*"; }
# build_log <n>: last n lines of compose output without BuildKit's step lines.
build_log() { { grep -vE '^ *(#|=>)|^\s*$' || true; } | tail -n "$1" | sed 's/^/    /'; }

# State of what the drill must not touch: Multica's containers (id, start time,
# restarts), nginx's main PID and start time, and who listens on 80/3000/8080.
untouched_state() {
  local ids
  ids="$(docker ps -aq --filter label=com.docker.compose.project=multica)"
  # shellcheck disable=SC2086 # one argument per container id
  [ -z "$ids" ] || docker inspect --format '{{.Name}} {{.Id}} {{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}}' $ids | sort
  systemctl show nginx -p ActiveState -p MainPID -p ActiveEnterTimestamp 2>/dev/null | sort || echo "nginx: no systemd"
  ss -Hltn '( sport = :80 or sport = :3000 or sport = :8080 )' | awk '{print "listen " $4}' | sort
}

# compose_in <dir> <project> <compose args…>
compose_in() {
  local dir="$1" project="$2"
  shift 2
  (cd "$dir" && COMPOSE_PROJECT_NAME="$project" docker compose "$@")
}

cleanup() {
  local status=$?
  if [ "${DRILL_KEEP:-}" = 1 ]; then
    echo "DRILL_KEEP=1: left $work and projects $old / $new."
    echo "  open: ssh -L $port:127.0.0.1:$port <server>, then http://127.0.0.1:$port"
    echo "  login: ${user:-drill} / ${password:-?}   admin / ${admin_password:-?}"
    echo "Clean up with:"
    echo "  (cd $work/old && COMPOSE_PROJECT_NAME=$old docker compose down -v)"
    echo "  (cd $work/new && COMPOSE_PROJECT_NAME=$new docker compose down -v)"
    echo "  docker image rm $image_prefix-$old $image_prefix-$new; rm -rf $work"
    exit "$status"
  fi
  step "cleanup"
  [ -d "$work/old" ] && compose_in "$work/old" "$old" down -v --remove-orphans 2>&1 | sed 's/^/    /' || true
  [ -d "$work/new" ] && compose_in "$work/new" "$new" down -v --remove-orphans 2>&1 | sed 's/^/    /' || true
  docker image rm "$image_prefix-$old" "$image_prefix-$new" >/dev/null 2>&1 || true
  rm -rf "$work"
  local left=""
  for p in "$old" "$new"; do
    left+="$(docker ps -aq --filter "label=com.docker.compose.project=$p")"
    left+="$(docker volume ls -q --filter "label=com.docker.compose.project=$p")"
    left+="$(docker network ls -q --filter "label=com.docker.compose.project=$p")"
  done
  left+="$(docker image ls -q "$image_prefix-$old")$(docker image ls -q "$image_prefix-$new")"
  if [ -n "$left" ] || [ -e "$work" ]; then
    echo "error: drill leftovers: $left $work" >&2
    status=1
  else
    echo "    no container, volume, network, image or temp dir of the drill is left"
  fi
  exit "$status"
}
trap cleanup EXIT

step "state of Multica and nginx before the drill"
untouched_state | tee "$work/untouched.before" | sed 's/^/    /'

# server_copy <dir> <project>: the repo at HEAD, as a fresh server would
# `git clone` it, with an override so building does not retag
# dida-clone-app:local (other deployments on this machine run that tag).
server_copy() {
  mkdir -p "$1"
  git -C "$repo" archive HEAD | tar -x -C "$1"
  printf 'services:\n  app:\n    image: %s-%s\n' "$image_prefix" "$2" >"$1/docker-compose.override.yml"
}

# set_env <file> <KEY> <value>: like editing .env by hand (uncomments the key).
set_env() {
  if grep -qE "^#? ?$2=" "$1"; then
    sed -i -E "s|^#? ?$2=.*|$2=$3|" "$1"
  else
    printf '%s=%s\n' "$2" "$3" >>"$1"
  fi
}

random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
uuid() { cat /proc/sys/kernel/random/uuid; }

# fingerprint <dir> <project>: one line per table — `schema.table|rows|md5`
# (md5 over the sorted md5s of the rows' text form), then `file|sha256` for every
# attachment file. holiday_years leaves out fetched_at: the app re-fetches
# 节假日数据 on every start and stamps that column even when nothing changed.
fingerprint() {
  compose_in "$1" "$2" exec -T postgres psql -U dida -d dida -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT format(
  'SELECT %L, count(*), coalesce(md5(string_agg(h, %L ORDER BY h)), %L) FROM (SELECT md5(x::text) AS h FROM %s x) s',
  table_schema || '.' || table_name, ',', '-',
  CASE WHEN (table_schema, table_name) = ('public', 'holiday_years')
       THEN '(SELECT year, data, changed_at FROM public.holiday_years)'
       ELSE format('%I.%I', table_schema, table_name) END)
FROM information_schema.tables
WHERE table_schema IN ('public', 'drizzle') AND table_type = 'BASE TABLE'
ORDER BY table_schema, table_name
\gexec
SQL
  compose_in "$1" "$2" run --rm --no-deps -T --entrypoint sh app \
    -c 'cd /data && find attachments -type f | sort | while read -r f; do printf "%s|%s\n" "$f" "$(sha256sum "$f" | cut -d" " -f1)"; done'
}

# ---- old server ------------------------------------------------------------
step "old server: fresh copy in $work/old, project '$old', 127.0.0.1:$port"
server_copy "$work/old" "$old"
cp "$work/old/.env.example" "$work/old/.env"
admin_password="drill-admin-$(random_hex 6)"
set_env "$work/old/.env" APP_PORT "$port"
set_env "$work/old/.env" PUBLIC_URL "http://127.0.0.1:$port"
set_env "$work/old/.env" POSTGRES_PASSWORD "$(random_hex 12)"
set_env "$work/old/.env" APP_ENCRYPTION_KEY "$(openssl rand -base64 32)"
set_env "$work/old/.env" INITIAL_ADMIN_PASSWORD "$admin_password"
chmod 600 "$work/old/.env"
compose_in "$work/old" "$old" up -d --build --wait 2>&1 | build_log 8
echo "    GET /api/health → $(curl -fsS "http://127.0.0.1:$port/api/health")"

base="http://127.0.0.1:$port"
user=drill
other=drill-other
password="drill-$(random_hex 6)"
for u in "$user" "$other"; do
  printf '%s\n' "$password" | compose_in "$work/old" "$old" exec -T app dida create-user "$u" >/dev/null
done

# login <username> <password> <cookie jar>
login() {
  curl -fsS -c "$3" -H 'content-type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" "$base/api/auth/login" >/dev/null
}
# api <METHOD> <path> [json]: as the drill user; fails on any non-2xx.
api() {
  if [ $# -ge 3 ]; then
    curl -fsS -o /dev/null -X "$1" -b "$work/user.cookies" -H 'content-type: application/json' -d "$3" "$base$2"
  else
    curl -fsS -o /dev/null -X "$1" -b "$work/user.cookies" "$base$2"
  fi
}
login "$user" "$password" "$work/user.cookies"

step "old server: filling account '$user' with every kind of data"
folder=$(uuid) list=$(uuid) list2=$(uuid) column=$(uuid) tag=$(uuid) child_tag=$(uuid) channel=$(uuid)
task1=$(uuid) task2=$(uuid) sub=$(uuid) check_task=$(uuid) trashed=$(uuid) habit=$(uuid)
api POST /api/folders "{\"id\":\"$folder\",\"name\":\"工作\"}"
api POST /api/lists "{\"id\":\"$list\",\"name\":\"项目A\",\"color\":\"#4772fa\",\"folderId\":\"$folder\"}"
api POST /api/lists "{\"id\":\"$list2\",\"name\":\"购物\",\"excludeFromSmartLists\":true}"
api POST /api/kanban-columns "{\"id\":\"$column\",\"listId\":\"$list\",\"name\":\"进行中\"}"
api POST /api/tags "{\"id\":\"$tag\",\"name\":\"重要\",\"color\":\"#e03131\"}"
api POST /api/tags "{\"id\":\"$child_tag\",\"name\":\"客户\",\"parentId\":\"$tag\"}"
api POST /api/notification-channels "{\"id\":\"$channel\",\"type\":\"feishu\",\"isDefault\":true,\"config\":{\"webhookUrl\":\"http://127.0.0.1:59999/open-apis/bot/v2/hook/drill-$(random_hex 4)\",\"secret\":\"drill-secret\"}}"
api POST /api/tasks "{\"id\":\"$task1\",\"listId\":\"$list\",\"title\":\"写迁移手册\",\"description\":\"**Markdown** 描述\",\"priority\":\"high\",\"tagIds\":[\"$tag\",\"$child_tag\"],\"columnId\":\"$column\",\"dates\":{\"allDay\":false,\"startAt\":null,\"dueAt\":\"2030-05-06T02:00:00.000Z\"},\"reminders\":[{\"type\":\"before\",\"minutes\":30}]}"
api POST /api/tasks "{\"id\":\"$task2\",\"title\":\"每天背单词\",\"dates\":{\"allDay\":true,\"startDate\":null,\"dueDate\":\"2030-01-01\"},\"repeat\":{\"freq\":\"daily\"}}"
api POST /api/tasks "{\"id\":\"$sub\",\"parentId\":\"$task1\",\"title\":\"子任务：核对行数\"}"
api POST /api/tasks "{\"id\":\"$check_task\",\"listId\":\"$list2\",\"title\":\"买菜\"}"
api PATCH "/api/tasks/$check_task" '{"kind":"checklist"}'
api POST "/api/tasks/$check_task/checklist-items" '{"title":"鸡蛋","completed":true}'
api POST "/api/tasks/$check_task/checklist-items" '{"title":"牛奶"}'
api PATCH "/api/tasks/$sub" '{"status":"completed"}'
api POST "/api/tasks/$task1/comments" '{"content":"迁移前写的评论"}'
api POST /api/tasks "{\"id\":\"$trashed\",\"title\":\"进回收站的任务\"}"
api DELETE "/api/tasks/$trashed"
api POST /api/filters "{\"name\":\"高优先级\",\"rules\":{\"priorities\":[\"high\"]}}"
api POST /api/countdowns '{"name":"新年","date":"2031-01-01"}'
api POST /api/countdowns '{"name":"农历生日","date":"2026-03-15","calendar":"lunar","repeat":"yearly"}'
api POST /api/habits "{\"id\":\"$habit\",\"name\":\"喝水\",\"goal\":{\"type\":\"count\",\"target\":8,\"unit\":\"杯\"}}"
api PUT "/api/habits/$habit/checkins/$(date -u +%F)" '{"count":3}'
api POST /api/focus/start "{\"mode\":\"stopwatch\",\"taskId\":\"$task1\"}"
api POST /api/focus/current/finish
api PATCH /api/settings '{"timeZone":"Asia/Shanghai","pomodoro":{"focusMinutes":30}}'
# 附件: a 3 MB binary and a small PNG, kept here to compare the downloads later.
head -c 3000000 /dev/urandom >"$work/a.bin"
printf '\x89PNG\r\n\x1a\n%s' "$(random_hex 64)" >"$work/b.png"
attach1=$(uuid) attach2=$(uuid)
curl -fsS -o /dev/null -b "$work/user.cookies" -H 'content-type: application/octet-stream' --data-binary "@$work/a.bin" \
  "$base/api/tasks/$task1/attachments?name=data.bin&id=$attach1"
curl -fsS -o /dev/null -b "$work/user.cookies" -H 'content-type: image/png' --data-binary "@$work/b.png" \
  "$base/api/tasks/$task1/attachments?name=%E6%88%AA%E5%9B%BE.png&id=$attach2"
echo "    done: 2 users, 1 folder, 2 lists (+收件箱), 1 kanban column, 2 tags, 5 tasks (1 in 回收站), 2 checklist items,"
echo "          1 comment, 2 attachments, 1 filter, 1 channel, 2 countdowns, 1 habit + checkin, 1 focus record, settings"

step "old server: stop app, fingerprint, scripts/backup.sh"
compose_in "$work/old" "$old" stop app 2>&1 | sed 's/^/    /'
fingerprint "$work/old" "$old" >"$work/old.fingerprint"
COMPOSE_PROJECT_NAME="$old" "$work/old/scripts/backup.sh" "$work/transfer/backup.tar.gz" 2>&1 | sed 's/^/    /'
tar -tzvf "$work/transfer/backup.tar.gz" | sed 's/^/    /'
cp "$work/old/.env" "$work/transfer/.env"
# The old server goes away before the new one starts (same .env → same port).
compose_in "$work/old" "$old" stop 2>&1 | sed 's/^/    /'

# ---- new server ------------------------------------------------------------
step "new server: fresh copy in $work/new, project '$new'; gets only backup.tar.gz and .env"
server_copy "$work/new" "$new"
cp "$work/transfer/.env" "$work/new/.env"
cp "$work/transfer/backup.tar.gz" "$work/new/backup.tar.gz"
compose_in "$work/new" "$new" build 2>&1 | build_log 3
# Answer restore.sh's prompt the way a person would: type the project name.
printf '%s\n' "$new" | COMPOSE_PROJECT_NAME="$new" "$work/new/scripts/restore.sh" "$work/new/backup.tar.gz" 2>&1 | sed 's/^/    /'

step "new server: fingerprint and compare (tables | rows | md5, then attachment | sha256)"
fingerprint "$work/new" "$new" >"$work/new.fingerprint"
# Side by side: name | rows before | rows after | checksum before | checksum after | same?
awk -F'|' '
  NR == FNR { before[$1] = $0; next }
  { split(before[$1], b, "|"); n = split($0, a, "|")
    same = (before[$1] == $0) ? "✓" : "✗"
    if (n == 3) printf "    %-34s rows %3s → %3s  %s → %s  %s\n", $1, b[2], a[2], substr(b[3], 1, 12), substr(a[3], 1, 12), same
    else { k = split($1, path, "/"); printf "    附件 %-36s sha256 %s → %s  %s\n", path[k], substr(b[2], 1, 12), substr(a[2], 1, 12), same } }
' "$work/old.fingerprint" "$work/new.fingerprint"
if diff -u "$work/old.fingerprint" "$work/new.fingerprint" >"$work/fingerprint.diff"; then
  echo "    identical: $(grep -c '^[a-z]*\.' "$work/old.fingerprint") tables, $(grep -c '^attachments/' "$work/old.fingerprint") attachment files"
else
  sed 's/^/    /' "$work/fingerprint.diff"
  echo "error: restored data differs from the backup source" >&2
  exit 1
fi

# check_deployment <label>: the restored copy works for real users.
check_deployment() {
  echo "    [$1] GET /api/health → $(curl -fsS "$base/api/health")"
  rm -f "$work/user.cookies"
  login "$user" "$password" "$work/user.cookies"
  login admin "$admin_password" "$work/admin.cookies"
  # Bodies go to variables first: `curl … | grep -q` under pipefail can fail with SIGPIPE.
  local body
  body="$(curl -fsS -b "$work/user.cookies" "$base/api/tasks/$task1")"
  grep -q '"title":"写迁移手册"' <<<"$body" || { echo "error: task not readable: $body" >&2; exit 1; }
  body="$(curl -fsS -b "$work/user.cookies" "$base/api/trash")"
  grep -q "\"id\":\"$trashed\"" <<<"$body" || { echo "error: 回收站 lost the task: $body" >&2; exit 1; }
  curl -fsS -b "$work/user.cookies" -o "$work/a.restored" "$base/api/attachments/$attach1/content"
  curl -fsS -b "$work/user.cookies" -o "$work/b.restored" "$base/api/attachments/$attach2/content"
  cmp "$work/a.bin" "$work/a.restored"
  cmp "$work/b.png" "$work/b.restored"
  echo "    [$1] logins (user + admin) OK, task/trash readable, 2 attachments byte-identical"
  login "$other" "$password" "$work/other.cookies"
  local s
  s="$(curl -sS -o /dev/null -w '%{http_code}' -b "$work/other.cookies" "$base/api/attachments/$attach1/content")"
  [ "$s" = 404 ] || { echo "error: other user got $s for the attachment" >&2; exit 1; }
  s="$(curl -sS -o /dev/null -w '%{http_code}' -b "$work/other.cookies" "$base/api/tasks/$task1")"
  [ "$s" = 404 ] || { echo "error: other user got $s for the task" >&2; exit 1; }
  s="$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/tasks/$task1")"
  [ "$s" = 401 ] || { echo "error: anonymous got $s for the task" >&2; exit 1; }
  echo "    [$1] other user → 404, anonymous → 401"
  # The webhook points at a closed port, so the send fails — with a network
  # error, not 「无法解密渠道凭证」: the moved APP_ENCRYPTION_KEY still opens it.
  body="$(curl -sS -X POST -b "$work/user.cookies" "$base/api/notification-channels/$channel/test")"
  if grep -q '无法解密' <<<"$body" || ! grep -q 'channel_send_failed' <<<"$body"; then
    echo "error: channel credentials after restore: $body" >&2
    exit 1
  fi
  echo "    [$1] channel credentials decrypt (test send: $(sed -E 's/.*"message":"([^"]*)".*/\1/' <<<"$body"))"
}

step "new server: check the restored deployment"
check_deployment restored

step "new server: redeploy (upgrade path: docker compose up -d --build)"
compose_in "$work/new" "$new" up -d --build --wait 2>&1 | build_log 4
check_deployment redeployed

step "old server: decommission (down -v)"
compose_in "$work/old" "$old" down -v 2>&1 | sed 's/^/    /'

step "state of Multica and nginx after the drill"
untouched_state >"$work/untouched.after"
if diff -u "$work/untouched.before" "$work/untouched.after"; then
  echo "    unchanged (same container ids, start times, restart counts, nginx PID, listeners)"
else
  echo "error: Multica / nginx state changed during the drill" >&2
  exit 1
fi
step "OK: backup → restore → redeploy kept every row and attachment"
