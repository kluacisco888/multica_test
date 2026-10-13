#!/usr/bin/env bash
# Refresh the 节假日数据 built into the image (packages/server/holidays/<year>.json)
# from NateScarlet/holiday-cn, for the given years (default: last year … next year).
# Years whose file is missing or lists no days yet are skipped. Commit the result.
set -euo pipefail

base="${HOLIDAY_DATA_URL:-https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master}"
dir="$(cd "$(dirname "$0")/.." && pwd)/packages/server/holidays"
this_year="$(TZ=Asia/Shanghai date +%Y)"
years=("$@")
[ ${#years[@]} -gt 0 ] || years=("$((this_year - 1))" "$this_year" "$((this_year + 1))")

for year in "${years[@]}"; do
  [[ "$year" =~ ^[0-9]{4}$ ]] || { echo "not a year: $year" >&2; exit 1; }
  tmp="$(mktemp)"
  status="$(curl -sS -o "$tmp" -w '%{http_code}' "$base/$year.json")"
  if [ "$status" != 200 ]; then
    echo "$year: HTTP $status, skipped"
  elif ! node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(d.year===Number(process.argv[2]) && d.days.length>0 ? 0 : 1)' "$tmp" "$year"; then
    echo "$year: not announced yet (no days), skipped"
  else
    mv "$tmp" "$dir/$year.json"
    echo "$year: updated"
    continue
  fi
  rm -f "$tmp"
done
