import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '@/components/app/icons';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="pg">
      <div className="panel">
        <div className="empty" style={{ padding: '90px 16px' }}>
          <div className="ico">{Icon.search(18)}</div>
          <h1 className="h1" style={{ color: 'var(--text)' }}>This page isn’t here.</h1>
          <span className="small" style={{ maxWidth: 440 }}>
            The address may be mistyped, or the page has moved. Your positions, orders and guard are not affected by anything on this page.
          </span>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link className="btn btn-sm btn-ink" href="/app">
              Go to Markets
            </Link>
            <Link className="btn btn-sm" href="/app/positions">
              Your positions
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
