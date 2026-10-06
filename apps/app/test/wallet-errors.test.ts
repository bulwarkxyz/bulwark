import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api';
import { split } from '../lib/signing';
import { explainWalletError, walletErrorText } from '../lib/wallet-errors';

// How wallets and libraries actually report each failure: EIP-1193 codes, viem's wrapped errors (with the
// wallet's error as `cause`), WalletConnect's strings, Hyperliquid's and Bulwark's answers.
const viem = (name: string, shortMessage: string, cause?: unknown) => Object.assign(new Error(shortMessage), { name, shortMessage, cause });
const rpc = (code: number, message: string) => Object.assign(new Error(message), { code });

describe('explainWalletError', () => {
  const cases: Array<[string, unknown, RegExp, boolean?]> = [
    ['MetaMask reject (4001)', rpc(4001, 'MetaMask Tx Signature: User denied transaction signature.'), /You declined/, true],
    ['viem UserRejectedRequestError wrapping 4001', viem('UserRejectedRequestError', 'User rejected the request.', rpc(4001, 'User rejected')), /You declined/, true],
    ['Rabby reject text', new Error('User rejected the request.'), /You declined/, true],
    ['WalletConnect reject text', new Error('Rejected by user'), /You declined/, true],
    ['Coinbase extension reject', new Error('User denied message signature'), /You declined/, true],
    ['ethers-style ACTION_REJECTED', Object.assign(new Error('user rejected action'), { code: 'ACTION_REJECTED' }), /You declined/, true],
    ['request already pending (-32002)', rpc(-32002, "Request of type 'wallet_requestPermissions' already pending"), /already has a request open/],
    ['no provider', viem('ProviderNotFoundError', 'Provider not found.'), /No browser wallet found/],
    ['connector not found', viem('ConnectorNotFoundError', 'Connector not found.'), /No browser wallet found/],
    ['unauthorised account (4100)', rpc(4100, 'The requested account and/or method has not been authorized by the user.'), /hasn’t given Bulwark access/],
    ['typed data unsupported (4200)', rpc(4200, 'Unsupported method'), /can’t make the kind of signature/],
    ['method not found (-32601)', viem('MethodNotSupportedRpcError', 'Method not found', rpc(-32601, 'the method eth_signTypedData_v4 does not exist')), /can’t make the kind of signature/],
    ['disconnected (4900)', rpc(4900, 'Disconnected'), /disconnected/],
    ['WalletConnect session gone', new Error('No matching key. session topic doesn’t exist: 1a2b'), /disconnected/],
    ['EIP-712 chain mismatch (MetaMask)', rpc(-32603, 'Provided chainId "42161" must match the active chainId "1"'), /changed network while signing/],
    ['switch chain refused (4902)', rpc(4902, 'Unrecognized chain ID "0xa4b1".'), /couldn’t switch network/],
    ['WalletConnect request expired', new Error('Request expired. Please try again.'), /timed out/],
    ['Hyperliquid: wrong signer', new Error('User or API Wallet 0xabc does not exist.'), /didn’t recognise that signature/],
    ['Hyperliquid: no deposit', new Error('Must deposit before performing actions. User: 0xabc'), /no deposit on Hyperliquid/],
    ['offline', new TypeError('Failed to fetch'), /Couldn’t reach the network/],
    ['contract-wallet signature (local)', new Error('This looks like a smart-contract wallet’s signature. Hyperliquid accounts need an ordinary wallet.'), /Smart-contract wallets/],
  ];
  for (const [name, err, re, declined] of cases)
    it(name, () => {
      const x = explainWalletError(err);
      expect(x.text).toMatch(re);
      expect(Boolean(x.declined)).toBe(Boolean(declined));
      if (!declined && !/^Something/.test(x.text)) expect(x.next, 'each failure says what to do next').toBeTruthy();
    });

  it('shows the API’s contract-wallet answer as it is, and nothing after it', () => {
    const e = new ApiError(400, { code: 'contract_wallet', error: 'Smart-contract wallets aren’t supported. Connect the wallet that holds your Hyperliquid account.' });
    const x = explainWalletError(e);
    expect(x.text).toBe('Smart-contract wallets aren’t supported. Connect the wallet that holds your Hyperliquid account.');
    expect(x.next).toBeUndefined();
    expect(walletErrorText(e)).toBe(x.text);
  });
  it('maps API sign-in failures, region refusals, rate limits and outages', () => {
    expect(explainWalletError(new ApiError(401, { error: 'bad signature' })).next).toMatch(/Sign in again/);
    expect(explainWalletError(new ApiError(403, { error: 'not available' })).next).toMatch(/not available where you live/);
    expect(explainWalletError(new ApiError(429, {})).text).toMatch(/Too many requests/);
    expect(explainWalletError(new ApiError(502, {})).next).toMatch(/Nothing was signed/);
  });
  it('keeps an unknown error’s own first line', () => {
    expect(walletErrorText(new Error('Insufficient margin to place order.\nstack…'))).toBe('Insufficient margin to place order.');
  });
  it('joins text and next step for one-line messages', () => {
    expect(walletErrorText(rpc(4001, 'denied'))).toBe('You declined in your wallet. Nothing was signed. Try again when you’re ready.');
  });
});

describe('split (signature for Hyperliquid)', () => {
  const r = 'a'.repeat(64);
  const s = '1'.repeat(64);
  it('keeps v as 27 or 28', () => {
    expect(split(`0x${r}${s}1b`)).toEqual({ r: `0x${r}`, s: `0x${s}`, v: 27 });
    expect(split(`0x${r}${s}1c`)).toEqual({ r: `0x${r}`, s: `0x${s}`, v: 28 });
  });
  it('turns v as 0 or 1 into 27 or 28', () => {
    expect(split(`0x${r}${s}00`).v).toBe(27);
    expect(split(`0x${r}${s}01`).v).toBe(28);
  });
  it('expands the 64-byte compact form (EIP-2098)', () => {
    // yParity 1 is the top bit of vs.
    const vs = (BigInt(`0x${s}`) | (1n << 255n)).toString(16);
    expect(split(`0x${r}${vs}`)).toEqual({ r: `0x${r}`, s: `0x${s}`, v: 28 });
    expect(split(`0x${r}${s}`)).toEqual({ r: `0x${r}`, s: `0x${s}`, v: 27 });
  });
  it('refuses a contract wallet’s signature (ERC-6492 or other lengths)', () => {
    expect(() => split(`0x${'ab'.repeat(200)}`)).toThrow(/smart-contract wallet/);
  });
});
