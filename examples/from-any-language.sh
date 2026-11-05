#!/usr/bin/env bash
# Switchboard speaks plain HTTP, so any language or script can ask you something.
set -euo pipefail
URL="${SWITCHBOARD_URL:-http://127.0.0.1:7777}"
TOKEN="$(cat "${SWITCHBOARD_HOME:-$HOME/.switchboard}/token")"
H=(-H "Authorization: Bearer $TOKEN" -H "content-type: application/json")

# 1. Create the ask (and long-poll up to 25s for a quick answer).
RESP=$(curl -s "${H[@]}" -X POST "$URL/v1/asks?wait=25s" -d '{
  "agent": {"id": "backup-script", "name": "Nightly backup"},
  "question": "Backup is 3x larger than usual. Upload anyway?",
  "options": ["Upload", "Skip tonight"],
  "default": "Skip tonight",
  "deadline": "30m",
  "detail": "Usually ~4 GB, tonight 12.3 GB. Largest new folder: ~/Movies/raw"
}')
ID=$(echo "$RESP" | sed -E 's/.*"id":"(ask_[^"]+)".*/\1/')

# 2. Keep waiting until it's final.
while :; do
  V=$(curl -s "${H[@]}" "$URL/v1/asks/$ID/wait?timeout=25s")
  echo "$V" | grep -q '"final":true' && break
done
echo "$V" | sed -E 's/.*"label":"([^"]*)".*/Answer: \1/'

# Or simply, from any shell:   switchboard ask "Upload anyway?" -o Upload -o Skip --default Skip --deadline 30m
