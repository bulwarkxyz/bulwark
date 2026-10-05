import { NETWORK } from './env';

/** The user's last market on this device and network (localStorage; nothing if storage is blocked). */
const KEY = `bw-last-market.${NETWORK}`;
export function readLastMarket(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
export function saveLastMarket(ticker: string) {
  try {
    localStorage.setItem(KEY, ticker);
  } catch {
    // storage blocked: the default is picked from live data each time
  }
}
