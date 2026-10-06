#!/usr/bin/env bash
# Everything a change to the app must pass before it merges to main (the bar agreed on 6 Oct 2026), in one
# run, with each result saved next to the screenshots:
#   typecheck, all tests, contrast, review mode compiled out, public-repo check;
#   a production build: tab-switch budgets (phone and laptop) and every wallet in the connect modal;
#   a local review build: grid gaps at three widths, the bell and wallet-menu checks, and screenshots of
#   the given screens at 1440 and 390 in both themes.
# Stops at the first failure. Uses port 3230.
# Usage: scripts/merge-bar.sh <evidenceDir> [routes, default: every screen]
set -euo pipefail
cd "$(dirname "$0")/.."
out="$1"
routes="${2:-/app,/app/trade/GOLD,/app/positions,/app/rules,/app/simulator,/app/audit,/app/settings,/app/account,/app/onboarding,/app/notifications}"
mkdir -p "$out"
port=3230
base="http://localhost:$port"
watch='0x7c81e5a50a1931a5fbe663a916d31e46f804fd1e'
stop() { lsof -ti:"$port" | xargs kill 2>/dev/null || true; }
serve() {
  stop
  (cd apps/app && npx next start -p "$port" >/dev/null 2>&1 &)
  for _ in $(seq 60); do curl -sf -o /dev/null "$base/app" && return 0; sleep 1; done
  echo "server did not start" && return 1
}
trap stop EXIT

echo "== checks"
pnpm install --frozen-lockfile >/dev/null
pnpm -r --filter "./packages/**" build >/dev/null
pnpm typecheck >/dev/null
echo "typecheck ok"
pnpm test 2>&1 | tee "$out/tests.txt" | grep -E "Tests "
pnpm check:contrast | tail -1
pnpm check:review-mode | tail -1
pnpm check:public | tail -1

echo "== production build"
# A placeholder WalletConnect ID lists the phone wallets; the relay refuses it, which the modal check notes.
(cd apps/app && NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=00000000000000000000000000000000 npx next build >/dev/null)
serve
for p in phone laptop; do node scripts/perf-tabs.mjs "$base" --profile "$p" --budget-frame 500 --budget-data 1000 --json "$out/perf-$p.json" >"$out/perf-$p.txt"; echo "tab speed $p ok"; done
# Each check writes its own file; `|| { …; exit 1; }` because set -e does not stop inside an && chain.
node scripts/wallet-modal-check.mjs "$base" >"$out/wallet-modal.txt" || { cat "$out/wallet-modal.txt"; exit 1; }
tail -1 "$out/wallet-modal.txt"
# Again as a visitor with no wallet at all, as most production visitors are (the 7 Oct rollback).
node scripts/wallet-modal-check.mjs "$base" --no-test-wallet >"$out/wallet-modal-bare.txt" || { cat "$out/wallet-modal-bare.txt"; exit 1; }
tail -1 "$out/wallet-modal-bare.txt"

echo "== review build (local only)"
(cd apps/app && NEXT_PUBLIC_REVIEW_MODE=1 npx next build >/dev/null)
serve
# The bell and wallet-menu checks first: the grid check loads every screen three times, and Hyperliquid
# testnet may then slow the next account reads.
node scripts/nav-check.mjs "$base" >"$out/nav-check.txt" || { grep FAIL "$out/nav-check.txt"; exit 1; }
tail -1 "$out/nav-check.txt"
q="watch=$watch&rules=example"
: >"$out/grid-gaps.txt"
for w in 1440 1100 900; do
  node scripts/grid-gaps.mjs "$base" --query "$q" --width "$w" >>"$out/grid-gaps.txt"
  tail -1 "$out/grid-gaps.txt"
  tail -1 "$out/grid-gaps.txt" | grep -q "^no uneven" || exit 1
done
node scripts/review-shots.mjs "$base" "$out/shots" --routes "$routes" --watch "$watch" --full >/dev/null
echo "screenshots: $(ls "$out/shots" | wc -l | tr -d ' ') in $out/shots"
echo "== bar passed"
