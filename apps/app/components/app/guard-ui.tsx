'use client';

import { GUARD_CHIP, GUARD_LABEL, NO_BACKSTOP_LINE, marginTooLarge, meterPos, meterTop, noBackstopText, tickerOf, type GuardState, type GuardView } from '@/lib/guard';
import { Icon } from './icons';

const ICON: Partial<Record<GuardState, () => React.ReactNode>> = {
  protected: () => Icon.shieldCheck(),
  acting: () => Icon.shieldAlert(),
  risk: () => Icon.shieldAlert(),
  paused: () => Icon.pause(),
  stopped: () => Icon.stop(),
  norules: () => Icon.shield(13),
  disconnected: () => Icon.shield(13),
  alertsonly: () => Icon.shield(13),
  unsupported: () => Icon.shield(13),
};

/** The guard state chip. Lime only for "Protected" (app.css colour rule). */
export function GuardChip({ state, sm, label }: { state: GuardState; sm?: boolean; label?: string }) {
  if (state === 'loading') return <span className="sk" style={{ width: sm ? 72 : 96, height: sm ? 20 : 24, borderRadius: 12 }} aria-label="Loading guard state" />;
  return (
    <span className={`chip ${GUARD_CHIP[state]} ${sm ? 'chip-sm' : ''}`} role="status">
      {ICON[state]?.()}
      {label ?? GUARD_LABEL[state]}
    </span>
  );
}

/**
 * Buffer meter: log scale from liquidation (1×, left edge) to the top, zones from the user's own lines
 * (red below the lowest, amber between, lime above the highest), ticks at each line, a pin at the buffer.
 * With no lines there are no zones: nothing is drawn that the user did not set.
 */
export function BufferMeter({ buffer, lines, draft = [], state, size = 'full', labels = false, does }: { buffer: number | null; lines: readonly number[]; draft?: readonly number[]; state: GuardState; size?: 'mini' | 'row' | 'full'; labels?: boolean; does?: (line: number) => string }) {
  // `draft`: lines in rules the user hasn't signed yet; drawn in amber, no zones.
  const top = meterTop([...lines, ...draft]);
  const lo = lines.length ? meterPos(Math.min(...lines), top) : 0;
  const hi = lines.length ? meterPos(Math.max(...lines), top) : 0;
  const pin = buffer === null ? null : Number.isFinite(buffer) ? meterPos(buffer, top) : 100;
  const pinCls = state === 'acting' ? 'acting' : state === 'risk' ? 'risk' : state === 'protected' ? '' : 'off';
  const h = size === 'mini' ? 8 : size === 'row' ? 6 : 12;
  // Labels that sit close together (or close to the liquidation label) alternate onto a second row.
  const sorted = [...lines.map((l) => ({ l, draft: false })), ...draft.map((l) => ({ l, draft: true }))].sort((a, b) => a.l - b.l);
  let prev = 0;
  let prevRow = 0;
  const placed = sorted.map(({ l, draft: d }) => {
    const pos = meterPos(l, top);
    const row = pos - prev < 16 ? 1 - prevRow : 0;
    prev = pos;
    prevRow = row;
    return { l, pos, row, d };
  });
  const staggered = placed.some((p) => p.row === 1);
  const label = buffer === null ? 'No buffer yet' : `Buffer ${Number.isFinite(buffer) ? buffer.toFixed(2) : 'no positions'}×${lines.length ? `, lines at ${lines.map((l) => `${l}×`).join(', ')}` : ', no lines set'}`;
  return (
    <div style={{ flex: size === 'mini' ? undefined : 1, minWidth: size === 'mini' ? 150 : 80 }}>
      <div className={`meter ${size === 'mini' ? 'mini' : ''}`} style={{ height: h }} role="img" aria-label={label}>
        {lines.length ? (
          <>
            <div className="z z-crit" style={{ left: 0, width: `${lo}%` }} />
            <div className="z z-warn" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
            <div className="z z-safe" style={{ left: `${hi}%`, right: 0 }} />
          </>
        ) : null}
        <div className="liq" />
        {lines.map((l) => (
          <div key={l} className="ln" style={{ left: `${meterPos(l, top)}%` }} />
        ))}
        {draft.map((l) => (
          <div key={`d${l}`} className="ln draft" style={{ left: `${meterPos(l, top)}%` }} />
        ))}
        {pin !== null ? <div className={`pin ${pinCls}`} style={{ left: `${pin}%` }} /> : null}
      </div>
      {labels ? (
        <div className="mlabels" style={{ marginTop: 6, height: staggered || (pin !== null && placed.some((p) => Math.abs(p.pos - pin) < 9 && p.row === 0)) ? 60 : 30 }}>
          <span className="ct" style={{ left: 0, transform: 'none', textAlign: 'left' }}>
            1.00×
            <br />
            liquidation
          </span>
          {pin !== null && buffer !== null && Number.isFinite(buffer) ? (
            // "now" under the pin, on whichever row is clear of the line labels.
            <span className="b" style={{ left: `${Math.min(pin, 96)}%`, top: placed.some((p) => Math.abs(p.pos - pin) < 9 && p.row === 0) ? 30 : 0 }}>
              now
              <br />
              <span className="num">{buffer.toFixed(2)}×</span>
            </span>
          ) : null}
          {placed.map(({ l, pos, row, d }) => (
            <span key={`${d ? 'd' : ''}${l}`} className={d ? 'wt' : undefined} style={{ left: `${pos}%`, top: row ? 30 : 0 }}>
              <span className="num">{l}×</span>
              <br />
              {d ? 'draft' : (does?.(l) ?? '')}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Positions the guard leaves without a backstop because a fall can't bring the pool to the line (margin
 * large next to the position), each with the full reason. Nothing for the user to do. Wording from the
 * guard session (lib/guard.ts).
 */
export function NoBackstopNotes({ g, restingCoins }: { g: GuardView; restingCoins: ReadonlySet<string> }) {
  const rows = Object.keys(g.noBackstop)
    .map((coin) => ({ coin, nb: marginTooLarge(g, coin) }))
    .filter((x): x is { coin: string; nb: NonNullable<ReturnType<typeof marginTooLarge>> } => Boolean(x.nb) && !restingCoins.has(x.coin));
  if (!rows.length) return null;
  return (
    <div className="pb col" style={{ gap: 10, borderTop: '1px solid var(--line)' }}>
      {rows.map(({ coin, nb }) => (
        <div key={coin} className="col" style={{ gap: 3 }}>
          <span className="small">
            <b>{tickerOf(coin)}</b> · {NO_BACKSTOP_LINE}
          </span>
          <span className="tiny t2">{noBackstopText(nb)}</span>
        </div>
      ))}
    </div>
  );
}
