import { describe, expect, it } from 'vitest';
import { pauseText } from '../lib/guard';

describe('pauseText for agent_expired', () => {
  const now = Date.UTC(2026, 9, 6);
  it('a user with no guard key is told to create one, not that an approval expired', () => {
    expect(pauseText('agent_expired', null, now)).toBe('You don’t have a guard key yet. Create it in setup.');
    expect(pauseText('agent_expired', undefined, now)).toMatch(/don’t have a guard key/);
  });
  it('an expired approval says so', () => {
    expect(pauseText('agent_expired', { approved: true, validUntil: now - 1 }, now)).toMatch(/expired/);
  });
  it('a key never approved says to approve it', () => {
    expect(pauseText('agent_expired', { approved: false, validUntil: null }, now)).toMatch(/isn’t approved/);
  });
});
