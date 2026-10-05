# @bulwarkxyz/guard-core

An account-level margin guard for [Hyperliquid](https://hyperliquid.xyz), as a pure TypeScript library.

Give it an account's state and a policy the user wrote. It tells you:
- how close each margin pool is to liquidation;
- what the user's own rules say to do about it;
- whether each proposed action is safe to sign.

It never signs or sends anything itself.

Bulwark uses it to protect HIP-3 stock and commodity positions on [trade.xyz](https://trade.xyz). Any front end can use it.

> Status: pre-release (0.x). The API may change before 1.0.

## What it does

- **Margin maths for each account mode.**
  - **Standard** accounts: each dex is its own cross-margin pool.
  - **Unified** accounts: one balance per collateral token backs every dex that uses it.
  - Every isolated position is its own pool.
  - **Portfolio margin** is recognised and reported as not supported.

  Sources:
  - [Account abstraction modes](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes)
  - [Margining](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining)
  - [Margin tiers](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers)
  - [Liquidations](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations)

- **A policy schema** ([zod](https://zod.dev)), with JSON Schema export for structured LLM output.
  - Triggers:
    - pool buffer below a line;
    - drawdown over a fixed time window;
    - price move;
    - leverage cap.
  - Actions:
    - reduce or close a target position;
    - trim back to a buffer;
    - trim back under a leverage cap;
    - top up margin from the user's own idle balances;
    - cancel opening orders;
    - alert.
  - Policies hold **no default numbers**: every threshold is one the user typed.

- **A pure evaluator.** `evaluate(policy, snapshot, marks, context)` returns concrete actions:
  - reduce-only IOC orders at the user's slippage;
  - transfers between the user's own dexes;
  - isolated-margin adds;
  - cancels and alerts.

  Fired rules latch until their condition clears, so one breach does not fire twice.

- **Invariants I1–I7**, checked on every action before signing:

  | | Invariant |
  |---|---|
  | I1 | Every order is reduce-only, IOC, opposes the open position, is no larger than it, and is priced within the user's slippage. |
  | I2 | Nothing raises leverage or changes margin mode. Isolated margin can only be added. The user's own reduce-only orders are never cancelled. |
  | I3 | Funds move only between the user's own balances, only into a pool that needs margin, and never take a source pool below the policy's highest line. |
  | I4 | Act only under a policy whose hash matches the user's verified signature, with the kill switch off and automation allowed in the user's region. |
  | I5 | Every action traces to a confirmed rule. At compile time, a rule drafted from plain language may contain **only numbers the user typed**, and may only *add* protection. |
  | I6 | Rate cap per user; orders meet the exchange's $10 minimum unless closing. |
  | I7 | A builder code is attached only when enabled and within the user's approved maximum; the exchange's builder rejections are recognised so the order can be retried without it. |

## How it is verified

- **Golden tests against mainnet.**
  - `scripts/capture-fixtures.mjs` captured live accounts in every mode using read-only `/info` calls.
  - The library reproduces the API's `crossMaintenanceMarginUsed`, isolated margin and cross account value.
  - It reproduces the official `computeUnifiedAccountRatio` and `tokenToAvailableAfterMaintenance`.
  - It reproduces **every position's `liquidationPx` to within one part in a million**, including tiered assets and positions whose max leverage differs from the asset's current listing.
- **Property tests** ([fast-check](https://fast-check.dev)):
  - Over random accounts, policies and price shocks, the evaluator never proposes an action the invariant gate rejects.
  - Every computed liquidation price takes its pool to a ratio of exactly 1.
  - Any drafted number the user did not type is rejected.
- **Scenario tests** cover each rule shape, top-ups in both modes, the latch, the region switch, and each invariant's rejection path.

```sh
pnpm --filter @bulwarkxyz/guard-core test
FC_RUNS=20000 pnpm --filter @bulwarkxyz/guard-core test   # deeper property run
```

## Use

```ts
import { buildAssetIndex, dexCollateral, buildSnapshot, assessRisk, evaluate, gate } from '@bulwarkxyz/guard-core';

const assets = buildAssetIndex(perpDexs, allPerpMetas);   // from info: perpDexs, allPerpMetas
const snapshot = buildSnapshot({
  abstraction,                                           // info: userAbstraction
  dexStates: { '': mainState, xyz: xyzState },           // info: clearinghouseState per dex
  spot,                                                  // info: spotClearinghouseState
  assets,
  dexCollateral: dexCollateral(perpDexs, allPerpMetas),
});

const risk = assessRisk(snapshot, marks);                 // buffers, ratios, liquidation prices
const decision = evaluate(policy, snapshot, marks, context);
const { approved, rejected } = gate(decision.actions, policy, snapshot, marks, executionContext);
// sign and send `approved`; log `rejected`
```

## Licence

MIT
