'use client';

import { wipeConsequences, type Custody, type WipeStep } from '@/lib/wipe';

/**
 * The confirmation step before wiping the guard key: what is destroyed, what happens first, and that it
 * cannot be undone. The button stays disabled until the user ticks that they understand.
 */
export function WipeConfirm({ custody, ack, onAck, busy, onConfirm, onCancel }: { custody: Custody; ack: boolean; onAck: (v: boolean) => void; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="banner b-crit col" role="alertdialog" aria-labelledby="wipe-h" style={{ alignItems: 'stretch', gap: 8 }}>
      <b id="wipe-h">Wipe your guard key?</b>
      <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {wipeConsequences(custody).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      <label className="row nw small" style={{ gap: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} />
        <span>I understand the guard stops and the key cannot be recovered.</span>
      </label>
      <div className="row">
        <button type="button" className="btn btn-crit" disabled={!ack || busy} onClick={onConfirm}>
          {busy ? 'Waiting for signature…' : 'Sign and wipe my guard key'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>
          Keep my key
        </button>
      </div>
    </div>
  );
}

/** What the API has reported so far, in its own words. */
export function WipeProgress({ steps, done, timedOut }: { steps: WipeStep[]; done: boolean; timedOut: boolean }) {
  const accepted = steps.find((s) => s.step === 'accepted');
  const cancelled = steps.find((s) => s.step === 'cancelled');
  const wiped = steps.find((s) => s.step === 'wiped');
  const retired = steps.find((s) => s.step === 'retired');
  return (
    <div className="col small" role="status" style={{ gap: 4 }}>
      {accepted ? <span>Wipe command accepted{accepted.id !== null ? ` (#${accepted.id})` : ''}. The guard is stopped.</span> : null}
      {cancelled && 'text' in cancelled ? <span>{cancelled.text}.</span> : wiped ? <span className="t2">No cancellation was logged: the guard had no resting orders to cancel.</span> : null}
      {wiped && 'text' in wiped ? <span>{wiped.text}.</span> : null}
      {retired && 'text' in retired ? <span>{retired.text}.</span> : null}
      {!done && !timedOut && accepted ? <span className="t2">Waiting for the guard to finish…</span> : null}
      {timedOut && !done ? <span className="ct">The guard hasn’t confirmed the wipe yet. It is stopped either way; check the audit log in a minute.</span> : null}
    </div>
  );
}
