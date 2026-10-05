'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icons';
import { InLayer, isPhoneWidth, useAnchored, useOutside } from './layer';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A second line, where it helps the choice. */
  description?: string;
  disabled?: boolean;
}

/**
 * The app's one select, used everywhere a native <select> was: a button that opens a listbox in the top
 * layer (a bottom sheet on phones). Keyboard: arrows, Home/End, type-ahead, Enter or Space to choose,
 * Escape or Tab to close; focus goes back to the trigger. The chosen item is marked with a check and
 * weight, never lime. Opens and closes instantly (no motion).
 */
export function Select<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  placeholder,
  className,
  compact,
}: {
  id?: string;
  /** Read by screen readers as the field's name; the visible label (if any) should use htmlFor={id}. */
  label: string;
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (v: T) => void;
  placeholder?: string;
  className?: string;
  /** A small trigger (toolbars), without the field frame. */
  compact?: boolean;
}) {
  const auto = useId();
  const triggerId = id ?? `sel-${auto}`;
  const listId = `${triggerId}-list`;
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(false);
  const [active, setActive] = useState(0);
  // The active option is outlined only while the keyboard is in use (no ring for mouse or touch).
  const [kb, setKb] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const pos = useAnchored(trigger, open && !phone, { width: 'anchor', maxHeight: 340 });
  const current = options.find((o) => o.value === value);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  const show = () => {
    setPhone(isPhoneWidth());
    const i = options.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : (enabled[0] ?? 0));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
  };
  useOutside([trigger, list], open, () => close(false));
  // Keep the active option in view, and keyboard focus on the list while open.
  useEffect(() => {
    if (!open) return;
    list.current?.focus({ preventScroll: true });
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const step = (d: 1 | -1) => {
    const at = enabled.indexOf(active);
    const next = enabled[Math.min(enabled.length - 1, Math.max(0, (at === -1 ? 0 : at) + d))];
    if (next !== undefined) setActive(next);
  };
  const onListKey = (e: React.KeyboardEvent) => {
    setKb(true);
    if (e.key === 'ArrowDown') (e.preventDefault(), step(1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), step(-1));
    else if (e.key === 'Home') (e.preventDefault(), setActive(enabled[0] ?? 0));
    else if (e.key === 'End') (e.preventDefault(), setActive(enabled[enabled.length - 1] ?? 0));
    else if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), choose(active));
    else if (e.key === 'Escape') (e.preventDefault(), close());
    else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      // Type-ahead: letters typed within 600 ms build a prefix.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : '') + e.key.toLowerCase(), at: now };
      const hit = enabled.find((i) => options[i]!.label.toLowerCase().startsWith(typed.current.text));
      if (hit !== undefined) setActive(hit);
    }
  };
  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') setKb(true);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      show();
    }
  };

  const listbox = (
    <ul
      ref={list}
      id={listId}
      role="listbox"
      tabIndex={-1}
      aria-label={label}
      aria-activedescendant={`${listId}-${active}`}
      className={`sel-list ${kb ? 'kb' : ''}`}
      onKeyDown={onListKey}
      onPointerMove={() => setKb(false)}
      style={phone || !pos ? undefined : { top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight, transform: pos.above ? 'translateY(-100%)' : undefined }}
    >
      {options.map((o, i) => (
        <li
          key={o.value}
          id={`${listId}-${i}`}
          data-i={i}
          role="option"
          aria-selected={o.value === value}
          aria-disabled={o.disabled || undefined}
          className={`${i === active ? 'act' : ''} ${o.value === value ? 'chosen' : ''} ${o.disabled ? 'dis' : ''}`}
          onPointerMove={() => !o.disabled && setActive(i)}
          onClick={() => choose(i)}
        >
          <span className="col" style={{ gap: 1, minWidth: 0 }}>
            <span className="lab">{o.label}</span>
            {o.description ? <span className="desc">{o.description}</span> : null}
          </span>
          <span className="mark" aria-hidden>
            {o.value === value ? Icon.check(14) : null}
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        className={`xsel ${compact ? 'xsel-compact' : ''} ${className ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current?.label ?? placeholder ?? 'none'}`}
        onClick={() => {
          setKb(false);
          if (open) close();
          else show();
        }}
        onKeyDown={onTriggerKey}
      >
        <span className={`v ${current ? '' : 't3'}`}>{current?.label ?? placeholder ?? 'Choose'}</span>
        {Icon.caret()}
      </button>
      {open ? (
        <InLayer>
          {phone ? (
            <>
              <div className="sel-scrim" onClick={() => close()} />
              <div className="sel-sheet" role="dialog" aria-label={label}>
                <div className="grab" />
                <b className="small" style={{ padding: '0 6px 8px' }}>
                  {label}
                </b>
                {listbox}
              </div>
            </>
          ) : (
            listbox
          )}
        </InLayer>
      ) : null}
    </>
  );
}
