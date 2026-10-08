#!/usr/bin/env bash
# Production deploy of the app (bulwark-web). It is reported done only when the new deployment is the one Vercel
# serves, the live site answers quickly on every tab, and the wallet window opens for a visitor with no wallet.
# Otherwise it rolls back to the deployment that was serving before.
#
#   scripts/deploy-app.sh [--site https://bulwark.0xo.in]
#
# Why each step:
# - Promote: after an instant rollback, Vercel keeps serving the rolled-back-to deployment and does not assign new
#   production deploys to the domains until one is promoted (6 Oct 2026: a "deploy" that never went live).
# - Warm-up: a request can hang for about a minute (6 Oct: one /app request hung 66 s), and a page that never
#   hydrates makes "Connect wallet" do nothing.
# Run the check bar first (scripts/merge-bar.sh); this script deploys, checks and, if needed, rolls back.
set -uo pipefail
SITE="https://bulwark.0xo.in"
[ "${1:-}" = "--site" ] && SITE="$2"
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*"; }
serving() { node scripts/vercel-prod.mjs | node -e 'process.stdin.on("data",d=>process.stdout.write(JSON.parse(d)[process.argv[1]]))' "$1"; }
fail() {
  say "FAILED: $*"
  if [ -n "${PREV_URL:-}" ] && [ "$(serving id)" != "$PREV_ID" ]; then
    say "Rolling back to the deployment that was serving before"
    # The switch can take a while to show (8 Oct 2026: checked at once, it reported a failed rollback); wait up to 2 min.
    vercel rollback "$PREV_URL" --yes > /tmp/bw-rollback.log 2>&1 || { echo "ROLLBACK FAILED (see /tmp/bw-rollback.log): roll back by hand now"; exit 1; }
    for i in $(seq 1 30); do [ "$(serving id)" = "$PREV_ID" ] && { echo "rolled back"; exit 1; }; sleep 4; done
    echo "ROLLBACK NOT SERVING after 2 min (see /tmp/bw-rollback.log): roll back by hand now"
  fi
  exit 1
}

PREV_ID=$(serving id); PREV_URL=$(serving url)
[ -n "$PREV_ID" ] && [ -n "$PREV_URL" ] || { echo "Could not read the serving deployment; not deploying."; exit 1; }

say "Deploying to production"
NEW_URL=$(vercel deploy --prod --yes 2>/tmp/bw-deploy.log | grep -m1 -oE 'https://[a-z0-9.-]+')
[ -n "$NEW_URL" ] || fail "vercel deploy (see /tmp/bw-deploy.log)"
vercel promote "$NEW_URL" --yes >/tmp/bw-promote.log 2>&1 || true
for i in $(seq 1 30); do [ "$(serving id)" != "$PREV_ID" ] && break; sleep 4; done
[ "$(serving id)" != "$PREV_ID" ] || fail "the new deployment is not the one being served (see /tmp/bw-promote.log)"
echo "  serving the new deployment"

say "Warming up: 5 answers in a row under 2 s on each tab"
TABS="/app /app/trade/GOLD /app/positions /app/rules /app/simulator /app/audit /app/settings /app/notifications"
deadline=$(( $(date +%s) + 300 ))
for tab in $TABS; do
  streak=0
  while [ $streak -lt 5 ]; do
    [ "$(date +%s)" -lt $deadline ] || fail "the site did not answer quickly within 5 minutes ($tab)"
    out=$(curl -s -o /dev/null -m 20 -w '%{http_code} %{time_total}' "$SITE$tab?warm=$RANDOM")
    code=${out% *}; secs=${out#* }
    if [ "$code" = "200" ] && awk "BEGIN{exit !($secs < 2)}"; then streak=$((streak + 1)); else streak=0; echo "  $tab: $code in ${secs}s, retrying"; fi
  done
  echo "  $tab ok"
done

say "Warming up in a real browser: every tab fully loaded once (its scripts and assets)"
node scripts/browser-warm.mjs "$SITE" || fail "a tab did not load in a real browser within 2 minutes"

say "Wallet window, a visitor with no wallet (twice)"
for run in 1 2; do
  node scripts/wallet-modal-check.mjs "$SITE" --no-test-wallet >/tmp/bw-modal-$run.log 2>&1 || fail "wallet-modal-check run $run (see /tmp/bw-modal-$run.log)"
  echo "  run $run passed"
done

say "Deployed and checked: $SITE"
