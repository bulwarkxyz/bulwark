'use client';

import type { CommandName } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { useQueryClient } from '@tanstack/react-query';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import { api } from './api';
import { signCommand, type SignTypedData } from './signing';

/** Signs a Bulwark command (stop, resume, unwind) in the user's wallet and sends it to the API. */
export function useCommand() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const qc = useQueryClient();
  return async (command: CommandName, minutes = 0) => {
    if (!address) throw new Error('connect a wallet first');
    const issuedAt = Date.now();
    const signature = await signCommand(signTypedDataAsync as unknown as SignTypedData, chainId, address.toLowerCase() as Hex, command, minutes, issuedAt);
    const res = await api<{ id: number | null; command: CommandName }>('/v1/commands', { body: { command, minutes, issuedAt, signature, chainId } });
    await qc.invalidateQueries({ queryKey: ['me'] });
    return res;
  };
}
