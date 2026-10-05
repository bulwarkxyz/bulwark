import { describe, expect, it } from 'vitest';
import { HyperliquidStream, marksFromCtxs, type SocketLike } from '../src/stream.js';

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
