# Bulwark

A trading app for HIP-3 stock and commodity perps on Hyperliquid, with a guard on every position that defends the account's margin.

**The guard:**
- watches the whole account's cross margin, not one position's price;
- acts in stages the user sets: trim, top up from the user's own idle balance, trim harder;
- only ever reduces risk.

**The user's rules:**
- Limits can be written in plain words. An AI only translates them.
- Every number in a rule is one the user typed.

**Status:** under active development for the Colosseum Crypto World's Fair, Hyperliquid track.

## Repository

| Path | What |
|---|---|
| [`packages/guard-core`](packages/guard-core) | Open-source guard engine: margin maths for each account mode, the policy schema, the evaluator, invariants I1–I7 |
| [`packages/config`](packages/config) | Region policy and builder-code settings |
| [`scripts/capture-fixtures.mjs`](scripts/capture-fixtures.mjs) | Captures golden-test fixtures from mainnet using read-only calls |

## Develop

```sh
pnpm install
pnpm test        # all packages
pnpm typecheck
pnpm build
```

Node 22+, pnpm 9.

## Licence

MIT
