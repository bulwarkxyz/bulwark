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
import { wipeGuardKey, type WipeStep } from '@/lib/wipe';
import type { AuditEntry } from '@bulwarkxyz/store/audit';
import { WipeConfirm, WipeProgress } from './wipe-confirm';
import { approveAgentFor, approveBuilderFor, forgetTradingKey, sendUserSigned, tradingKey, type SignTypedData } from '@/lib/signing';
import { shortAddr } from './format';
import { Icon } from './icons';
import { useTimes } from '@/lib/time';

type Msg = { ok: boolean; text: string } | null;

function Status({ msg }: { msg: Msg }) {
  return msg ? (
    <span className={msg.ok ? '' : 'err'} style={{ fontSize: 13 }}>
      {msg.text}
    </span>
  ) : null;
}

/**
 * How a key or fee card is drawn: a panel of its own (Settings), or bare content inside a setup step,
 * so a step never nests a panel in a panel.
 */
export type CardVariant = 'card' | 'bare';
function Frame({ variant, id, title, chip, chipCls, children }: { variant: CardVariant; id: string; title: string; chip?: React.ReactNode; chipCls?: string; children: React.ReactNode }) {
  if (variant === 'bare')
    return (
      <div className="col" style={{ gap: 10 }} aria-label={title}>
        {chip ? <span className={`chip chip-sm ${chipCls ?? ''}`} style={{ alignSelf: 'flex-start' }}>{chip}</span> : null}
        {children}
      </div>
    );
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="ph">
        <h2 id={id}>{title}</h2>
        <span className="sp" />
        {chip ? <span className={`chip chip-sm ${chipCls ?? ''}`}>{chip}</span> : null}
      </div>
      <div className="pb col" style={{ gap: 10 }}>
        {children}
      </div>
    </section>
  );
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
 * The guard key, one per user, approved by the user as a named agent on Hyperliquid. What the app says
 * about it follows where this user's key actually lives (`keyCustody` from /v1/me), or, before a key
 * exists, where a new one would be made (`newKeyCustody`). Wording from apps/docs key-storage.mdx.
 */
export const KEY_STORAGE = {
  kms: 'AWS KMS, hardware-backed',
  sealed: 'Encrypted on Bulwark’s server',
} as const;
export const KEY_TEXT = {
  kms: 'A non-exportable key in AWS KMS, held in hardware security modules. Its private key never leaves KMS: Bulwark never sees it, and no one can copy it. If Bulwark’s signing service were compromised, an attacker could ask KMS to sign trades on your account for as long as they controlled the service. They could not copy the key, and they could not withdraw your funds.',
  sealed: 'An encrypted key (AES-256-GCM) on Bulwark’s signing service. It is not hardware-backed: if that server and its master key were compromised, the key itself could be copied and used to place trades. It still could not withdraw.',
} as const;
/** The custody to describe: this user's key if there is one, else where a new key would be made. */
export function shownCustody(me: Me | null | undefined): 'sealed' | 'kms' | null {
  if (!me) return null;
  return me.agent || me.keyStatus === 'ready' ? me.keyCustody : (me.newKeyCustody ?? me.keyCustody);
}

