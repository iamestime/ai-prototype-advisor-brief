#!/usr/bin/env bash
set -euo pipefail

smoke_dir="$(mktemp -d)"
mock_pid=""
app_pid=""

cleanup() {
  if [[ -n "$app_pid" ]]; then kill "$app_pid" 2>/dev/null || true; fi
  if [[ -n "$mock_pid" ]]; then kill "$mock_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

MOCK_GEMINI_PORT=9009 node scripts/mock-gemini.mjs >"$smoke_dir/mock.log" 2>&1 &
mock_pid=$!

GEMINI_API_KEY=test-only \
GEMINI_BASE_URL=http://127.0.0.1:9009 \
AI_MODEL=gemini-test \
VALIDATOR_MODEL=gemini-test \
EMBED_MODEL=gemini-test \
ENABLE_EMBEDDINGS=true \
DEBUG_ERRORS=true \
npm run dev -- --host 127.0.0.1 --port 4173 >"$smoke_dir/app.log" 2>&1 &
app_pid=$!

ready=false
for _ in $(seq 1 45); do
  if curl --silent --fail http://127.0.0.1:4173/ >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  sed -n '1,160p' "$smoke_dir/app.log"
  exit 1
fi

curl --silent --fail --max-time 180 \
  'http://127.0.0.1:4173/api/public/advisor-brief?q=NVDA&fresh=1' \
  >"$smoke_dir/brief.sse"

curl --silent --fail --max-time 180 \
  -H 'content-type: application/json' \
  -d '{"ticker":"NVDA","question":"What does management say about supply?","session":"smoke-test"}' \
  http://127.0.0.1:4173/api/public/advisor-ask \
  >"$smoke_dir/ask.json"

curl --silent --fail --max-time 30 \
  -H 'content-type: application/json' \
  -d '{"ticker":"NVDA","question":"Should I buy this stock?","session":"smoke-test"}' \
  http://127.0.0.1:4173/api/public/advisor-ask \
  >"$smoke_dir/refusal.json"

node scripts/assert-smoke.mjs \
  "$smoke_dir/brief.sse" \
  "$smoke_dir/ask.json" \
  "$smoke_dir/refusal.json"
