// Stands in for the Base smart-account and Coinbase smart-wallet SDKs (next.config.mjs resolveAlias).
// Hyperliquid accounts are ordinary addresses, so the app offers no smart-contract wallets; wagmi's
// connectors import these SDKs lazily, only when such a wallet is chosen, and none can be.
export {};
