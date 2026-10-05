'use client';

import { BUILDER_ADDRESS, BUILDER_APPROVE_MAX_RATE, BUILDER_APPROVE_MAX_TENTHS_BPS, BUILDER_FEE_TENTHS_BPS } from '@bulwarkxyz/config';
import type { Hex } from '@bulwarkxyz/hyperliquid';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccount, useChainId, useSignTypedData } from 'wagmi';
import { api } from '@/lib/api';
import { useCommand } from '@/lib/commands';
import { BUILDER_ON, NETWORK } from '@/lib/env';
import { info } from '@/lib/hl';
import { useMe, type Me } from '@/lib/me';
import { approveAgentFor, approveBuilderFor, forgetTradingKey, sendUserSigned, tradingKey, type SignTypedData } from '@/lib/signing';
import { shortAddr } from './format';

type Msg = { ok: boolean; text: string } | null;

function Status({ msg }: { msg: Msg }) {
  return msg ? (
    <span className={msg.ok ? '' : 'err'} style={{ fontSize: 13 }}>
      {msg.text}
    </span>
  ) : null;
}

/** Days typed by the user → validUntil in ms, or undefined for no expiry. */
function validUntil(days: string): number | undefined {
  const d = Number(days);
  return days.trim() && d > 0 ? Date.now() + Math.round(d * 86_400_000) : undefined;
}

function useWalletSigner() {
  const chainId = useChainId();
  const { signTypedDataAsync } = useSignTypedData();
  return { chainId, sign: signTypedDataAsync as unknown as SignTypedData };
}

/**
 * The guard key, one per user, approved by the user as a named agent on Hyperliquid. Its description
 * follows where the key actually lives (the API reports `keyCustody`), so the app never overstates it.
 */
export const KEY_TEXT = {
  sealed:
    'A key made for you on Bulwark’s server and stored there encrypted (AES-256-GCM). Hyperliquid lets it trade for you but never withdraw. If our server were compromised, someone could place trades with it, but could not withdraw your funds. Bulwark only signs reduce-only orders and moves of your own margin with it, after re-checking every rule. Hardware-backed key storage is planned.',
  kms: 'A key held in AWS KMS, created for you and never exported. Hyperliquid lets it trade for you but never withdraw. Bulwark only signs reduce-only orders and moves of your own margin with it, after re-checking every rule.',
} as const;

export function GuardKeyCard() {
  const me = useMe();
  const qc = useQueryClient();
  const { chainId, sign } = useWalletSigner();
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const agent = me.data?.agent;
  const region = me.data?.user?.region;

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ agentAddress?: Hex; status?: 'creating' }>('/v1/onboarding/agent', { method: 'POST', body: {} });
      if (r.status === 'creating') {
        // The signing service makes the key within a few seconds; poll until it appears.
        setMsg({ ok: true, text: 'Creating your guard key…' });
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          const fresh = await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api<Me>('/v1/me'), staleTime: 0 });
          if (fresh?.agent) break;
        }
        setMsg(null);
      }
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!agent) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await sendUserSigned(sign, approveAgentFor(chainId, agent.address, 'bulwark-guard', validUntil(days)));
      if (!res.ok) throw new Error(res.error);
      setMsg({ ok: true, text: 'Guard key approved on Hyperliquid.' });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="gk-h">
      <div className="ph">
        <h2 id="gk-h">Guard key</h2>
        <span className="chip chip-sm" style={{ marginLeft: 'auto' }}>
          {agent?.approved ? 'Approved' : agent ? 'Created, not approved' : 'Not created'}
        </span>
      </div>
      <div className="pb col" style={{ gap: 10 }}>
        <span className="small t2">
          {KEY_TEXT[me.data?.keyCustody ?? 'sealed']}
        </span>
        {region === 'guardOff' ? <div className="banner b-warn">In your region the guard is off: trading and alerts only.</div> : null}
        {agent ? (
          <div className="kv">
            <span>Address</span>
            <span className="num">{shortAddr(agent.address)}</span>
          </div>
        ) : null}
        {agent?.validUntil ? (
          <div className="kv">
            <span>Valid until</span>
            <span className="num">{new Date(agent.validUntil).toISOString().slice(0, 10)}</span>
          </div>
        ) : null}
        {!agent ? (
          <button type="button" className="btn" disabled={busy || !me.data?.user || region !== 'allowed'} onClick={create}>
            {busy ? 'Creating…' : 'Create my guard key'}
          </button>
        ) : !agent.approved ? (
          <>
            <div className="field">
              <label htmlFor="gk-days">Approval lasts (days, leave empty for no expiry)</label>
              <div className="input">
                <input id="gk-days" inputMode="numeric" placeholder="Your number" value={days} onChange={(e) => setDays(e.target.value)} />
                <span className="unit">days</span>
              </div>
            </div>
            <button type="button" className="btn btn-ink" disabled={busy} onClick={approve}>
              {busy ? 'Waiting for signature…' : 'Approve guard key'}
            </button>
          </>
        ) : null}
        <Status msg={msg} />
      </div>
    </section>
  );
}

