# Crash-day replays: hourly trade prices (coarse)

Run 2026-10-05T09:45Z. **Trade prices, not mark prices, at hourly (January: 4-hour) resolution. Liquidation and the guard run on mark price.**

- **account:** A cross long on the xyz dex, opened at the first price of each window, with 10,000 USDC of equity and nothing else in the account
- **leverages:** 3×, 5×, 10×, 20×
- **stageSettings:** Example settings chosen for the test (not product defaults): Stage 1: buffer below 2× → trim until the buffer is back at 3×; Stage 2: buffer below 1.5× → trim until the buffer is back at 2.5×; Stage 3: buffer below 1.2× → close the position
- **noGuard:** The same account, same prices, no guard
- **fees:** 4.5 bps per fill, assumed
- **slippage:** Guard orders fill at the worst price a 1% slippage limit allows
- **congestion:** Guard orders reach the exchange 0, 1, 5 minutes after the decision; a late IOC fills only if the price is still within its limit
- **margin:** Current xyz maintenance tiers (historical tiers may have differed)
- **notModelled:** Funding, order-book depth and queue position, partial fills, Hyperliquid outages, other traders reacting

## Silver −35% in a day

xyz:SILVER, 2026-01-29T00:00:00Z → 2026-02-01T00:00:00Z, 4h trade candles (open → low → high → close, 12 looks per segment). Entry 117.85, lowest 76.23 (-35.32%).

| Leverage | No guard | Guard, no delay | Guard, 1 min late | Guard, 5 min late | Guard orders | Fees (no delay) |
|---|---|---|---|---|---|---|
| 3× | liquidated | liquidated | liquidated (1 missed) | liquidated (1 missed) | 1 | 3.87 USDC |
| 5× | liquidated | 0.5% kept | liquidated (2 missed) | liquidated (2 missed) | 4 | 18.03 USDC |
| 10× | liquidated | 0.1% kept | liquidated (2 missed) | liquidated (2 missed) | 8 | 40.52 USDC |
| 20× | liquidated | 0% kept | liquidated (2 missed) | liquidated (2 missed) | 11 | 85.54 USDC |

## Oil −16.5% in one hour

xyz:CL, 2026-03-22T00:00:00Z → 2026-03-25T00:00:00Z, 1h trade candles (open → low → high → close, 12 looks per segment). Entry 98.197, lowest 82.5 (-15.99%).

| Leverage | No guard | Guard, no delay | Guard, 1 min late | Guard, 5 min late | Guard orders | Fees (no delay) |
|---|---|---|---|---|---|---|
| 3× | 68.1% kept | 68.1% kept | 68.1% kept | 68.1% kept | 0 | 0 USDC |
| 5× | 46.8% kept | 33.8% kept | 33.8% kept | 33.8% kept | 1 | 7.83 USDC |
| 10× | liquidated | 7.5% kept | liquidated (1 missed) | liquidated | 4 | 37.93 USDC |
| 20× | liquidated | 5.6% kept | liquidated (2 missed) | liquidated | 6 | 83.6 USDC |

## SK hynix bad-print wick

xyz:SKHX, 2026-07-26T00:00:00Z → 2026-07-29T00:00:00Z, 1h trade candles (open → low → high → close, 12 looks per segment). Entry 1222.5, lowest 927 (-24.17%). **Inconclusive:** The wick was a bad print in trades. Liquidations and the guard follow the mark price, which may not have moved; only mark-price data can show whether either would have triggered.

| Leverage | No guard | Guard, no delay | Guard, 1 min late | Guard, 5 min late | Guard orders | Fees (no delay) |
|---|---|---|---|---|---|---|
| 3× | 60.6% kept | 60.6% kept | 60.6% kept | 60.6% kept | 0 | 0 USDC |
| 5× | liquidated | 21.1% kept | liquidated (2 missed) | liquidated | 3 | 15.06 USDC |
| 10× | liquidated | 16.8% kept | liquidated (2 missed) | liquidated (1 missed) | 5 | 38.19 USDC |

