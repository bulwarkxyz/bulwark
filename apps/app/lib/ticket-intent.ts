/**
 * "Close" on a position row fills the order ticket: the opposite side, the position's own size,
 * market, reduce-only. The user still checks it, types their slippage and sends it; nothing is sent here.
 */
export interface CloseIntent {
  coin: string;
  side: 'long' | 'short';
  size: string;
}
const listeners = new Set<(i: CloseIntent) => void>();
export const ticketIntent = {
  emit(i: CloseIntent) {
    for (const fn of listeners) fn(i);
  },
  on(fn: (i: CloseIntent) => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};
/** The intent to close a position of `size` (signed: positive is long). */
export const closeIntent = (coin: string, size: number): CloseIntent => ({ coin, side: size > 0 ? 'short' : 'long', size: String(Math.abs(size)) });
