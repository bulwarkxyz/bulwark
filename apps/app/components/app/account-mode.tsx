'use client';

import { accountModeOf } from '@bulwarkxyz/guard-core';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { ABSTRACTION, MODE_LINE, MODE_NAME, modeChange, type Switchable } from '@/lib/account-mode';
import { NETWORK } from '@/lib/env';
import { info, useAccountView } from '@/lib/hl';
import { useViewer } from '@/lib/review';
import { sendUserSigned, setAbstractionFor, type SignTypedData } from '@/lib/signing';
import { useWalletChainId } from '@/lib/wallet';
import { walletErrorText } from '@/lib/wallet-errors';

/**
 * Account mode (standard ↔ unified), switched with Hyperliquid's user-signed userSetAbstraction from the
 * user's own wallet. Offered only with no open positions: Hyperliquid doesn't say when a switch is allowed,
 * and a switch under open positions would move every buffer at once. Before signing, the panel says what
 * changes for margin and for the guard; after, it reads the mode back from Hyperliquid.
 */
export function AccountModePanel() {
  const { address: viewer } = useViewer();
  const { address: wallet } = useAccount();
  const view = useAccountView(viewer);
  const qc = useQueryClient();
  const chainId = useWalletChainId();
  const { signTypedDataAsync } = useSignTypedData();
  const [target, setTarget] = useState<Switchable | null>(null);
  const [step, setStep] = useState<'idle' | 'signing' | 'checking'>('idle');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const current = view.data ? accountModeOf(view.data.abstraction) : null;
  const positions = view.data ? view.data.risk.pools.reduce((n, p) => n + p.positions.length, 0) : null;
  const ownWallet = Boolean(wallet && viewer && wallet.toLowerCase() === viewer.toLowerCase());
  const change = current && target && target !== current ? modeChange(current, target) : null;

  async function sw() {
    if (!wallet || !target) return;
    setMsg(null);
    setStep('signing');
    try {
      const res = await sendUserSigned(signTypedDataAsync as unknown as SignTypedData, setAbstractionFor(chainId, wallet.toLowerCase() as Hex, ABSTRACTION[target]));
      if (!res.ok) throw new Error(res.error);
      setStep('checking');
      const now = accountModeOf(await info.userAbstraction(wallet.toLowerCase() as Hex));
      await qc.invalidateQueries({ queryKey: ['account'] });
      setMsg(now === target ? { ok: true, text: `Hyperliquid now reports a ${MODE_NAME[now].toLowerCase()}.` } : { ok: false, text: `Hyperliquid accepted the request but still reports ${MODE_NAME[now].toLowerCase()}. Check again in a moment.` });
      setTarget(null);
    } catch (e) {
      setMsg({ ok: false, text: walletErrorText(e) });
    } finally {
      setStep('idle');
    }
  }

  return (
    <section className="panel" id="account-mode" aria-labelledby="mode-h">
      <div className="ph">
        <h2 id="mode-h">Account mode</h2>
        {NETWORK === 'testnet' ? <span className="tag tag-net">testnet</span> : null}
      </div>
      <div className="pb col" style={{ gap: 10 }}>
        {view.isLoading || !current ? (
          view.isError ? <span className="small ct">Can’t read your account from Hyperliquid: {(view.error as Error).message}</span> : <span className="sk" style={{ width: '70%' }} />
        ) : (
          <>
            <div className="kv line">
              <span className="small">Now</span>
              <span className="small b">{MODE_NAME[current]}</span>
            </div>
            <span className="small t2">{MODE_LINE[current]}</span>
            {positions ? (
              <span className="small t2">
                Close your {positions} open position{positions > 1 ? 's' : ''} to change the mode. Bulwark offers the switch only with nothing open: Hyperliquid doesn’t say when it’s allowed, and a switch would move every buffer at once.
              </span>
            ) : !ownWallet ? (
              <span className="small t2">Connect the wallet that owns this account to change its mode.</span>
            ) : (
              <>
                <div className="seg" role="radiogroup" aria-label="Account mode">
                  {(['standard', 'unified'] as const).map((m) => {
                    const on = (target ?? current) === m;
                    return (
                      <button key={m} type="button" role="radio" aria-checked={on} className={on ? 'on' : ''} disabled={step !== 'idle'} onClick={() => setTarget(m === current ? null : m)}>
                        {m === 'standard' ? 'Standard' : 'Unified'}
                      </button>
                    );
                  })}
                </div>
                {change && target ? (
                  <div className="col" style={{ gap: 8 }}>
                    <b className="small">What changes</b>
                    <div className="col" style={{ gap: 4 }}>
                      <span className="tiny t3">Your margin</span>
                      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                        {change.margin.map((l) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="col" style={{ gap: 4 }}>
                      <span className="tiny t3">The guard</span>
                      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                        {change.guard.map((l) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
                    </div>
                    <span className="tiny t3">Signed in your wallet as a Hyperliquid account setting, not a transfer: nothing leaves your account. You can switch back the same way.</span>
                    <div className="row" style={{ gap: 8 }}>
                      <button type="button" className="btn btn-sm btn-ink" disabled={step !== 'idle'} onClick={sw}>
                        {step === 'signing' ? 'Waiting for your signature…' : step === 'checking' ? 'Checking with Hyperliquid…' : `Sign and switch to ${target}`}
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" disabled={step !== 'idle'} onClick={() => setTarget(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
            {msg ? (
              <span role={msg.ok ? 'status' : 'alert'} className={`small ${msg.ok ? '' : 'ct'}`}>
                {msg.text}
              </span>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
