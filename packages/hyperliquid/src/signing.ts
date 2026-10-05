import { encode } from '@msgpack/msgpack';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { hashTypedData, type TypedDataDefinition } from 'viem';
import { USER_SIGNED_TYPES, type Hex, type L1Action, type UserSignedAction } from './actions.js';

/**
 * L1 action hash ("connectionId"): keccak256(msgpack(action) ‖ nonce:u64be ‖ vaultFlag[‖vault] [‖ 0x00 ‖ expiresAfter:u64be]).
 * Matches the official SDKs; pinned by parity tests against @nktkas/hyperliquid.
 */
export function l1ActionHash(args: { action: L1Action | Record<string, unknown>; nonce: number; vaultAddress?: Hex; expiresAfter?: number }): Hex {
  const { action, nonce, vaultAddress, expiresAfter } = args;
  const u64 = (n: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n));
    return b;
  };
  const parts: Uint8Array[] = [encode(stripUndefined(action)), u64(nonce)];
  parts.push(vaultAddress ? concatBytes(new Uint8Array([1]), hexToBytes(vaultAddress.slice(2))) : new Uint8Array([0]));
  if (expiresAfter !== undefined) parts.push(new Uint8Array([0]), u64(expiresAfter));
  return `0x${bytesToHex(keccak_256(concatBytes(...parts)))}`;
}

function stripUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = stripUndefined(x);
    return out;
  }
  return v;
}

const ZERO = '0x0000000000000000000000000000000000000000' as const;

/** The "phantom agent" typed data an agent key signs for an L1 action. Source "a" mainnet, "b" testnet. */
export function l1TypedData(connectionId: Hex, isMainnet: boolean): TypedDataDefinition {
  return {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source: isMainnet ? 'a' : 'b', connectionId },
  };
}

/** Typed data a user's wallet signs for a user-signed action (domain "HyperliquidSignTransaction"). */
export function userSignedTypedData(action: UserSignedAction): TypedDataDefinition {
  const types = USER_SIGNED_TYPES[action.type] as unknown as Record<string, Array<{ name: string; type: string }>>;
  const primaryType = Object.keys(types)[0] as string;
  const message: Record<string, unknown> = {};
  for (const f of types[primaryType] ?? []) message[f.name] = (action as unknown as Record<string, unknown>)[f.name];
  return {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: Number.parseInt(action.signatureChainId, 16), verifyingContract: ZERO },
    types,
    primaryType,
    message,
  } as unknown as TypedDataDefinition;
}

export const digestOf = (typed: TypedDataDefinition): Hex => hashTypedData(typed);

export interface Signature {
  r: Hex;
  s: Hex;
  v: 27 | 28;
}
