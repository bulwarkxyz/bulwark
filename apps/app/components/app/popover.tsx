'use client';

import { useEffect, useRef, useState } from 'react';
import { InLayer, isPhoneWidth, useAnchored, useOutside } from './layer';

/**
 * A panel opened from a header button (the bell, the wallet menu): anchored under its button in the top
 * layer on desktop, a bottom sheet on phones. Escape or a press outside closes it and focus goes back to
 * the button. No motion.
 */
export function Popover({
  anchor,
  open,
  onClose,
  label,
  width = 380,
  maxHeight = 560,
  children,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  label: string;
  width?: number;
  maxHeight?: number;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [phone, setPhone] = useState(false);
  const pos = useAnchored(anchor, open && !phone, { width, maxHeight });
  useOutside([anchor, box], open && !phone, onClose);
  useEffect(() => {
    if (!open) return;
    setPhone(isPhoneWidth());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
      anchor.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, anchor]);
  // Focus the panel itself when it opens, so the keyboard and screen readers land inside it.
  useEffect(() => {
    if (open) requestAnimationFrame(() => box.current?.focus());
  }, [open, phone]);
  if (!open) return null;
  if (phone)
    return (
      <InLayer>
        <div className="sel-scrim" onClick={onClose} />
        <div ref={box} className="pop pop-sheet" role="dialog" aria-label={label} tabIndex={-1}>
          <div className="grab" />
          {children}
        </div>
      </InLayer>
    );
  if (!pos) return null;
  return (
    <InLayer>
      <div ref={box} className="pop" role="dialog" aria-label={label} tabIndex={-1} style={{ top: pos.above ? undefined : pos.top, bottom: pos.above ? window.innerHeight - pos.top : undefined, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}>
        {children}
      </div>
    </InLayer>
  );
}
