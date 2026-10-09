#!/usr/bin/env bash
# Deploys the API and worker (Railway) and the app (Vercel) together, for changes where they must move together
# (8 Oct 2026: signatures that name the network; the old app cannot sign for the new API). Both go back together or
# neither:
#   - API or worker fails to start, or the guard is unhealthy  -> API and worker back to --prev; the app is not touched.
#   - the app's checks fail and its rollback completes          -> API and worker back to --prev too.
#   - the app's rollback does not complete (deploy-app.sh exit 2) -> nothing else is rolled back; stops loudly with the
#     state of all three (the app's own state is in /tmp/bw-deploy-state.json).
#
#   scripts/deploy-together.sh --prev <commit now live on Railway>
#
# Run the check bar first, including the Postgres tests (packages/store against Docker). Rollback of a Railway
# service = upload the previous commit again (the CLI cannot redeploy an older deployment).
# BW_RAILWAY, BW_DEPLOY_APP, BW_HEALTH, BW_WORKER_STARTED and BW_WORKER_ERRORS can be replaced by stubs; see
# scripts/test/deploy-together.test.sh.
set -uo pipefail
cd "$(dirname "$0")/.."
PREV=""
[ "${1:-}" = "--prev" ] && PREV="${2:-}"
[ -n "$PREV" ] && git cat-file -e "$PREV^{commit}" 2>/dev/null || { echo "usage: scripts/deploy-together.sh --prev <commit now live on Railway>"; exit 64; }
RAILWAY=${BW_RAILWAY:-railway}
DEPLOY_APP=${BW_DEPLOY_APP:-scripts/deploy-app.sh}
HEALTH=${BW_HEALTH:-curl -s -m 20 https://bulwark.0xo.in/api/bw/health/guard}
WORKER_ERRORS=${BW_WORKER_ERRORS:-worker_errors}
WORKER_STARTED=${BW_WORKER_STARTED:-worker_started}
SETTLE_SECS=${BW_SETTLE_SECS:-30}
HEALTH_TRIES=${BW_HEALTH_TRIES:-36}
WAIT_SECS=${BW_WAIT_SECS:-5}
NEW=$(git rev-parse --short HEAD)
WORKER_ID=""

say() { printf '\n== %s\n' "$*"; }
# Guard runs that failed since the worker started (8 Oct 2026: every run failed on a database constraint).
worker_errors() { railway logs "$WORKER_ID" --deployment -n 5000 --service worker 2>/dev/null | sed -n '/worker started/,$p' | grep -c 'guard run failed'; }
# Uploads $2 (a directory) to service $1 and waits for SUCCESS.
up() {
  local id
  id=$($RAILWAY up "$2" --path-as-root --service "$1" --detach 2>&1 | grep -oE 'id=[0-9a-f-]+' | head -1 | cut -d= -f2)
  [ -n "$id" ] || { echo "  $1: upload failed"; return 1; }
  for _ in $(seq 1 120); do
    case "$($RAILWAY deployment list --service "$1" 2>/dev/null | grep "$id")" in
      *SUCCESS*) echo "  $1: $id SUCCESS"; [ "$1" = worker ] && WORKER_ID=$id; return 0 ;;
      *FAILED*|*CRASHED*|*REMOVED*) echo "  $1: $id did not start"; return 1 ;;
    esac
    sleep "$WAIT_SECS"
  done
  echo "  $1: $id still not running after 10 min"; return 1
}
# The committed tree of $1 (never the working directory), with the commit recorded in .bw-commit.
tree() { local d; d=$(mktemp -d); git archive "$1" | tar -x -C "$d"; git rev-parse --short "$1" > "$d/.bw-commit"; echo "$d"; }
# The new worker has taken the lock and started (until then, the old worker's heartbeat can still look healthy).
worker_started() { railway logs "$WORKER_ID" --deployment -n 5000 --service worker 2>/dev/null | grep -q 'worker started'; }
healthy() {
  local started=0
  for _ in $(seq 1 "$HEALTH_TRIES"); do $WORKER_STARTED && { started=1; break; }; sleep "$WAIT_SECS"; done
  [ $started = 1 ] || { echo "  the new worker did not start within $((HEALTH_TRIES * WAIT_SECS)) s"; return 1; }
  sleep "$SETTLE_SECS" # a few guard rounds on the new code before judging
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if $HEALTH | grep -q '"ok":true'; then
      local n; n=$($WORKER_ERRORS)
      [ "${n:-0}" = 0 ] && { echo "  guard healthy, no failed guard runs"; return 0; }
      echo "  $n guard runs failed since the worker started"; return 1
    fi
    sleep "$WAIT_SECS"
  done
  echo "  /health/guard not ok after $((HEALTH_TRIES * WAIT_SECS)) s"; return 1
}
back() {
  say "Rolling the API and the worker back to $PREV"
  local d; d=$(tree "$PREV")
  local ok=0
  up api "$d" || ok=1
  up worker "$d" || ok=1
  if [ $ok = 0 ] && healthy; then echo "  API and worker are back on $PREV"; return 0; fi
  echo "  API/WORKER ROLLBACK DID NOT COMPLETE: check Railway now (api and worker should run $PREV)"; return 1
}

say "API and worker: $NEW (live now: $PREV)"
D=$(tree HEAD)
if ! up api "$D" || ! up worker "$D" || ! healthy; then
  back; say "STOPPED: the API and worker failed; the app was not deployed"; exit 1
fi

say "App"
$DEPLOY_APP; app=$?
case $app in
  0) say "Deployed together: API, worker and app on $NEW"; exit 0 ;;
  1) back; say "STOPPED: the app's checks failed and it is back on its previous deployment; API and worker rolled back to $PREV (see above)"; exit 1 ;;
  *) cat <<EOT

##################################################################
STOPPED. THE APP'S ROLLBACK DID NOT COMPLETE, SO THE API AND WORKER WERE LEFT ON $NEW
(rolling them back alone would break signing if the new app is serving).
  API and worker: $NEW
  App: see the block above and /tmp/bw-deploy-state.json
Decide by hand, keeping the three together:
  - all back:  promote the app's previous deployment (command above), then roll the API and worker back:
               d=\$(mktemp -d); git archive $PREV | tar -x -C \$d
               railway up \$d --path-as-root --service api --detach; railway up \$d --path-as-root --service worker --detach
  - all new:   if the new app is the one serving, check it (wallet check, every tab) and keep all three.
##################################################################
EOT
     exit 2 ;;
esac
