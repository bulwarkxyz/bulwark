'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { useNotifications } from '@/lib/alerts';
import { TYPE_CHIP, TYPE_LABEL, badge, type Notification } from '@/lib/notifications';
import { useTimes } from '@/lib/time';
import { Icon } from './icons';
import { Popover } from './popover';

/** "4 min ago" within a day, then the date and time in the chosen zone. */
export function useWhen() {
  const times = useTimes();
  return (t: number, now = Date.now()) => {
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
    return times.fmt(t, 'short');
  };
}

/** One notification: unread mark, type, time, what happened, why; the row opens what it is about. */
export function NotificationRow({ n, read, onOpen, full = false }: { n: Notification; read: boolean; onOpen: () => void; full?: boolean }) {
  const when = useWhen();
  const times = useTimes();
  return (
    <li className={`nrow ${read ? '' : 'unread'}`}>
      <Link href={n.href} className="nmain" onClick={onOpen}>
        <span className="ndot" aria-hidden="true" />
        <span className="col" style={{ gap: 3, minWidth: 0 }}>
          <span className="row" style={{ gap: 6, rowGap: 4 }}>
            <span className={`chip chip-sm ${TYPE_CHIP[n.type]}`}>{TYPE_LABEL[n.type]}</span>
            {/* Relative in the panel, the exact time on the full page (as Binance's notification page does). */}
            <span className="tiny t3 num" style={{ whiteSpace: 'nowrap' }} title={full ? when(n.at) : `${times.fmt(n.at, 'minute')} ${times.label}`}>
              {full ? `${times.fmt(n.at, 'minute')} ${times.label}` : when(n.at)}
            </span>
            {n.example ? <span className="tag">example</span> : null}
            {read ? null : <span className="sr-only">unread</span>}
          </span>
          <span className={`small ${full ? '' : 'clamp2'}`}>{n.title}</span>
          <span className={`tiny t2 ${full ? '' : 'clamp1'}`}>{n.detail}</span>
          <span className="tiny t3">{n.hrefLabel} →</span>
        </span>
      </Link>
      {n.href !== n.auditHref ? (
        <Link href={n.auditHref} className="naudit tiny t3" onClick={onOpen}>
          Audit entry
        </Link>
      ) : null}
    </li>
  );
}

/** States shared by the panel and the page: off, loading, error, empty. Null when there is a list. Called as a
 * function (it uses no hooks), so callers can tell "nothing to say" from a rendered state. */
export function notificationState({ q, compact = false }: { q: ReturnType<typeof useNotifications>; compact?: boolean }) {
  if (!q.on)
    return (
      <div className="nstate">
        <b className="small">Alerts are off in the app</b>
        <span className="small t2">Telegram still gets every alert while it’s linked.</span>
        <Link className="small" href="/app/settings#alerts" style={{ textDecoration: 'underline' }}>
          Alert settings
        </Link>
      </div>
    );
  if (q.feed.isLoading)
    return (
      <ul className="nlist" aria-busy="true" aria-label="Loading alerts">
        {[0, 1, 2].map((i) => (
          <li key={i} className="nrow">
            <span className="col" style={{ gap: 8, padding: '12px 14px', width: '100%' }}>
              <span className="sk" style={{ width: '40%' }} />
              <span className="sk" style={{ width: '90%' }} />
            </span>
          </li>
        ))}
      </ul>
    );
  if (q.feed.isError)
    return (
      <div className="nstate">
        <b className="small ct">Can’t load your alerts</b>
        <span className="small t2">{(q.feed.error as Error).message}. Telegram still gets them while it’s linked.</span>
        <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => void q.feed.refetch()}>
          Try again
        </button>
      </div>
    );
  if (!q.items.length)
    return (
      <div className="nstate">
        <span className="ico">{Icon.bell(18)}</span>
        <b className="small">No alerts {compact ? 'yet' : 'here'}</b>
        <span className="small t2">The guard posts here when one of your alert lines is crossed, when it can’t act, when it holds off on stale data, and if Hyperliquid liquidates a position.</span>
      </div>
    );
  return null;
}

/** The bell in the top bar and the panel it opens. Shown once the user is signed in. */
export function NotificationBell() {
  const q = useNotifications();
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!q.ready) return null;
  const shown = q.items.slice(0, 20);
  const state = notificationState({ q, compact: true });
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="btn btn-sm btn-ghost bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={q.unread ? `Notifications, ${q.unread} unread` : 'Notifications'}
        onClick={() => setOpen((o) => !o)}
      >
        {Icon.bell(16)}
        {q.unread ? <span className="badge num">{badge(q.unread)}</span> : null}
      </button>
      <Popover anchor={btn} open={open} onClose={close} label="Notifications" width={400} maxHeight={600}>
        <div className="nhead row nw">
          <b>Notifications</b>
          {q.unread ? <span className="tiny t2">{q.unread} unread</span> : null}
          <span className="sp" />
          <button type="button" className="linkbtn small" disabled={!q.unread} onClick={() => void q.markAllRead()}>
            Mark all read
          </button>
        </div>
        <div className="nbody">
          {state ?? (
            <ul className="nlist">
              {shown.map((n) => (
                <NotificationRow
                  key={n.seq}
                  n={n}
                  read={q.isRead(n)}
                  onOpen={() => {
                    q.markRead(n.seq);
                    close();
                  }}
                />
              ))}
            </ul>
          )}
        </div>
        <div className="nfoot row nw">
          <Link href="/app/notifications" className="small b" onClick={close}>
            See all
          </Link>
          <span className="sp" />
          <Link href="/app/settings#alerts" className="small t2" onClick={close}>
            Alert settings
          </Link>
        </div>
      </Popover>
    </>
  );
}
