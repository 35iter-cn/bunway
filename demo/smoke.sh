#!/usr/bin/env bash
set -euo pipefail

BASE="${1:-http://127.0.0.1:3001}"
ADMIN_TOKEN="${2:-}"
CLIENT_KEY="${3:-}"
MODEL="${4:-}"

if [ -z "$ADMIN_TOKEN" ] || [ -z "$CLIENT_KEY" ]; then
  printf 'usage: bash demo/smoke.sh <base_url> <admin_token> <client_key> [model]\n' >&2
  exit 2
fi

BASE="${BASE%/}"
fail=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf 'ok   %-22s %s\n' "$name" "$actual"
  else
    printf 'FAIL %-22s expected %s, got %s\n' "$name" "$expected" "$actual" >&2
    fail=1
  fi
}

check "health" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")"
check "console" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/console/")"
check "console rejects bad token" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/settings" -H 'Authorization: Bearer definitely-wrong')"
check "admin token" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN")"
check "client key" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/models" -H "Authorization: Bearer $CLIENT_KEY")"

providers="$(curl -s "$BASE/admin/providers" -H "Authorization: Bearer $ADMIN_TOKEN")"
routes="$(curl -s "$BASE/admin/routes" -H "Authorization: Bearer $ADMIN_TOKEN")"
models="$(curl -s "$BASE/v1/models" -H "Authorization: Bearer $CLIENT_KEY")"

printf 'info providers=%s routes=%s models=%s\n' \
  "$(printf '%s' "$providers" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["data"]))' 2>/dev/null || echo '?')" \
  "$(printf '%s' "$routes" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["data"]))' 2>/dev/null || echo '?')" \
  "$(printf '%s' "$models" | python3 -c 'import sys,json;print(",".join(m["id"] for m in json.load(sys.stdin)["data"]))' 2>/dev/null || echo '?')"

if [ -z "$MODEL" ]; then
  MODEL="$(printf '%s' "$models" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d[0]["id"] if d else "")' 2>/dev/null || true)"
fi

if [ -z "$MODEL" ]; then
  printf 'FAIL %-22s no gateway_model configured\n' "chat" >&2
  exit 1
fi

chat="$(curl -s -o /tmp/bunway-smoke-chat.json -w '%{http_code}' "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $CLIENT_KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":4,\"stream\":false}")"
check "chat ($MODEL)" 200 "$chat"

if [ "$chat" = "200" ]; then
  printf 'info usage=%s\n' "$(python3 -c 'import json;u=json.load(open("/tmp/bunway-smoke-chat.json")).get("usage",{});print(u.get("prompt_tokens"),u.get("completion_tokens"))' 2>/dev/null || echo '?')"
fi

if [ "$fail" -ne 0 ]; then
  printf '\nsmoke failed\n' >&2
  exit 1
fi
printf '\nsmoke passed\n'
