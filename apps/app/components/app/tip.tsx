'use client';

import { useId, useRef, useState } from 'react';
import { InLayer } from './layer';

/**
 * A tooltip in the design's own style, in the top layer, instead of the browser's native `title` box.
 * Shows on hover and on keyboard focus, after a short pause, with no motion; read by screen readers
 * through aria-describedby. Never the only place a fact is shown.
 */
export function Tip({ text, children, className }: { text: string; children: React.ReactNode; className?: string }) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const below = r.top < 48;
      setAt({ x: Math.min(Math.max(8, r.left + r.width / 2), window.innerWidth - 8), y: below ? r.bottom + 6 : r.top - 6, below });
    }, 350);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setAt(null);
  };
  return (
    <span ref={ref} className={className} aria-describedby={id} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      <span id={id} hidden>
        {text}
      </span>
      {at ? (
        <InLayer>
          <span className="tip" role="tooltip" style={{ left: at.x, top: at.y, transform: `translate(-50%, ${at.below ? '0' : '-100%'})` }}>
            {text}
          </span>
        </InLayer>
      ) : null}
    </span>
  );
}
