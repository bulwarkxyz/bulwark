'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { Icon } from './icons';

/**
 * Hyperliquid didn't answer the account read (often a rate limit under load). Said as it is, never shown
 * as "no positions": the account is unknown, not empty. The read retries on its own every few seconds.
 */
export function AccountUnavailable({ view, compact = false }: { view: Pick<UseQueryResult<unknown>, 'error' | 'refetch' | 'isFetching'>; compact?: boolean }) {
  const msg = view.error instanceof Error ? view.error.message : '';
  const limited = /\b429\b|rate.?limit|too many/i.test(msg);
  return (
    <div className="empty" role="status" style={compact ? undefined : { padding: '64px 16px' }}>
      <div className="ico">{Icon.alert(18)}</div>
      <b>Can’t load your account from Hyperliquid right now.</b>
      <span className="small" style={{ maxWidth: 460 }}>
        {limited ? 'Hyperliquid is limiting requests for a moment.' : 'Its data service didn’t answer.'} This only affects what the app can show: your positions and orders on Hyperliquid are unchanged. The app tries again every few seconds.
      </span>
      <button type="button" className="btn btn-sm" disabled={view.isFetching} onClick={() => void view.refetch()}>
        {view.isFetching ? 'Trying…' : 'Try again'}
      </button>
    </div>
  );
}
