// A browser wallet for local tests: a throwaway key generated for each run, announced to the page through
// EIP-6963 like a real extension, signing with viem. For localhost only: it holds no funds and is never
// used to sign in to a hosted API. installTestWallet(context, { name, reject }) returns its address.
import { createRequire } from 'node:module';

// viem is the app's dependency, not the workspace root's.
const require = createRequire(new URL('../apps/app/package.json', import.meta.url));
const { generatePrivateKey, privateKeyToAccount } = await import(require.resolve('viem/accounts'));

const ICON = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#5D6B7B"/><path d="M9 11h14v10H9z" fill="none" stroke="#fff" stroke-width="2"/></svg>').toString('base64')}`;

export async function installTestWallet(context, { name = 'Test Wallet', chainId = 42161, reject = () => false } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  let connected = false;
  await context.exposeFunction('__testWallet', async (method, params) => {
    if (reject(method)) return { error: { code: 4001, message: 'User rejected the request.' } };
    switch (method) {
      case 'eth_requestAccounts':
        connected = true;
        return { result: [account.address] };
      case 'eth_accounts':
        return { result: connected ? [account.address] : [] };
      case 'eth_chainId':
        return { result: `0x${chainId.toString(16)}` };
      case 'net_version':
        return { result: String(chainId) };
      case 'wallet_requestPermissions':
        connected = true;
        return { result: [{ parentCapability: 'eth_accounts' }] };
      case 'wallet_getPermissions':
        return { result: connected ? [{ parentCapability: 'eth_accounts' }] : [] };
      case 'wallet_revokePermissions':
        connected = false;
        return { result: null };
      case 'wallet_switchEthereumChain':
        chainId = Number.parseInt(params[0].chainId, 16);
        return { result: null };
      case 'personal_sign':
        return { result: await account.signMessage({ message: { raw: params[0] } }) };
      case 'eth_signTypedData_v4': {
        const t = JSON.parse(params[1]);
        const { EIP712Domain: _, ...types } = t.types;
        return { result: await account.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message: t.message }) };
      }
      default:
        return { error: { code: 4200, message: `Unsupported method ${method}` } };
    }
  });
  await context.addInitScript(
    ({ name, icon }) => {
      const listeners = {};
      const provider = {
        isTestWallet: true,
        async request({ method, params }) {
          const r = await window.__testWallet(method, params ?? []);
          if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
          return r.result;
        },
        on(e, fn) {
          (listeners[e] ??= []).push(fn);
        },
        removeListener(e, fn) {
          listeners[e] = (listeners[e] ?? []).filter((x) => x !== fn);
        },
      };
      const detail = Object.freeze({ info: { uuid: '7d3c2b8e-1111-4a5b-9c0d-000000000001', name, icon, rdns: 'local.bulwark.testwallet' }, provider });
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
    { name, icon: ICON },
  );
  return account.address;
}
