import { describe, expect, it } from 'vitest';
import { groupLevels, tickOptions } from '@/lib/book-group';

describe('order book grouping', () => {
  it('offers three ticks from the price', () => {
    expect(tickOptions(94.26)).toEqual([0.001, 0.01, 0.1]);
    expect(tickOptions(4169.7)).toEqual([0.1, 1, 10]);
    expect(tickOptions(undefined)).toEqual([]);
  });
  it('bids round down, asks round up, sizes add up', () => {
    const bids = [{ px: 94.255, sz: 1 }, { px: 94.25, sz: 2 }, { px: 94.241, sz: 3 }];
    const asks = [{ px: 94.261, sz: 1 }, { px: 94.265, sz: 2 }, { px: 94.271, sz: 4 }];
    expect(groupLevels(bids, 0.01, 'bid')).toEqual([{ px: 94.25, sz: 3 }, { px: 94.24, sz: 3 }]);
    expect(groupLevels(asks, 0.01, 'ask')).toEqual([{ px: 94.27, sz: 3 }, { px: 94.28, sz: 4 }]);
  });
  it('a level already on the tick stays where it is', () => {
    expect(groupLevels([{ px: 94.26, sz: 5 }], 0.01, 'ask')).toEqual([{ px: 94.26, sz: 5 }]);
    expect(groupLevels([{ px: 94.26, sz: 5 }], 0.01, 'bid')).toEqual([{ px: 94.26, sz: 5 }]);
  });
  it('no tick: the levels as sent', () => {
    const l = [{ px: 1, sz: 1 }];
    expect(groupLevels(l, null, 'bid')).toEqual(l);
  });
});
