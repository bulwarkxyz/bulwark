'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { NETWORK } from '@/lib/env';
import { useMarketActivity } from '@/lib/hl';
import { hasData, rankMarkets, type Market } from '@/lib/markets';
import { Icon } from './icons';
import { InLayer, isPhoneWidth, useAnchored, useOutside } from './layer';

/**
 * The trade screen's market selector. The list renders in the top layer, so no panel can cover or clip it.
 * Markets with live trades on this network come first (most recent first); markets with no data here are
 * marked and listed last, so nobody lands on an empty chart by accident.
 */
export function MarketPicker({ m, maxLev }: { m: Market; maxLev?: number }) {
  const router = useRouter();
  const activity = useMarketActivity();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(false);
  const [active, setActive] = useState(0);
  // The active option is outlined only while the keyboard is in use (no ring for mouse or touch).
  const [kb, setKb] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pos = useAnchored(trigger, open && !phone, { width: 360, maxHeight: 460 });
  const now = Date.now();
  const ranked = activity.data ? rankMarkets(activity.data, NETWORK, now) : null;
  const items = ranked ?? [];
  const noData = (x: Market) => Boolean(activity.data && !hasData(activity.data[x.coin], now));

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  const go = (x: Market) => {
    close(false);
    router.push(`/app/trade/${x.ticker}`);
  };
  useOutside([trigger, list], open, () => close(false));
  useEffect(() => {
    if (!open) return;
    list.current?.focus({ preventScroll: true });
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKey = (e: React.KeyboardEvent) => {
    setKb(true);
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((i) => Math.min(items.length - 1, i + 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((i) => Math.max(0, i - 1)));
    else if (e.key === 'Home') (e.preventDefault(), setActive(0));
    else if (e.key === 'End') (e.preventDefault(), setActive(items.length - 1));
    else if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), items[active] && go(items[active]!));
    else if (e.key === 'Escape') (e.preventDefault(), close());
    else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1 && /\w/.test(e.key)) {
      const i = items.findIndex((x) => x.ticker.toLowerCase().startsWith(e.key.toLowerCase()) || x.name.toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) setActive(i);
    }
  };

  const listbox = (
    <div
      ref={list}
      role="listbox"
      tabIndex={-1}
      aria-label="Markets"
      aria-activedescendant={items[active] ? `mk-${items[active]!.ticker}` : undefined}
      className={`${phone ? 'sel-list' : 'sel-list mk-list'} ${kb ? 'kb' : ''}`}
      onKeyDown={onKey}
      onPointerMove={() => setKb(false)}
      style={phone || !pos ? undefined : { top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight, transform: pos.above ? 'translateY(-100%)' : undefined }}
    >
      {!ranked ? (
        <div className="pb col" style={{ gap: 8 }}>
          <span className="sk" style={{ width: '80%' }} />
          <span className="sk" style={{ width: '70%' }} />
          <span className="sk" style={{ width: '75%' }} />
        </div>
      ) : (
        items.map((x, i) => (
          <div
            key={x.coin}
            id={`mk-${x.ticker}`}
            data-i={i}
            role="option"
            aria-selected={x.coin === m.coin}
            className={`mk-opt ${i === active ? 'act' : ''} ${x.coin === m.coin ? 'chosen' : ''}`}
            onPointerMove={() => setActive(i)}
            onClick={() => go(x)}
          >
            <span className="glyph">{x.ticker.slice(0, 2)}</span>
            <span className="col" style={{ gap: 0, minWidth: 0, flex: 1 }}>
              <span className="lab">{x.ticker}</span>
              <span className="desc">{x.name}</span>
            </span>
            {noData(x) ? <span className="tag">no data on {NETWORK}</span> : null}
            <span className="mark" aria-hidden>
              {x.coin === m.coin ? Icon.check(14) : null}
            </span>
          </div>
        ))
      )}
      <a className="mk-all small t2" href="/app" onClick={(e) => (e.preventDefault(), close(false), router.push('/app'))}>
        All markets →
      </a>
    </div>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="msel"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Market: ${m.ticker}-USDC. Change market`}
        onClick={() => {
          setKb(false);
          if (open) return close();
          setPhone(isPhoneWidth());
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setKb(true);
            setPhone(isPhoneWidth());
            setActive(0);
            setOpen(true);
          }
        }}
      >
        <span className="glyph">{m.ticker.slice(0, 2)}</span>
        <span className="col" style={{ gap: 0, alignItems: 'flex-start' }}>
          <b style={{ fontSize: 14 }}>{m.ticker}-USDC</b>
          <span className="tiny t3">{m.name} · xyz</span>
        </span>
        {maxLev ? <span className="chip chip-sm num">{maxLev}×</span> : null}
        {Icon.caret()}
      </button>
      {open ? (
        <InLayer>
          {phone ? (
            <>
              <div className="sel-scrim" onClick={() => close()} />
              <div className="sel-sheet" role="dialog" aria-label="Markets">
                <div className="grab" />
                <b className="small" style={{ padding: '0 6px 8px' }}>
                  Markets
                </b>
                {listbox}
              </div>
            </>
          ) : (
            listbox
          )}
        </InLayer>
      ) : null}
    </>
  );
}
