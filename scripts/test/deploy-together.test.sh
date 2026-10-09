#!/usr/bin/env bash
# scripts/deploy-together.sh: the API, worker and app go back together or not at all. Runs against stubs for
# Railway, the app deploy and the health check; nothing is deployed.
#   bash scripts/test/deploy-together.test.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
T=$(mktemp -d)
# A fake `railway`: `up` records which tree went to which service; `deployment list` reports the id as SUCCESS
# unless the service is listed in FAIL_UP.
cat > "$T/railway" <<'R'
#!/usr/bin/env bash
d=$(dirname "$0")
case "$1" in
  up) svc=$5; tree=$2; marker=$(cat "$tree/.bw-commit")
      echo "$svc $marker" >> "$d/ups.log"; echo "  Deployment: https://railway.example/x?id=0000-${#svc}" ;;
  deployment) svc=$4; if echo " ${FAIL_UP:-} " | grep -q " $svc "; then echo "0000-${#svc} | FAILED"; else echo "0000-${#svc} | SUCCESS"; fi ;;
esac
R
cat > "$T/app" <<'A'
#!/usr/bin/env bash
exit "${APP_EXIT:-0}"
A
cat > "$T/health" <<'H'
#!/usr/bin/env bash
[ "${HEALTHY:-1}" = 1 ] && echo '{"ok":true}' || echo '{"ok":false}'
H
cat > "$T/errors" <<'E'
#!/usr/bin/env bash
echo "${WORKER_ERRS:-0}"
E
chmod +x "$T"/*
PREV=$(git rev-parse --short HEAD~1)
fails=0
run() { # name, expected exit, expected ups, env...
  local name=$1 want=$2 ups=$3; shift 3
  : > "$T/ups.log"
  env BW_RAILWAY="$T/railway" BW_DEPLOY_APP="$T/app" BW_HEALTH="$T/health" BW_WORKER_ERRORS="$T/errors" BW_WORKER_STARTED=true BW_SETTLE_SECS=0 BW_HEALTH_TRIES=2 BW_WAIT_SECS=0 "$@" \
    bash scripts/deploy-together.sh --prev "$PREV" > "$T/out.log" 2>&1
  local got=$?; local n; n=$(wc -l < "$T/ups.log" | tr -d ' ')
  if [ "$got" = "$want" ] && [ "$n" = "$ups" ]; then echo "ok   $name (exit $got, $n uploads)"; else echo "FAIL $name: exit $got (wanted $want), $n uploads (wanted $ups)"; cat "$T/out.log"; fails=$((fails + 1)); fi
}
run "all good: API, worker, app" 0 2
run "worker does not start: both back, app untouched" 1 4 FAIL_UP=worker
grep -q "the app was not deployed" "$T/out.log" || { echo "FAIL: app should not deploy"; fails=$((fails + 1)); }
run "guard runs failing after start (the 8 Oct case): both back" 1 4 WORKER_ERRS=6
run "the new worker never starts: both back" 1 4 BW_WORKER_STARTED=false
run "app checks fail, app rolled back: API and worker back too" 1 4 APP_EXIT=1
[ "$(tail -2 "$T/ups.log" | awk '{print $2}' | sort -u)" = "$PREV" ] || { echo "FAIL: the rollback did not upload $PREV"; cat "$T/ups.log"; fails=$((fails + 1)); }
grep -q "API and worker rolled back" "$T/out.log" || { echo "FAIL: no both-back line"; fails=$((fails + 1)); }
run "app rollback incomplete: nothing else rolled back, loud stop" 2 2 APP_EXIT=2
grep -q "LEFT ON" "$T/out.log" || { echo "FAIL: no loud stop"; fails=$((fails + 1)); }
: > "$T/ups.log"; BW_RAILWAY="$T/railway" bash scripts/deploy-together.sh > "$T/out.log" 2>&1; got=$?
if [ "$got" = 64 ] && [ ! -s "$T/ups.log" ]; then echo "ok   no --prev: refuses (exit 64, 0 uploads)"; else echo "FAIL no --prev: exit $got"; fails=$((fails + 1)); fi
rm -rf "$T"
[ $fails = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
