import { afterEach, describe, expect, it, vi } from 'vitest';
import { HyperliquidStream, MAX_COIN_STREAMS, STABLE_CONNECTION_MS, marksFromCtxs, type SocketLike } from '../src/stream.js';

function fakeSocket() {
  const handlers: Record<string, (a?: unknown) => void> = {};
  const sent: string[] = [];
  let open = false;
  const s: SocketLike & { emit(e: string, a?: unknown): void; sent: string[] } = {
    on: (e, cb) => void (handlers[e] = cb),
    send: (d) => {
      if (!open) throw new Error('WebSocket is not open');
      sent.push(d);
    },
    close: () => handlers.close?.(),
    emit: (e, a) => {
      if (e === 'open') open = true;
      handlers[e]?.(a);
    },
    sent,
  };
  return s;
}

describe('stream', () => {
  it('queues subscriptions made while connecting and sends them on open', () => {
    const sock = fakeSocket();
    const st = new HyperliquidStream('wss://x', {}, () => sock);
    st.start();
    st.subscribeMarks();
    st.subscribeUser('0xABC');
    expect(sock.sent).toEqual([]);
    sock.emit('open');
    expect(sock.sent.map((x) => JSON.parse(x).subscription.type)).toEqual(['allDexsAssetCtxs', 'allDexsClearinghouseState', 'spotState']);
    st.stop();
  });

  it('follows a held market on its own ~1 s stream, once, and hands its mark to the guard', () => {
    const sock = fakeSocket();
    const got: Array<[string, number]> = [];
    const st = new HyperliquidStream('wss://x', { onCoinMark: (c, m) => got.push([c, m]) }, () => sock);
    st.start();
    sock.emit('open');
    st.subscribeCoin('xyz:GOLD');
    st.subscribeCoin('xyz:GOLD');
    expect(sock.sent.map((x) => JSON.parse(x).subscription)).toEqual([{ type: 'activeAssetCtx', coin: 'xyz:GOLD' }]);
    st.dispatch(JSON.stringify({ channel: 'activeAssetCtx', data: { coin: 'xyz:GOLD', ctx: { markPx: '4157.2', oraclePx: '4158.4' } } }));
    st.dispatch(JSON.stringify({ channel: 'activeAssetCtx', data: { coin: 'xyz:GOLD', ctx: { markPx: 'x' } } }));
    expect(got).toEqual([['xyz:GOLD', 4157.2]]);
    st.stop();
  });

  afterEach(() => vi.useRealTimers());

  it('after a drop, reconnects and resends every subscription, held markets included', () => {
    vi.useFakeTimers();
    const socks: Array<ReturnType<typeof fakeSocket>> = [];
    const status: string[] = [];
    const st = new HyperliquidStream('wss://x', { onStatus: (s) => status.push(s) }, () => (socks.push(fakeSocket()), socks.at(-1)!));
    st.start();
    st.subscribeMarks();
    socks[0]!.emit('open');
    st.subscribeCoin('xyz:GOLD');
    st.subscribeCoin('BTC');
    socks[0]!.emit('close');
    expect(status).toEqual(['open', 'closed']);
    vi.advanceTimersByTime(500);
    expect(socks).toHaveLength(2);
    socks[1]!.emit('open');
    expect(socks[1]!.sent.map((x) => JSON.parse(x).subscription)).toEqual([{ type: 'allDexsAssetCtxs' }, { type: 'activeAssetCtx', coin: 'xyz:GOLD' }, { type: 'activeAssetCtx', coin: 'BTC' }]);
    st.stop();
  });

  it('keeps backing off while a connection flaps, and resets only after one stays up', () => {
    vi.useFakeTimers();
    let t = 0;
    const socks: Array<ReturnType<typeof fakeSocket>> = [];
    const st = new HyperliquidStream('wss://x', {}, () => (socks.push(fakeSocket()), socks.at(-1)!), () => t);
    st.start();
    const flap = (upMs: number) => {
      const s = socks.at(-1)!;
      s.emit('open');
      t += upMs;
      s.emit('close');
    };
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      flap(100);
      const before = socks.length;
      let w = 0;
      while (socks.length === before) (vi.advanceTimersByTime(100), (w += 100));
      waits.push(w);
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 15000]);
    flap(STABLE_CONNECTION_MS);
    const before = socks.length;
    vi.advanceTimersByTime(500);
    expect(socks.length).toBe(before + 1);
    st.stop();
  });

  it(`follows at most ${MAX_COIN_STREAMS} held markets on their own stream (inside the 1,000-subscription limit)`, () => {
    const st = new HyperliquidStream('wss://x', {}, () => fakeSocket());
    st.subscribeMarks();
    for (let i = 0; i < MAX_COIN_STREAMS; i++) expect(st.subscribeCoin(`C${i}`)).toBe(true);
    expect(st.subscribeCoin('ONE-TOO-MANY')).toBe(false);
    expect(st.subscribeCoin('C0')).toBe(true);
    expect(st.coinCount).toBe(MAX_COIN_STREAMS);
    expect(st.subscriptionCount).toBe(MAX_COIN_STREAMS + 1);
  });

  it('caps users per connection at 10', () => {
    const st = new HyperliquidStream('wss://x', {}, () => fakeSocket());
    for (let i = 0; i < 10; i++) st.subscribeUser(`0x${i}`);
    expect(() => st.subscribeUser('0xb')).toThrow(/10 users/);
  });

  it('dispatches user state and maps marks by universe order', () => {
    const got: unknown[] = [];
    const st = new HyperliquidStream('wss://x', { onUserState: (u, s) => got.push([u, s.length]) }, () => fakeSocket());
    st.dispatch(JSON.stringify({ channel: 'allDexsClearinghouseState', data: { user: '0xABC', clearinghouseStates: [['', {}], ['xyz', {}]] } }));
    expect(got).toEqual([['0xabc', 2]]);
    const m = marksFromCtxs([['xyz', [{ markPx: '91.5' }, { markPx: '4100' }]]], new Map([['xyz', ['xyz:CL', 'xyz:GOLD']]]));
    expect(Object.fromEntries(m)).toEqual({ 'xyz:CL': 91.5, 'xyz:GOLD': 4100 });
  });
});