export function GuardKeyCard({ variant = 'card', setup = false }: { variant?: CardVariant; setup?: boolean } = {}) {
  // `setup`: inside the setup step, which explains the key itself; replacing and wiping live in Settings.
  const me = useMe();
  const qc = useQueryClient();
  const { chainId, sign } = useWalletSigner();
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const agent = me.data?.agent;
  const pending = me.data?.pendingAgent ?? null;
  const times = useTimes();
  const region = me.data?.user?.region;
  const [confirmReplace, setConfirmReplace] = useState(false);
  const command = useCommand();
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeAck, setWipeAck] = useState(false);
  const [wipeSteps, setWipeSteps] = useState<WipeStep[]>([]);
  const [wipeEnd, setWipeEnd] = useState<null | { done: boolean }>(null);

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

  async function replace() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ status: 'creating' | 'pending'; pendingAgent?: { address: Hex } }>('/v1/guard-key/rotate', { method: 'POST', body: {} });
      if (r.status === 'creating') {
        setMsg({ ok: true, text: 'Creating your new guard key…' });
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          const fresh = await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api<Me>('/v1/me'), staleTime: 0 });
          if (fresh?.pendingAgent) break;
        }
        setMsg(null);
      }
      setConfirmReplace(false);
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function approvePending() {
    if (!pending) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await sendUserSigned(sign, approveAgentFor(chainId, pending.address, 'bulwark-guard', validUntil(days)));
      if (!res.ok) throw new Error(res.error);
      setMsg({ ok: true, text: 'New guard key approved. It takes over and the old key stops signing.' });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function wipe() {
    setBusy(true);
    setMsg(null);
    setWipeSteps([]);
    setWipeEnd(null);
    try {
      const out = await wipeGuardKey(
        {
          send: () => command('wipe'),
          me: () => qc.fetchQuery({ queryKey: ['me'], queryFn: () => api<Me>('/v1/me'), staleTime: 0 }),
          audit: () => api<AuditEntry[]>('/v1/audit?limit=20'),
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
        (st) => setWipeSteps((prev) => [...prev, st]),
      );
      setWipeEnd({ done: out.done });
      setWipeOpen(false);
      setWipeAck(false);
      await qc.invalidateQueries();
    } catch (e) {
      setMsg({ ok: false, text: `The wipe was not sent: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  const custody = shownCustody(me.data);
  const days_ = (
    <div className="field">
      <label htmlFor="gk-days">Approval lasts (days, leave empty for no expiry)</label>
      <div className="input">
        <input id="gk-days" inputMode="numeric" placeholder="Your number" value={days} onChange={(e) => setDays(e.target.value)} />
        <span className="unit">days</span>
      </div>
    </div>
  );
  return (
    <Frame variant={variant} id="gk-h" title="Guard key" chip={guardKeyStatus(me.data)}>
        {custody ? (
          <div className="kv line">
            <span className="small">{agent ? 'Key storage' : 'Your key will be stored in'}</span>
            <span className="small">
              <b>{KEY_STORAGE[custody]}</b>
            </span>
          </div>
        ) : null}
        <span className="small t2">{custody ? KEY_TEXT[custody] : 'Sign in to see where your guard key is stored.'}</span>
        {setup ? null : <span className="small t2">Hyperliquid lets the key trade for you but never withdraw. Reduce-only is our engine’s limit, not Hyperliquid’s: every order is re-checked against your rules before it is signed.</span>}
        {region === 'guardOff' ? <div className="banner b-warn">In your region the guard is off: trading and alerts only.</div> : null}
        {me.data?.keyStatus === 'wiped' && !wipeSteps.length ? (
          <div className="banner">
            <span>
              <b>Your guard key was wiped.</b> The guard is stopped. To use it again, create a new key, approve it on Hyperliquid, then resume the guard.
            </span>
          </div>
        ) : null}
        {agent ? (
          <div className="kv">
            <span>Address</span>
            <span className="num">{shortAddr(agent.address)}</span>
          </div>
        ) : null}
        {agent?.validUntil ? (
          <div className="kv">
            <span>Valid until</span>
            <span className="num">{times.fmt(agent.validUntil, 'date')}</span>
          </div>
        ) : null}
        {agent && me.data?.keyCustody === 'sealed' && me.data.newKeyCustody === 'kms' && !pending ? (
          <div className="banner">
            <span>
              <b>Your key is an older encrypted key.</b> New keys are made in AWS KMS. To move to a KMS key, replace your key.
            </span>
          </div>
        ) : null}
        {!agent ? (
          <button type="button" className="btn" disabled={busy || !me.data?.user || region !== 'allowed' || me.data?.keyStatus === 'creating'} onClick={create}>
            {busy ? 'Creating…' : 'Create my guard key'}
          </button>
        ) : !agent.approved ? (
          <>
            {days_}
            <button type="button" className="btn btn-ink" disabled={busy} onClick={approve}>
              {busy ? 'Waiting for signature…' : 'Approve guard key'}
            </button>
          </>
        ) : pending ? (
          <>
            <div className="kv">
              <span>New key</span>
              <span className="num">{shortAddr(pending.address)}</span>
            </div>
            <span className="small t2">It takes over once you approve it on Hyperliquid. The old key then stops signing at once.</span>
            {days_}
            <button type="button" className="btn btn-ink" disabled={busy} onClick={approvePending}>
              {busy ? 'Waiting for signature…' : 'Approve the new key'}
            </button>
          </>
        ) : setup ? null : confirmReplace ? (
          <div className="col" style={{ gap: 8 }}>
            <span className="small">
              A new key is made {me.data?.newKeyCustody === 'kms' ? 'in AWS KMS' : 'on Bulwark’s signing service'}. Your current key keeps working until you approve the new one.
            </span>
            <div className="row">
              <button type="button" className="btn btn-ink" disabled={busy} onClick={replace}>
                {busy ? 'Creating…' : 'Make the new key'}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirmReplace(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirmReplace(true)}>
            Replace my guard key
          </button>
        )}
        {wipeSteps.length ? <WipeProgress steps={wipeSteps} done={Boolean(wipeEnd?.done)} timedOut={Boolean(wipeEnd && !wipeEnd.done)} /> : null}
        {agent && !wipeSteps.length && !setup ? (
          wipeOpen && custody ? (
            <WipeConfirm custody={me.data?.keyCustody ?? custody} ack={wipeAck} onAck={setWipeAck} busy={busy} onConfirm={wipe} onCancel={() => { setWipeOpen(false); setWipeAck(false); }} />
          ) : (
            <button type="button" className="btn btn-ghost ct" disabled={busy} onClick={() => setWipeOpen(true)} style={{ alignSelf: 'flex-start' }}>
              Wipe my guard key…
            </button>
          )
        ) : null}
        <Status msg={msg} />
    </Frame>
  );
}

export function guardKeyStatus(m: Me | null | undefined): string {
  if (!m) return 'Not signed in';
  if (m.pendingAgent) return 'Replacement waiting for approval';
  if (m.agent?.approved) return 'Approved';
  if (m.agent) return 'Created, not approved';
  return m.keyStatus === 'creating' ? 'Being created' : m.keyStatus === 'wiped' ? 'Wiped' : 'Not created';
}

/** The browser trading key for the user's own manual orders. */
export function TradingKeyCard({ variant = 'card' }: { variant?: CardVariant } = {}) {
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
    <Frame variant={variant} id="tk-h" title="Trading key (this browser)" chip={approved ? 'Approved' : key ? 'Not approved' : 'None'}>
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
    </Frame>
  );
}

/** Builder-fee approval. Shown only when the builder code is switched on for this network (D6). */
export function BuilderCard({ variant = 'card' }: { variant?: CardVariant } = {}) {
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
    <Frame variant={variant} id="bf-h" title="Bulwark fee" chip={ok ? `Approved up to ${(approvedMax / 1000).toFixed(3)}%` : 'Not approved'}>
        <span className="small t2">
          Bulwark charges 3 bps (0.03%) on orders placed through it, through Hyperliquid's builder code. You approve a cap of {BUILDER_APPROVE_MAX_RATE} ({BUILDER_APPROVE_MAX_TENTHS_BPS / 10} bps) and can lower it to zero at any time. {NETWORK === 'testnet' ? 'This is testnet.' : ''}
        </span>
        {!ok ? (
          <button type="button" className="btn btn-ink" disabled={busy || !me.data} onClick={approve}>
            {busy ? 'Waiting for signature…' : `Approve fee cap ${BUILDER_APPROVE_MAX_RATE}`}
          </button>
        ) : null}
        <Status msg={msg} />
    </Frame>
  );
}

/** The kill switch. `preview` is for review builds only: shows the waiting or failed state without signing. */
export function KillSwitchCard({ preview }: { preview?: 'busy' | 'error' } = {}) {
  const me = useMe();
  const command = useCommand();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(preview === 'error' ? { ok: false, text: 'Your signature arrived 74 s after it was made; we accept 60 s at most. Sign again.' } : null);
  const [last, setLast] = useState<'stop' | 'resume'>('stop');
  const stopped = Boolean(me.data?.user?.killSwitch);
  const waiting = busy || preview === 'busy';
  const ready = Boolean(me.data?.user);
  async function run(c: 'stop' | 'resume') {
    setBusy(true);
    setMsg(null);
    setLast(c);
    try {
      await command(c);
      setMsg({ ok: true, text: c === 'stop' ? 'Guard stopped. Its resting orders are being cancelled.' : 'Guard resumed. It re-plans its backstops within 60 s.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const failed = msg && !msg.ok;
  const action = stopped ? 'resume' : 'stop';
  const button = (
    <button type="button" className={`btn btn-lg ${stopped ? 'btn-ink' : 'btn-crit'}`} disabled={waiting || !ready} onClick={() => run(action)}>
      {waiting ? 'Waiting for your signature…' : failed ? 'Sign again' : stopped ? 'Resume the guard' : 'Stop the guard'}
    </button>
  );
  return (
    <section className="panel" id="kill-switch" aria-labelledby="ks-h">
      <div className="ph">
        <h2 id="ks-h">Kill switch</h2>
        <span className="tiny t3">stops the guard for this account</span>
      </div>
      <div className="pb col" style={{ gap: 10 }}>
        {failed ? (
          <>
            <div className="banner b-crit" role="alert">
              {Icon.alert()}
              <span>
                <b>The guard was not {last === 'stop' ? 'stopped' : 'resumed'}.</b> {msg.text}
              </span>
            </div>
            <div className="row">
              {button}
              <span className="small t2">The guard is still {stopped ? 'stopped' : 'running'}.</span>
            </div>
          </>
        ) : (
          <div className="row nw ks-row">
            <div className="col" style={{ gap: 4, flex: 1, minWidth: 0 }}>
              {!ready ? (
                <span className="small t2">Finish setup to use the kill switch.</span>
              ) : stopped ? (
                <span className="small">
                  <b className="ct">The guard is stopped. Your positions are not protected.</b> It sends nothing and has cancelled its own resting orders. Resuming re-plans the backstops within 60 s.
                </span>
              ) : (
                <span className="small">
                  <b>The guard is running.</b> Stopping it takes effect at once. The guard cancels only its own resting orders. Your positions and your own orders stay as they are, with no protection until you resume.
                </span>
              )}
              <span className="tiny t3">{waiting ? 'Confirm in your wallet. Nothing has changed yet.' : `You sign the ${action} in your wallet. The signature is valid for 60 seconds.`}</span>
              {msg?.ok ? <span className="small">{msg.text}</span> : null}
            </div>
            {button}
          </div>
        )}
      </div>
    </section>
  );
}
