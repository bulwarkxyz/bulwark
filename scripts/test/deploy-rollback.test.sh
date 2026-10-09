#!/usr/bin/env bash
# The rollback in scripts/deploy-app.sh either completes (exit 1, the previous deployment serving) or stops loudly
# with the exact state (exit 2, /tmp/bw-deploy-state.json). Runs against stubs for the Vercel CLI and the "which
# deployment is serving" lookup; nothing touches Vercel.
#   bash scripts/test/deploy-rollback.test.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
T=$(mktemp -d)
cat > "$T/serving" <<'S'
#!/usr/bin/env bash
cat "$(dirname "$0")/now.json"
S
# A fake `vercel`: deploy serves the new deployment; rollback/promote serve the previous one only when the
# scenario allows it (ROLLBACK_WORKS / PROMOTE_WORKS).
cat > "$T/vercel" <<'V'
#!/usr/bin/env bash
d=$(dirname "$0")
case "$1" in
  deploy) echo "https://new-deploy.example"; echo '{"id":"dpl_new","url":"https://new-deploy.example"}' > "$d/now.json" ;;
  promote) if [ "$2" = "https://prev.example" ]; then [ "${PROMOTE_WORKS:-0}" = 1 ] && echo '{"id":"dpl_prev","url":"https://prev.example"}' > "$d/now.json"; else echo '{"id":"dpl_new","url":"https://new-deploy.example"}' > "$d/now.json"; fi ;;
  rollback) [ "${ROLLBACK_WORKS:-0}" = 1 ] && echo '{"id":"dpl_prev","url":"https://prev.example"}' > "$d/now.json"; exit "${ROLLBACK_EXIT:-0}" ;;
esac
V
chmod +x "$T/serving" "$T/vercel"
fails=0
run() { # name, expected exit, env...
  local name=$1 want=$2; shift 2
  echo '{"id":"dpl_prev","url":"https://prev.example"}' > "$T/now.json"
  rm -f /tmp/bw-deploy-state.json
  env BW_VERCEL="$T/vercel" BW_SERVING="$T/serving" BW_WAIT_TRIES=2 BW_WAIT_SECS=0 "$@" bash scripts/deploy-app.sh > "$T/out.log" 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then echo "ok   $name (exit $got)"; else echo "FAIL $name: exit $got, wanted $want"; cat "$T/out.log"; fails=$((fails + 1)); fi
}
run "checks pass: deployed" 0 BW_CHECKS=true
run "checks fail, rollback works: back to before" 1 BW_CHECKS=false ROLLBACK_WORKS=1
grep -q "rolled back: dpl_prev is serving" "$T/out.log" || { echo "FAIL: no 'rolled back' line"; fails=$((fails + 1)); }
run "checks fail, rollback does not take, promote works" 1 BW_CHECKS=false ROLLBACK_WORKS=0 PROMOTE_WORKS=1
grep -q "rolled back (by promote)" "$T/out.log" || { echo "FAIL: no promote line"; fails=$((fails + 1)); }
run "checks fail, rollback errors and promote fails: stops loudly" 2 BW_CHECKS=false ROLLBACK_EXIT=1
grep -q "ROLLBACK DID NOT COMPLETE" "$T/out.log" && grep -q "Serving now:          dpl_new" "$T/out.log" || { echo "FAIL: no loud state"; cat "$T/out.log"; fails=$((fails + 1)); }
node -e 'const s=require("/tmp/bw-deploy-state.json"); if(s.result!=="rollback_incomplete"||s.serving.id!=="dpl_new"||s.previous.id!=="dpl_prev") process.exit(1)' || { echo "FAIL: state file"; fails=$((fails + 1)); }
rm -rf "$T"
[ $fails = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
