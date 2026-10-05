import type { Hex } from '@bulwarkxyz/hyperliquid';
import { compactSignatureToSignature, parseCompactSignature, serializeSignature } from 'viem';

/**
 * Bulwark accepts signatures from ordinary wallets (EOAs) only, whatever connects them: an injected extension,
 * WalletConnect, a hardware wallet. Hyperliquid accounts are EOAs: approving an agent, depositing and every
 * user-signed action are ECDSA signatures by the account's own key, so a smart-contract wallet (Safe,
 * a passkey or "smart" wallet) can't hold a Hyperliquid account directly. We say so clearly instead of
 * answering "bad signature".
 */
export const CONTRACT_WALLET_ERROR =
  'Smart-contract wallets are not supported: a Hyperliquid account signs with an ordinary wallet key. Connect the wallet that holds your Hyperliquid account.';

/** ERC-6492 wraps signatures from smart wallets that are not deployed yet; it ends with this magic suffix. */
const ERC6492_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';

/** True for signatures no EOA produces: ERC-6492 wrapped, or not 65 bytes (r, s, v) or 64 bytes (EIP-2098 compact). */
export function isContractWalletSignature(signature: Hex): boolean {
  const h = signature.slice(2).toLowerCase();
  return h.endsWith(ERC6492_SUFFIX) || (h.length !== 130 && h.length !== 128);
}

/** Bytecode at an address on Arbitrum One, through a public RPC (eth_getCode); '0x' when none or unknown. */
export function arbitrumCode(rpc = 'https://arb1.arbitrum.io/rpc', fetchImpl: typeof fetch = fetch) {
  return async (address: Hex): Promise<Hex> => {
    try {
      const res = await fetchImpl(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
        signal: AbortSignal.timeout(3000),
      });
      return ((await res.json()) as { result?: Hex }).result ?? '0x';
    } catch {
      return '0x';
    }
  };
}

/** EIP-7702 delegated EOAs carry code (0xef0100…) but still sign with their key: not a contract wallet. */
export const isContractCode = (code: Hex) => code !== '0x' && !code.toLowerCase().startsWith('0xef0100');

/** EIP-2098 compact signatures (64 bytes), which some wallets return, expanded to the 65-byte form viem verifies. */
export function normalizeSignature(signature: Hex): Hex {
  return signature.length === 130 ? (serializeSignature(compactSignatureToSignature(parseCompactSignature(signature))) as Hex) : signature;
}
