'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { GUARD_LABEL, STATE_STALE_MS, useClock, useGuardView, type GuardView } from '@/lib/guard';
import { NETWORK } from '@/lib/env';
import { useAccountView, useMarketActivity, useStreamStatus, useXyzMarkets } from '@/lib/hl';
import { readLastMarket } from '@/lib/last-market';
import { defaultMarket } from '@/lib/markets';
import { useViewer } from '@/lib/review';
import { BufferMeter, GuardChip } from './guard-ui';
import { ConnectButton } from './connect';
import { NotificationBell } from './notifications';
import { fmtBuffer, fmtPct, fmtPx, fmtSignedUsd, fmtUsd, upDown } from './format';
import { BrandMark, Icon } from './icons';
import { TopLayer } from './layer';
import { useTimes } from '@/lib/time';

const NAV = [
  { href: '/app/trade', label: 'Trade', match: '/app/trade' },
  { href: '/app', label: 'Markets' },
  { href: '/app/positions', label: 'Positions' },
  { href: '/app/rules', label: 'Guard rules' },
  { href: '/app/simulator', label: 'Simulator' },
  { href: '/app/audit', label: 'Audit log' },
];
const TABS = [
  { href: '/app', label: 'Markets', icon: Icon.markets },
  { href: '/app/trade', label: 'Trade', icon: Icon.trade, match: '/app/trade' },
  { href: '/app/positions', label: 'Positions', icon: Icon.positions },
  { href: '/app/rules', label: 'Guard', icon: Icon.shield },
  { href: '/app/settings', label: 'More', icon: Icon.more, also: ['/app/account', '/app/audit', '/app/simulator'] },
];
const isOn = (path: string, item: { href: string; match?: string; also?: string[] }) =>
  item.href === '/app' ? path === '/app' : path.startsWith(item.match ?? item.href) || Boolean(item.also?.some((p) => path.startsWith(p)));

/** Testnet label, part 1 of 3: a band that cannot be dismissed. */
export function NetBand() {
  if (NETWORK !== 'testnet') return null;
  return (
    <div className="netband" role="note">
      <span className="nettag">TESTNET</span>
      <span>Test funds only. Thin order books, tiny open interest and zero funding are normal on testnet, not a fault.</span>
    </div>
  );
}

/**
 * Where the Trade tab goes: straight to a market (no redirect page in between). The user's last market on
 * this device if it still has data, else the default from live activity, else the fixed first choice.
 */
function useTradeHref(): string {
  const activity = useMarketActivity();
  const [last, setLast] = useState<string | null>(null);
  const path = usePathname();
  useEffect(() => setLast(readLastMarket()), [path]);
  return `/app/trade/${defaultMarket(activity.data, NETWORK, Date.now(), last).ticker}`;
}

function phoneTitle(path: string): string {
  if (path.startsWith('/app/trade')) return 'Trade';
  if (path.startsWith('/app/positions')) return 'Positions';
  if (path.startsWith('/app/rules')) return 'Guard rules';
  if (path.startsWith('/app/simulator')) return 'Simulator';
  if (path.startsWith('/app/audit')) return 'Audit log';
  if (path.startsWith('/app/account')) return 'Account';
  if (path.startsWith('/app/notifications')) return 'Notifications';
  if (path.startsWith('/app/settings')) return 'More';
  return 'Markets';
}

function TopNav({ focused }: { focused: boolean }) {
  const path = usePathname();
  const tradeHref = useTradeHref();
  return (
    <header className="topnav">
      {/* The site root is the landing page (a separate zone). */}
      <a className={`brand ${focused ? '' : 'hide-sm'}`} href="/">
        <BrandMark />
        Bulwark
      </a>
      {/* Phones: a compact title bar, the page's name where the brand would be. */}
      {focused ? null : <b className="mobile-only ptl">{phoneTitle(path)}</b>}
      {focused ? (
        <span className="small t2 hide-sm">Set up</span>
      ) : (
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href === '/app/trade' ? tradeHref : n.href} className={isOn(path, n) ? 'on' : ''} aria-current={isOn(path, n) ? 'page' : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
      )}
      <span className="sp" />
      {/* Testnet label, part 2 of 3. */}
      {NETWORK === 'testnet' ? <span className="chip chip-net chip-sm">TESTNET</span> : null}
      {focused ? null : <NotificationBell />}
      <ConnectButton stepSignIn={focused} />
      {focused ? (
        <Link className="btn btn-sm btn-ghost" href="/app">
          Exit
        </Link>
      ) : (
        <Link className="btn btn-sm btn-ghost hide-sm" href="/app/settings" aria-label="Settings">
          {Icon.settings(16)}
        </Link>
      )}
    </header>
  );
}