/** The browser trading key for the user's own manual orders. */
export function TradingKeyCard() {
  const { address } = useAccount();
  const { chainId, sign } = useWalletSigner();
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [, bump] = useState(0);
  const key = address ? tradingKey(address) : null;
  const agents = useQuery({
    queryKey: ['agents', NETWORK, address],
    enabled: Boolean(address),
    queryFn: () => info.extraAgents(address as Hex) as Promise<Array<{ address: string }>>,
  });
  const approved = Boolean(key && agents.data?.some((a) => a.address.toLowerCase() === key.address));

  async function approve() {
    if (!address) return;
    setBusy(true);
    setMsg(null);
    try {
      const k = tradingKey(address, true)!;
      const res = await sendUserSigned(sign, approveAgentFor(chainId, k.address, 'bulwark-web', validUntil(days)));
      if (!res.ok) throw new Error(res.error);
      await agents.refetch();
      setMsg({ ok: true, text: 'Trading key approved. Orders from the ticket no longer need a wallet prompt.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="tk-h">
      <div className="ph">
        <h2 id="tk-h">Trading key (this browser)</h2>
        <span className="chip chip-sm" style={{ marginLeft: 'auto' }}>
          {approved ? 'Approved' : key ? 'Not approved' : 'None'}
        </span>
      </div>
      <div className="pb col" style={{ gap: 10 }}>
        <span className="small t2">
          A key made in this browser and kept here, so your own orders are signed without a wallet prompt each time. Like every Hyperliquid agent it cannot withdraw.
        </span>
        {key ? (
          <div className="kv">
            <span>Address</span>
            <span className="num">{shortAddr(key.address)}</span>
          </div>
        ) : null}
        {!approved ? (
          <>
            <div className="field">
              <label htmlFor="tk-days">Approval lasts (days, leave empty for no expiry)</label>
              <div className="input">
                <input id="tk-days" inputMode="numeric" placeholder="Your number" value={days} onChange={(e) => setDays(e.target.value)} />
                <span className="unit">days</span>
              </div>
            </div>
            <button type="button" className="btn btn-ink" disabled={busy || !address} onClick={approve}>
              {busy ? 'Waiting for signature…' : key ? 'Approve trading key' : 'Create and approve'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              if (address) forgetTradingKey(address);
              bump((n) => n + 1);
            }}
          >
            Forget this key in this browser
          </button>
        )}
        <Status msg={msg} />
      </div>
    </section>
  );
}

/** Builder-fee approval. Shown only when the builder code is switched on for this network (D6). */
export function BuilderCard() {
  const me = useMe();
  const qc = useQueryClient();
  const { chainId, sign } = useWalletSigner();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  if (!BUILDER_ON) return null;
  const approvedMax = me.data?.builder.approvedMaxTenthsBps ?? 0;
  const ok = approvedMax >= BUILDER_FEE_TENTHS_BPS;

  async function approve() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await sendUserSigned(sign, approveBuilderFor(chainId, BUILDER_ADDRESS, BUILDER_APPROVE_MAX_RATE));
      if (!res.ok) throw new Error(res.error);
      setMsg({ ok: true, text: 'Fee approved.' });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="bf-h">
      <div className="ph">
        <h2 id="bf-h">Bulwark fee</h2>
        <span className="chip chip-sm" style={{ marginLeft: 'auto' }}>
          {ok ? `Approved up to ${(approvedMax / 1000).toFixed(3)}%` : 'Not approved'}
        </span>
      </div>
      <div className="pb col" style={{ gap: 10 }}>
        <span className="small t2">
          Bulwark charges 3 bps (0.03%) on orders placed through it, through Hyperliquid's builder code. You approve a cap of {BUILDER_APPROVE_MAX_RATE} ({BUILDER_APPROVE_MAX_TENTHS_BPS / 10} bps) and can lower it to zero at any time. {NETWORK === 'testnet' ? 'This is testnet.' : ''}
        </span>
        {!ok ? (
          <button type="button" className="btn btn-ink" disabled={busy || !me.data} onClick={approve}>
            {busy ? 'Waiting for signature…' : `Approve fee cap ${BUILDER_APPROVE_MAX_RATE}`}
          </button>
        ) : null}
        <Status msg={msg} />
      </div>
    </section>
  );
}

export function TelegramCard() {
  const me = useMe();
  const [code, setCode] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const linked = Boolean(me.data?.user?.telegramChatId);
  return (
    <section className="panel" aria-labelledby="tg-h">
      <div className="ph">
        <h2 id="tg-h">Telegram alerts</h2>
        <span className="chip chip-sm" style={{ marginLeft: 'auto' }}>
          {linked ? 'Linked' : 'Not linked'}
        </span>
      </div>
      <div className="pb col" style={{ gap: 10 }}>
        <span className="small t2">
          Every guard action and alert is sent to Telegram. Get a one-time code, then send <span className="num">/link CODE</span> to the Bulwark bot.
        </span>
        {code ? (
          <div className="code">
            <b>/link {code}</b> <span className="t3">· valid 15 minutes</span>
          </div>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={!me.data?.user}
          onClick={() =>
            api<{ code: string }>('/v1/telegram/code', { method: 'POST', body: {} })
              .then((r) => setCode(r.code))
              .catch((e: Error) => setMsg({ ok: false, text: e.message }))
          }
        >
          {linked ? 'Link another chat' : 'Get a link code'}
        </button>
        <Status msg={msg} />
      </div>
    </section>
  );
}

/** The kill switch. `preview` is for review builds only: shows the waiting or failed state without signing. */
export function KillSwitchCard({ preview }: { preview?: 'busy' | 'error' } = {}) {
  const me = useMe();
  const command = useCommand();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(preview === 'error' ? { ok: false, text: 'The guard was not stopped: the signature arrived after it expired (commands are valid for 60 s). Sign again.' } : null);
  const stopped = Boolean(me.data?.user?.killSwitch);
  const waiting = busy || preview === 'busy';
  async function run(c: 'stop' | 'resume') {
    setBusy(true);
    setMsg(null);
    try {
      await command(c);
      setMsg({ ok: true, text: c === 'stop' ? 'Guard stopped. Its resting orders are being cancelled.' : 'Guard resumed. It re-plans its backstops within 60 s.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" id="kill-switch" aria-labelledby="ks-h" style={{ borderColor: 'var(--line-2)' }}>
      <div className="ph">
        <h2 id="ks-h">Kill switch</h2>
        <span className="tiny t3">stops the guard for this account</span>
        <span className="sp" />
        <span className={`chip chip-sm ${me.data?.user && stopped ? 'chip-risk' : ''}`}>{!me.data?.user ? 'Not set up' : stopped ? 'Guard stopped' : 'Guard running'}</span>
      </div>
      <div className="pb col" style={{ gap: 10 }}>
        {stopped ? (
          <div className="banner b-crit">
            <span>
              <b>The guard is stopped. Your positions are not protected.</b> It sends nothing and has cancelled its own resting orders. Resuming re-plans the backstops within 60 s.
            </span>
          </div>
        ) : (
          <span className="small t2">
            Stopping takes effect at once: the guard sends nothing more and cancels only its own resting orders. Your positions and your own orders stay as they are, with no protection until you resume. You sign the command in your wallet; it is valid for 60 s.
          </span>
        )}
        <div className="row">
          <button type="button" className={`btn btn-lg ${stopped ? 'btn-ink' : 'btn-crit'}`} disabled={waiting || !me.data?.user} onClick={() => run(stopped ? 'resume' : 'stop')}>
            {waiting ? 'Waiting for your signature…' : stopped ? 'Resume the guard' : 'Stop the guard'}
          </button>
          {waiting ? <span className="small t2">Confirm in your wallet. Nothing has changed yet.</span> : null}
        </div>
        {msg ? <span className={`small ${msg.ok ? '' : 'ct'}`}>{msg.text}</span> : null}
      </div>
    </section>
  );
}
