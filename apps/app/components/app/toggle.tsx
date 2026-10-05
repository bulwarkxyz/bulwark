'use client';

/** An on/off switch in the design's tokens (ink when on, never lime): role="switch", Space or Enter toggles. */
export function Toggle({ id, checked, onChange, label, disabled }: { id?: string; checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="knob" />
    </button>
  );
}