function nextText(g: GuardView) {
  if (g.crossed && (g.state === 'acting' || g.state === 'risk')) {
    return (
      <span className={g.state === 'risk' ? 'ct' : 'wt'}>
        Below your <span className="num">{g.crossed.line}×</span> line on {g.crossed.ticker}: {g.crossed.does}
      </span>
    );
  }
  if (!g.next) return null;
  const d = g.next.does;
  return (
    <>
      {d.charAt(0).toUpperCase() + d.slice(1)} at <span className="num">{g.next.line}×</span> · {g.next.ticker} <span className="num">{fmtPx(g.next.price)}</span>{' '}
      <span className="num t3">{fmtPct(g.next.move * 100, 1)}</span>
    </>
  );
}

function StateNote({ g }: { g: GuardView }) {
  switch (g.state) {
    case 'disconnected':
      return <span className="small t2">Connect a wallet to see your margin buffer and what the guard will do. Market data is live.</span>;
    case 'norules':
      return (
        <span className="small t2">
          The guard is not armed. <Link href="/app/rules" style={{ textDecoration: 'underline' }}>Write your first rule</Link>.
        </span>
      );
    case 'paused':
      if (g.source === 'guard')
        return (
          <span className="small">
            {g.reasonText ?? 'The guard is paused.'}{' '}
            {g.reason === 'agent_expired' ? (
              <Link href="/app/onboarding?step=4" style={{ textDecoration: 'underline' }}>
                {g.noKey ? 'Create it' : 'Approve again'}
              </Link>
            ) : (
              'It holds off until this clears, then resumes by itself.'
            )}
          </span>
        );
      return <span className="small">{g.ageMs !== null && g.ageMs > STATE_STALE_MS ? `Account data is ${Math.round(g.ageMs / 1000)} s old. ` : 'Can’t reach Hyperliquid’s data. '}The guard acts only on fresh data and holds off until it returns.</span>;
    case 'stopped':
      return (
        <span className="small ct">
          Your positions are not protected. <Link href="/app/settings" style={{ textDecoration: 'underline' }}>Resume</Link>
        </span>
      );
    case 'alertsonly':
      return <span className="small t2">In your region the guard sends alerts but does not trade.</span>;
    case 'unsupported':
      return <span className="small t2">Portfolio margin is shown read-only. The guard does not act on it.</span>;
    default:
      return null;
  }
}

function useFigures() {
  const { address } = useViewer();
  const view = useAccountView(address);
  const risk = view.data?.risk;
  if (!risk) return null;
  const upnl = risk.pools.reduce((s, p) => s + p.positions.reduce((t, r) => t + r.unrealizedPnl, 0), 0);
  const available = risk.idle.reduce((s, i) => s + i.available, 0);
  return { value: risk.accountValue, upnl, available };
}

/** Persistent chrome: guard state, lowest buffer, next guard action, account figures. */
function GuardBar() {
  const g = useGuardView();
  const f = useFigures();
  const armed = g.state === 'protected' || g.state === 'acting' || g.state === 'risk';
  return (
    <div className="gbar" aria-label="Guard and account">
      <Link href="/app/positions" aria-label={`Guard: ${GUARD_LABEL[g.state]}`}>
        <GuardChip state={g.state} />
      </Link>
      {g.state === 'loading' ? (
        <>
          <div className="fig">
            <span className="lbl">Lowest buffer</span>
            <span className="sk" style={{ width: 150 }} />
          </div>
          <div className="fig">
            <span className="lbl">Next guard action</span>
            <span className="sk" style={{ width: 190 }} />
          </div>
        </>
      ) : armed || (g.worst && g.state !== 'disconnected') ? (
        <>
          <div className="fig">
            <span className="lbl">Lowest buffer{g.worst ? ` · ${g.worst.positions.length === 1 ? g.worst.positions[0]!.position.coin.replace(/^[a-z]+:/, '') : 'cross'} pool` : ''}</span>
            <div className="row nw" style={{ gap: 10 }}>
              <span className="num">{g.worst ? fmtBuffer(g.worst.buffer) : '—'}</span>
              <BufferMeter size="mini" buffer={g.worst?.buffer ?? null} lines={g.lines} state={g.state} />
            </div>
          </div>
          {armed ? (
            <div className="fig">
              <span className="lbl">{g.crossed && g.state !== 'protected' ? 'Guard now' : 'Next guard action'}</span>
              <span className="small">{nextText(g) ?? <span className="t2">No line within reach of any position</span>}</span>
            </div>
          ) : (
            <StateNote g={g} />
          )}
        </>
      ) : (
        <StateNote g={g} />
      )}
      {g.exampleRules ? <span className="tag">Example rules</span> : null}
      {f && g.state !== 'loading' ? (
        <>
          <span className="sep" />
          <div className="fig">
            <span className="lbl">Account value</span>
            <span className="num">{fmtUsd(f.value)}</span>
          </div>
          <div className="fig">
            <span className="lbl">Unrealised PnL</span>
            <span className={`num ${upDown(f.upnl)}`}>{fmtSignedUsd(f.upnl)}</span>
          </div>
          <div className="fig">
            <span className="lbl">Available</span>
            <span className="num">{fmtUsd(f.available)}</span>
          </div>
        </>
      ) : null}
      <span className="sp" />
      {armed ? (
        <Link className="btn btn-sm" href="/app/settings#kill-switch">
          {Icon.stop()}
          Stop guard
        </Link>
      ) : null}
    </div>
  );
}

