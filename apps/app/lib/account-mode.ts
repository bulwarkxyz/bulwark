import type { AccountMode } from '@bulwarkxyz/guard-core';

/** The two modes the app can switch between, and Hyperliquid's name for each (userSetAbstraction). */
export type Switchable = 'standard' | 'unified';
export const ABSTRACTION: Record<Switchable, 'disabled' | 'unifiedAccount'> = { standard: 'disabled', unified: 'unifiedAccount' };
export const MODE_NAME: Record<AccountMode, string> = { standard: 'Standard account', unified: 'Unified account', portfolio: 'Portfolio margin', unsupported: 'Dex abstraction (discontinued)' };

/** One line on what each mode is, as guard-core models it (packages/guard-core/src/snapshot.ts). */
export const MODE_LINE: Record<AccountMode, string> = {
  standard: 'Each venue on Hyperliquid (its own markets, trade.xyz, …) is a separate cross-margin pool with its own balance.',
  unified: 'One balance per collateral token backs your cross positions on every venue that uses it.',
  portfolio: 'Hyperliquid’s portfolio margin. The guard shows this account read only and does not act on it.',
  unsupported: 'A mode Hyperliquid has discontinued. The guard does not act on it.',
};

export interface ModeChange {
  margin: string[];
  guard: string[];
}

/** What switching changes, for the user's margin and for the guard, said before they sign. */
export function modeChange(from: AccountMode, to: Switchable): ModeChange {
  const guardActsNow = from === 'standard' || from === 'unified';
  const margin =
    to === 'unified'
      ? [
          'One USDC balance backs your cross positions on every venue that settles in USDC, including trade.xyz’s markets. Today each venue has its own balance.',
          'A loss on one market can draw on margin that would otherwise sit with another venue, and a gain on one supports the rest.',
          'Isolated positions keep their own margin, as now.',
        ]
      : [
          'Each venue (Hyperliquid’s own markets, trade.xyz, …) becomes its own cross-margin pool, backed only by the balance on that venue.',
          'A loss on one venue can no longer draw on margin held for another, so each needs enough margin of its own.',
          'Isolated positions keep their own margin, as now.',
        ];
  const guard = [
    to === 'unified'
      ? 'The guard measures your buffer on the shared USDC pool instead of one pool per venue. Your lines (like 2.5×) stay the same numbers; they are checked against the shared pool.'
      : 'The guard measures your buffer per venue instead of on one shared pool. Your lines (like 2.5×) stay the same numbers; each venue is checked on its own.',
    guardActsNow ? 'You have no open positions, so the guard has nothing resting now. It prices its backstops for the new pools from your next trade.' : `Today the guard does not act on a ${MODE_NAME[from].toLowerCase()} account. After the switch it watches and acts on your rules.`,
  ];
  return { margin, guard };
}
