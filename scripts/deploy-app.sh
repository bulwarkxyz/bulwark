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
#
# Exit codes (scripts/deploy-together.sh relies on them):
#   0  deployed and checked; the new deployment is serving.
#   1  a check failed and the rollback COMPLETED: the deployment that was serving before is serving again.
#   2  a check failed and the rollback did NOT complete: the script stops and prints the exact state (which deployment
#      is serving, the previous and the new one, and the commands to finish by hand); also written to
#      /tmp/bw-deploy-state.json. Nothing else is changed. (8 Oct 2026: a rollback was reported as failed while the new
#      deployment kept serving.)
# BW_VERCEL (default `vercel`) and BW_SERVING (default `node scripts/vercel-prod.mjs`) can be replaced by stubs; see
# scripts/test/deploy-rollback.test.sh.
set -uo pipefail
SITE="https://bulwark.0xo.in"
[ "${1:-}" = "--site" ] && SITE="$2"
cd "$(dirname "$0")/.."
VERCEL=${BW_VERCEL:-vercel}
SERVING=${BW_SERVING:-node scripts/vercel-prod.mjs}
WAIT_TRIES=${BW_WAIT_TRIES:-30}
WAIT_SECS=${BW_WAIT_SECS:-4}
NEW_URL=""

say() { printf '\n== %s\n' "$*"; }
serving() { $SERVING 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d)[process.argv[1]]??"")}catch{}})' "$1"; }
# Waits until the serving deployment is $1 (up to WAIT_TRIES x WAIT_SECS); returns 0 when it is.
wait_serving() { for _ in $(seq 1 "$WAIT_TRIES"); do [ "$(serving id)" = "$1" ] && return 0; sleep "$WAIT_SECS"; done; return 1; }
state() {
  local now; now=$(serving id); local nowurl; nowurl=$(serving url)
  printf '{"result":"%s","serving":{"id":"%s","url":"%s"},"previous":{"id":"%s","url":"%s"},"new":{"url":"%s"},"why":"%s"}\n' \
    "$1" "$now" "$nowurl" "$PREV_ID" "$PREV_URL" "$NEW_URL" "$2" > /tmp/bw-deploy-state.json
  cat <<EOT

##################################################################
ROLLBACK DID NOT COMPLETE. NOTHING MORE WILL BE DONE AUTOMATICALLY.
  Serving now:          ${now:-UNKNOWN (could not read it)} ${nowurl}
  Serving before:       $PREV_ID $PREV_URL
  The new deployment:   ${NEW_URL:-none}
  Why the deploy failed: $2
Finish by hand, one of:
  - back to before:   vercel promote $PREV_URL --yes   (then check: node scripts/vercel-prod.mjs)
  - keep the new one: check it (node scripts/wallet-modal-check.mjs $SITE --no-test-wallet, every tab)
If the API was deployed with this app, keep the two together (scripts/deploy-together.sh).
State written to /tmp/bw-deploy-state.json
##################################################################
EOT
}
fail() {
  say "FAILED: $*"
  if [ -z "${PREV_ID:-}" ] || [ "$(serving id)" = "$PREV_ID" ]; then echo "  the deployment that was serving before is still serving; nothing to roll back"; exit 1; fi
  say "Rolling back to the deployment that was serving before ($PREV_ID)"
  # Attempt 1: an instant rollback. Attempt 2: promote the previous deployment. Each waits up to 2 minutes for the
  # switch to show (8 Oct 2026: checked at once, it reported a failed rollback).
  $VERCEL rollback "$PREV_URL" --yes > /tmp/bw-rollback.log 2>&1
  if wait_serving "$PREV_ID"; then echo "  rolled back: $PREV_ID is serving"; exit 1; fi
  echo "  the rollback did not take within 2 minutes; promoting $PREV_URL"
  $VERCEL promote "$PREV_URL" --yes >> /tmp/bw-rollback.log 2>&1
  if wait_serving "$PREV_ID"; then echo "  rolled back (by promote): $PREV_ID is serving"; exit 1; fi
  state "rollback_incomplete" "$*"
  exit 2
}

PREV_ID=$(serving id); PREV_URL=$(serving url)
[ -n "$PREV_ID" ] && [ -n "$PREV_URL" ] || { echo "Could not read the serving deployment; not deploying."; exit 1; }

say "Deploying to production"
NEW_URL=$($VERCEL deploy --prod --yes 2>/tmp/bw-deploy.log | grep -m1 -oE 'https://[a-z0-9.-]+')
[ -n "$NEW_URL" ] || fail "vercel deploy (see /tmp/bw-deploy.log)"
$VERCEL promote "$NEW_URL" --yes >/tmp/bw-promote.log 2>&1 || true
for _ in $(seq 1 "$WAIT_TRIES"); do [ "$(serving id)" != "$PREV_ID" ] && break; sleep "$WAIT_SECS"; done
[ "$(serving id)" != "$PREV_ID" ] || fail "the new deployment is not the one being served (see /tmp/bw-promote.log)"
echo "  serving the new deployment"
# Tests only (scripts/test/deploy-rollback.test.sh): replace the live checks with a command.
if [ -n "${BW_CHECKS:-}" ]; then $BW_CHECKS || fail "checks (test stub)"; say "Deployed and checked (test stub)"; exit 0; fi

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
