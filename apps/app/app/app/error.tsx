'use client';

import Link from 'next/link';
import { Icon } from '@/components/app/icons';

/** A screen that failed to render. The header and tabs stay, so every other screen is one click away. */
export default function ScreenError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="pg">
      <div className="panel">
        <div className="empty" role="alert" style={{ padding: '90px 16px' }}>
          <div className="ico">{Icon.alert(18)}</div>
          <h1 className="h1" style={{ color: 'var(--text)' }}>This screen hit a problem.</h1>
          <span className="small" style={{ maxWidth: 460 }}>
            Something in the app failed while showing it. Nothing was sent or signed, and the guard keeps running on Bulwark’s servers with your signed rules.
          </span>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button type="button" className="btn btn-sm btn-ink" onClick={reset}>
              Try again
            </button>
            <Link className="btn btn-sm" href="/app">
              Go to Markets
            </Link>
          </div>
          {error.digest ? <span className="tiny t3 num">Reference {error.digest}</span> : null}
        </div>
      </div>
    </div>
  );
}
