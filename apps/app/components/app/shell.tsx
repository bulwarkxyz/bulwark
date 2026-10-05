'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount } from 'wagmi';
import { useAccountView } from '@/lib/hl';
import { useMe } from '@/lib/me';
import { BrandMark, Icon } from './icons';
import { fmtBuffer, fmtUsd, shortAddr } from './format';
import { ConnectButton } from './connect';
import { NetworkBadge } from './network-badge';

const NAV = [
  { href: '/app', label: 'Markets', icon: Icon.markets, tab: true },
  { href: '/app/trade/CL', label: 'Trade', icon: Icon.trade, tab: true, match: '/app/trade' },
  { href: '/app/positions', label: 'Positions', icon: Icon.positions, tab: true },
  { href: '/app/rules', label: 'Guard rules', icon: Icon.shield, tab: true, tabLabel: 'Guard' },
  { href: '/app/simulator', label: 'Simulator', icon: Icon.simulator },
  { href: '/app/account', label: 'Account', icon: Icon.account },
  { href: '/app/audit', label: 'Audit log', icon: Icon.audit },
  { href: '/app/settings', label: 'Settings', icon: Icon.settings },
];

function active(path: string, item: (typeof NAV)[number]) {
  if (item.href === '/app') return path === '/app';
  return path.startsWith(item.match ?? item.href);
}

/** The highest of the user's lines that the buffer is still above (the next one it would cross). */
function nextLine(lines: number[], buffer: number | undefined): string | null {
  if (!lines.length) return null;
  const below = lines.filter((l) => buffer === undefined || l < buffer);
  return `${below.length ? Math.max(...below) : Math.min(...lines)}×`;
}

function GuardMini() {
  const { address } = useAccount();
  const me = useMe();
  const view = useAccountView(address);
  const lines = me.data?.policy?.policy.rules.filter((r) => r.when.kind === 'buffer').map((r) => (r.when as { below: number }).below) ?? [];
  const worst = view.data?.risk.worst;
  const armed = Boolean(me.data?.policy) && me.data?.user?.region === 'allowed' && !me.data?.user?.killSwitch && me.data?.agent?.approved;
  const state = !address ? 'Not connected' : !me.data?.policy ? 'No rules yet' : me.data?.user?.killSwitch ? 'Stopped' : me.data?.user?.region === 'guardOff' ? 'Alerts only' : armed ? 'Guard armed' : 'Not armed';
  return (
    <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className={`chip ${armed ? 'chip-guard' : me.data?.user?.killSwitch ? 'chip-crit' : ''}`} style={{ alignSelf: 'flex-start' }}>
        <i />
        {state}
      </span>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="faint">Buffer</span>
        <span className="num" style={{ color: 'var(--guard-text)', fontWeight: 600 }}>{worst ? fmtBuffer(worst.buffer) : '—'}</span>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="faint">Next line</span>
        <span className="num">{nextLine(lines, worst?.buffer) ?? '—'}</span>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  if (path.startsWith('/app/onboarding')) return <div className="bw page" style={{ minHeight: '100vh' }}>{children}</div>;
  return (
    <div className="bw app">
      <nav className="rail" aria-label="Main">
        <Link href="/" className="brand">
          <BrandMark />
          Bulwark
        </Link>
        <div className="nav">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={active(path, item) ? 'on' : ''} aria-current={active(path, item) ? 'page' : undefined}>
              {item.icon()}
              {item.label}
            </Link>
          ))}
        </div>
        <div className="rail-foot">
          <GuardMini />
          <Link className="btn btn-sm" href="/app/settings#kill-switch">
            Stop guard
          </Link>
        </div>
      </nav>
      <main className="main">
        {children}
        <nav className="tabbar" aria-label="Main">
          {NAV.filter((n) => n.tab).map((item) => (
            <Link key={item.href} href={item.href} className={active(path, item) ? 'on' : ''}>
              {item.icon(20)}
              {item.tabLabel ?? item.label}
            </Link>
          ))}
          <Link href="/app/settings" className={['/app/settings', '/app/account', '/app/audit', '/app/simulator'].some((p) => path.startsWith(p)) ? 'on' : ''}>
            {Icon.more()}
            More
          </Link>
        </nav>
      </main>
    </div>
  );
}

/** Top bar used by every screen: title, optional chips, and the wallet. */
export function TopBar({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  const { address } = useAccount();
  const view = useAccountView(address);
  return (
    <header className="topbar">
      <h1>{title}</h1>
      <NetworkBadge />
      {children}
      <span className="spacer" />
      {address && view.data ? (
        <Link className="chip hide-sm" href="/app/account">
          <span className="num">{shortAddr(address)}</span>
          <span className="faint">·</span>
          <span className="num">{fmtUsd(view.data.risk.accountValue)}</span>
        </Link>
      ) : null}
      <ConnectButton />
    </header>
  );
}