/** Phone: the same reading in two lines under the header. */
function MobileGuard() {
  const g = useGuardView();
  const f = useFigures();
  const armed = g.state === 'protected' || g.state === 'acting' || g.state === 'risk';
  return (
    <div className="mguard">
      <div className="row nw" style={{ gap: 10 }}>
        <Link href="/app/positions" aria-label={`Guard: ${GUARD_LABEL[g.state]}, open positions`}>
          <GuardChip state={g.state} sm />
        </Link>
        {g.worst && g.state !== 'loading' ? (
          <>
            <span className="num small b">{fmtBuffer(g.worst.buffer)}</span>
            <BufferMeter size="row" buffer={g.worst.buffer} lines={g.lines} state={g.state} />
          </>
        ) : null}
        {g.exampleRules ? <span className="tag">Example</span> : null}
      </div>
      {armed && (g.next || g.crossed) ? (
        <span className="tiny t2">
          Next: {nextText(g)}
          {f ? (
            <>
              {' '}
              · Account <span className="num">{fmtUsd(f.value)}</span>
            </>
          ) : null}
        </span>
      ) : (
        <StateNote g={g} />
      )}
    </div>
  );
}

/** Testnet label, part 3 of 3, plus how fresh every data source is. */
function StatusBar() {
  const times = useTimes();
  const markets = useXyzMarkets();
  const live = useStreamStatus();
  const g = useGuardView();
  const now = useClock(1_000);
  const age = (t: number) => `${Math.max(0, Math.round((now - t) / 1000))} s`;
  const marketsAge = markets.dataUpdatedAt ? age(markets.dataUpdatedAt) : null;
  return (
    <footer className="statusbar">
      <span className="row nw" style={{ gap: 6 }}>
        <span className={`dot ${NETWORK === 'testnet' ? 'dot-net' : 'dot-ok'}`} />
        {NETWORK === 'testnet' ? 'Testnet' : 'Mainnet'}
      </span>
      <span className={`row nw ${markets.isError ? 'ct' : ''}`} style={{ gap: 6 }}>
        <span className={`dot ${markets.isError ? 'dot-crit' : 'dot-ok'}`} />
        {markets.isError ? 'Prices · can’t reach Hyperliquid' : marketsAge ? `Prices · ${marketsAge} old` : 'Prices · connecting'}
      </span>
      {live.active > 0 ? (
        <span className="row nw" style={{ gap: 6 }}>
          <span className={`dot ${live.open ? 'dot-ok' : 'dot-crit'}`} />
          {live.open ? `Book and trades · streaming · last update ${age(live.lastMessageAt)} ago` : 'Book and trades · stream down, polling'}
        </span>
      ) : null}
      {g.ageMs !== null ? (
        <span className={`row nw ${g.state === 'paused' ? 'ct' : ''}`} style={{ gap: 6 }}>
          <span className={`dot ${g.state === 'paused' ? 'dot-crit' : 'dot-ok'}`} />
          Account · {Math.max(0, Math.round(g.ageMs / 1000))} s old
        </span>
      ) : null}
      {g.lastEvaluatedAt ? (
        <span className="row nw" style={{ gap: 6 }}>
          <span className={`dot ${g.state === 'paused' ? 'dot-crit' : 'dot-ok'}`} />
          Guard checked {age(g.lastEvaluatedAt)} ago
        </span>
      ) : null}
      <span className="sp" />
      <span className="hide-sm">{times.utc ? 'Times in UTC' : 'Times in your local time'}</span>
    </footer>
  );
}

function MobileTabBar() {
  const path = usePathname();
  const tradeHref = useTradeHref();
  return (
    <nav className="mtabbar" aria-label="Main">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href === '/app/trade' ? tradeHref : t.href} className={isOn(path, t) ? 'on' : ''} aria-current={isOn(path, t) ? 'page' : undefined}>
          {t.icon(20)}
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

function SetupBar() {
  const g = useGuardView();
  const armed = g.state === 'protected' || g.state === 'acting' || g.state === 'risk';
  return (
    <div className="gbar" style={{ display: 'flex' }}>
      <GuardChip state={armed ? g.state : 'norules'} label={armed ? undefined : 'Guard not armed yet'} />
      <span className="small t2">{armed ? 'The guard is armed with your signed rules.' : 'The guard arms when its key is approved and you sign your first rules.'}</span>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const focused = path.startsWith('/app/onboarding');
  return (
    <div className="bw shell">
      <NetBand />
      <TopNav focused={focused} />
      {focused ? <SetupBar /> : <GuardBar />}
      {focused ? null : <MobileGuard />}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>{children}</main>
      <StatusBar />
      <TopLayer />
      {focused ? null : <MobileTabBar />}
    </div>
  );
}
