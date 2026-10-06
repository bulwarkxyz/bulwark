'use client';

import Link from 'next/link';
import { useState } from 'react';
import { NotificationRow, notificationState } from '@/components/app/notifications';
import { useNotifications } from '@/lib/alerts';
import { RANGE_LABEL, TYPE_LABEL, rangeStart, type DateRange, type NotificationType } from '@/lib/notifications';
import { useReview, useViewer } from '@/lib/review';

const TYPES: Array<NotificationType | 'all'> = ['all', 'liquidation', 'alert', 'choice', 'heldOff'];
const RANGES: DateRange[] = ['today', '7d', '30d', 'all'];

/** Every notification, filtered by type and date; the bell's "See all". */
export default function NotificationsPage() {
  const review = useReview();
  const { connected } = useViewer();
  const [type, setType] = useState<NotificationType | 'all'>('all');
  const [range, setRange] = useState<DateRange>('30d');
  // The range is the request's start, rounded to the minute so the query key stays put between renders.
  const since = rangeStart(range, Math.floor(Date.now() / 60_000) * 60_000);
  const q = useNotifications({ limit: 200, since });
  // The API applies `since`; filtering here too keeps the list right while a new range loads.
  const inRange = q.items.filter((n) => since === null || n.at >= since);
  const list = inRange.filter((n) => type === 'all' || n.type === type);
  const counts = Object.fromEntries(TYPES.map((t) => [t, t === 'all' ? inRange.length : inRange.filter((n) => n.type === t).length]));
  const state = q.ready ? notificationState({ q }) : null;

  return (
    <div className="pg">
      <div className="ptitle">
        <h1 className="h1">Notifications</h1>
        {review.on ? <span className="tag">example alerts</span> : null}
        <span className="sp" />
        <button type="button" className="btn btn-sm" disabled={!q.unread} onClick={() => void q.markAllRead()}>
          Mark all read
        </button>
        <Link className="btn btn-sm btn-ghost" href="/app/settings#alerts">
          Alert settings
        </Link>
      </div>

      {!connected ? (
        <div className="banner">
          <span>Connect a wallet and sign in to see your notifications.</span>
        </div>
      ) : !q.ready ? (
        <div className="banner">
          <span>Sign in (top right) to see your notifications.</span>
        </div>
      ) : (
        <>
          <div className="nfilters">
            <div className="seg" role="radiogroup" aria-label="Type">
              {TYPES.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={type === t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>
                  {t === 'all' ? 'All' : TYPE_LABEL[t]}
                  {q.on && !q.feed.isLoading ? <span className="t3 num" style={{ marginLeft: 6 }}>{counts[t]}</span> : null}
                </button>
              ))}
            </div>
            <div className="seg" role="radiogroup" aria-label="Date">
              {RANGES.map((r) => (
                <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>
                  {RANGE_LABEL[r]}
                </button>
              ))}
            </div>
          </div>
          <section className="panel">
            {state ?? (list.length ? (
              <ul className="nlist">
                {list.map((n) => (
                  <NotificationRow key={n.seq} n={n} read={q.isRead(n)} onOpen={() => q.markRead(n.seq)} full />
                ))}
              </ul>
            ) : (
              <div className="nstate">
                <b className="small">No {type === 'all' ? '' : `${TYPE_LABEL[type as NotificationType].toLowerCase()} `}notifications in {range === 'all' ? 'your history' : RANGE_LABEL[range].toLowerCase() === 'today' ? 'today' : `the last ${RANGE_LABEL[range]}`}</b>
                <button type="button" className="linkbtn small" style={{ alignSelf: 'flex-start' }} onClick={() => (setType('all'), setRange('all'))}>
                  Show everything
                </button>
              </div>
            ))}
          </section>
          {q.items.length >= 200 ? <span className="tiny t3">Showing the latest 200. The audit log has every entry.</span> : null}
        </>
      )}
    </div>
  );
}
