# Crash-day replays: mark prices

Run 2026-10-05T10:23Z. 

- **account:** A cross long on the xyz dex, opened at the first price of each window, with 10,000 USDC of equity and nothing else in the account
- **leverages:** 3×, 5×, 10×, 20×
- **stageSettings:** Example settings chosen for the test (not product defaults): Stage 1: buffer below 2× → trim until the buffer is back at 3×; Stage 2: buffer below 1.5× → trim until the buffer is back at 2.5×; Stage 3: buffer below 1.2× → close the position
- **noGuard:** The same account, same prices, no guard
- **fees:** 4.5 bps per fill, assumed
- **slippage:** Guard orders fill at the worst price a 1% slippage limit allows
- **congestion:** Guard orders reach the exchange 0, 1, 5 minutes after the decision; a late IOC fills only if the price is still within its limit
- **retry:** An order that did not fill, or filled partly, is retried once its result is known (one delay later) while its stage still holds, re-priced from the mark at that time within the same slippage; at most 20 guard actions a minute (I6). "Before the fix" runs the same path without retries
- **margin:** Current xyz maintenance tiers (historical tiers may have differed)
- **notModelled:** Funding, order-book depth and queue position, partial fills, Hyperliquid outages, other traders reacting

## Silver, 30 January 2026

xyz:SILVER, 2026-01-29T00:00:00Z → 2026-02-01T00:00:00Z, deployer-submitted mark inputs (not the accepted mark), 85,513 rounds, one about every 3.0 s, from Hydromancer oraclePriceHistoryByTime. Entry 117.78, lowest 73.954 (-37.21%). Largest fall within an hour: -17.74% (2026-01-30T17:26Z → 18:22Z).

| Leverage | No guard | Guard, no delay | Guard, 1 min late | Guard, 5 min late | Guard orders (no delay) | Fees (no delay) |
|---|---|---|---|---|---|---|
| 3× | liquidated | 2% kept | 2% kept | liquidated | 5 | 8.58 USDC |
| 5× | liquidated | 0% kept | liquidated (2 missed) | liquidated | 13 | 18 USDC |
| 10× | liquidated | 0% kept | liquidated (1 missed) | liquidated | 16 | 40.52 USDC |
| 20× | liquidated | 0% kept | liquidated (1 missed) | liquidated | 18 | 85.54 USDC |

Late orders, before and after the retry fix:

| Leverage | Delay | Before the fix | With retries | Retry orders | "Cannot fill" alert |
|---|---|---|---|---|---|
| 3× | 1 min | 2% kept | 2% kept | 0 | — |
| 3× | 5 min | liquidated | liquidated | 0 | — |
| 5× | 1 min | liquidated (2 missed) | liquidated (2 missed) | 0 | — |
| 5× | 5 min | liquidated | liquidated | 0 | — |
| 10× | 1 min | liquidated (1 missed) | liquidated (1 missed) | 0 | — |
| 10× | 5 min | liquidated | liquidated | 0 | — |
| 20× | 1 min | liquidated (1 missed) | liquidated (1 missed) | 0 | — |
| 20× | 5 min | liquidated | liquidated | 0 | — |

## Oil, 23 March 2026

xyz:CL, 2026-03-22T00:00:00Z → 2026-03-25T00:00:00Z, accepted mark prices, 85,311 rounds, one about every 3.0 s, from Hydromancer perpPriceHistoryByTime. Entry 97.864, lowest 84.058 (-14.11%). Largest fall within an hour: -15.4% (2026-03-23T10:28Z → 11:09Z).

Deployer-submitted mark input vs accepted mark on this window (85,311 rounds matched): median 0.047%, 99th percentile 0.509%, largest 1.378%.

| Leverage | No guard | Guard, no delay | Guard, 1 min late | Guard, 5 min late | Guard orders (no delay) | Fees (no delay) |
|---|---|---|---|---|---|---|
| 3× | 72.2% kept | 72.2% kept | 72.2% kept | 72.2% kept | 0 | 0 USDC |
| 5× | 53.7% kept | 53.7% kept | 53.7% kept | 53.7% kept | 0 | 0 USDC |
| 10× | liquidated | 11.3% kept | liquidated | liquidated | 4 | 36.7 USDC |
| 20× | liquidated | 8.4% kept | liquidated (1 missed) | liquidated | 6 | 82.72 USDC |

Late orders, before and after the retry fix:

| Leverage | Delay | Before the fix | With retries | Retry orders | "Cannot fill" alert |
|---|---|---|---|---|---|
| 3× | 1 min | 72.2% kept | 72.2% kept | 0 | — |
| 3× | 5 min | 72.2% kept | 72.2% kept | 0 | — |
| 5× | 1 min | 53.7% kept | 53.7% kept | 0 | — |
| 5× | 5 min | 53.7% kept | 53.7% kept | 0 | — |
| 10× | 1 min | liquidated | liquidated | 0 | — |
| 10× | 5 min | liquidated | liquidated | 0 | — |
| 20× | 1 min | liquidated (1 missed) | liquidated (1 missed) | 0 | — |
| 20× | 5 min | liquidated | liquidated | 0 | — |

## SK hynix, 27 July 2026

xyz:SKHX, 2026-07-26T00:00:00Z → 2026-07-29T00:00:00Z, accepted mark prices, 86,386 rounds, one about every 3.0 s, from Hydromancer perpPriceHistoryByTime. Entry 1222.5, lowest 917.25 (-24.97%). Largest fall within an hour: -19.38% (2026-07-27T22:01Z → 23:01Z).

Deployer-submitted mark input vs accepted mark on this window (86,386 rounds matched): median 0.173%, 99th percentile 2.223%, largest 15.073%.

| Leverage | No guard | Guard, no delay | Guard, 1 min late | Guard, 5 min late | Guard orders (no delay) | Fees (no delay) |
|---|---|---|---|---|---|---|
| 3× | 62.1% kept | 62.1% kept | 62.1% kept | 62.1% kept | 0 | 0 USDC |
| 5× | liquidated | 24.8% kept | liquidated | liquidated | 3 | 14.38 USDC |
| 10× | liquidated | 19.6% kept | liquidated | liquidated (1 missed) | 5 | 37.64 USDC |

Late orders, before and after the retry fix:

| Leverage | Delay | Before the fix | With retries | Retry orders | "Cannot fill" alert |
|---|---|---|---|---|---|
| 3× | 1 min | 62.1% kept | 62.1% kept | 0 | — |
| 3× | 5 min | 62.1% kept | 62.1% kept | 0 | — |
| 5× | 1 min | liquidated | liquidated | 0 | — |
| 5× | 5 min | liquidated | liquidated | 0 | — |
| 10× | 1 min | liquidated | liquidated | 0 | — |
| 10× | 5 min | liquidated (1 missed) | liquidated (1 missed) | 1 | — |

