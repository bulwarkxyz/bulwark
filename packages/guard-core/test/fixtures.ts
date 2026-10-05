import { readFileSync, readdirSync } from 'node:fs';
import { buildAssetIndex, dexCollateral } from '../src/assets.js';
import type { RawClearinghouseState, RawPerpDexs, RawPerpMeta, RawSpotState } from '../src/types.js';

const dir = new URL('./fixtures/', import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as T;

export interface AccountFixture {
  label: string;
  mode: string;
  capturedAt: string;
  dexNames: string[];
  dexes: Record<string, RawClearinghouseState>;
  spot: RawSpotState;
}

export const perpDexs = read<RawPerpDexs>('perpDexs.json');
export const allPerpMetas = read<RawPerpMeta[]>('allPerpMetas.json');
export const assets = buildAssetIndex(perpDexs, allPerpMetas);
export const collateral = dexCollateral(perpDexs, allPerpMetas);

export const accounts: AccountFixture[] = readdirSync(dir)
  .filter((f) => f.startsWith('account-') && f.endsWith('.json'))
  .sort()
  .map((f) => read<AccountFixture>(f));
