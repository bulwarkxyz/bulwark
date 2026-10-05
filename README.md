# Bulwark

A trading app for HIP-3 stock and commodity perps on Hyperliquid, with a guard that watches the whole account's margin and steps in before liquidation.

**The guard:**
- watches every margin pool the way Hyperliquid computes liquidation, not one position's price;
- acts in stages the user sets: trim, move the user's own idle USDC in, trim harder;
- only ever reduces risk: reduce-only orders, cancels of orders that would add to a position, and moves between the user's own balances, checked by seven invariants before every signature;
- keeps reduce-only stop orders resting on Hyperliquid as a backstop.

**The user's rules:**
- Every number in a rule is one the user typed. Limits can be written in plain words; an AI only translates them, and a draft can only add protection.
- The user signs each policy version; the guard runs only the signed version.

**Keys:** each user's guard key is a non-exportable AWS KMS key (secp256k1, held in KMS's FIPS 140-3 Level 3 HSMs); the signing service can only ask KMS to sign, and a separate provisioning role creates and retires keys. A service compromise could have the key sign trades while it lasted, never withdrawals, and never copy the key. The fallback, behind `KEY_CUSTODY=sealed`, stores keys encrypted (AES-256-GCM) on the signing service.

**Status:** testnet preview, built for the Colosseum Crypto World's Fair, Hyperliquid track. Docs: `/docs` on the Bulwark site (source in [`apps/docs`](apps/docs)).

## Repository

| Path | What |
|---|---|
| [`packages/guard-core`](packages/guard-core) | Open-source guard engine: margin model for each account mode, policy schema, evaluator, invariants I1–I7, backstops, simulator |
| [`packages/signer`](packages/signer) | The AWS KMS signer and provisioner guard, and encrypted-at-rest keys (fallback) |
| [`packages/executor`](packages/executor) | Re-runs the invariants in front of the signer; sends guard actions and user commands |
| [`packages/compiler`](packages/compiler) | Plain-language rule translator behind the number-provenance gate, with its test set |
| [`packages/hyperliquid`](packages/hyperliquid) | Action builders, signing, info and exchange clients |
| [`packages/store`](packages/store) | Postgres schema and store, hash-chained audit log |
| [`packages/config`](packages/config) | Region policy and builder-code settings |
| [`apps/worker`](apps/worker) | The guard: streams, engine, key service, Telegram bot |
| [`apps/api`](apps/api) | Sign-in, region gate, signed policies and commands, translator route |
| [`apps/app`](apps/app) | The trading app |
| [`apps/docs`](apps/docs) | The docs site |
| [`apps/ops`](apps/ops) | Operations scripts, including the crash-day replays |
| [`data/backtests`](data/backtests) | Stored inputs for the crash-day replays |
| [`evidence`](evidence) | Measurements: latency, parity with Hyperliquid's own numbers, replay outputs |

## Develop

```sh
pnpm install
pnpm build       # packages
pnpm test        # all packages (DATABASE_URL enables the Postgres tests)
pnpm typecheck
```

Node 22+, pnpm 9.

## Reproduce the replays

```sh
pnpm --filter @bulwarkxyz/ops find-ordinary-days                               # the rule that picks the ordinary bad days
HYDROMANCER_API_KEY=… pnpm --filter @bulwarkxyz/ops replays                    # crash and ordinary days, settings sweep, server late, resting orders
HYDROMANCER_API_KEY=… pnpm --filter @bulwarkxyz/ops backtest -- --hydromancer  # the first published version (no backstop)
```

The mark-price history comes from [Hydromancer](https://hydromancer.xyz) (courtesy of Hydromancer; fetched with your own key and cached locally, not committed). Margin tiers and market limits come from Hyperliquid directly. Results, method and limits: the docs' replays page ([source](apps/docs/content/docs/backtests.mdx)); latest run: [`evidence/replays-2026-10-05.md`](evidence/replays-2026-10-05.md).

## Licence

MIT
