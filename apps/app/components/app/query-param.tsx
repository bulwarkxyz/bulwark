'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';

function Reader({ name, onChange }: { name: string; onChange: (v: string | null) => void }) {
  const v = useSearchParams().get(name);
  useEffect(() => onChange(v), [v, onChange]);
  return null;
}

/**
 * Reports a query parameter to its page, including on client navigation to the same page (a link from
 * the bell to /app/audit?seq=12 while already on the audit log). Wrapped in Suspense, as Next requires for
 * useSearchParams on a prerendered page.
 */
export function QueryParam({ name, onChange }: { name: string; onChange: (v: string | null) => void }) {
  return (
    <Suspense fallback={null}>
      <Reader name={name} onChange={onChange} />
    </Suspense>
  );
}

/** Scrolls an element into view and marks it for two seconds (no motion: the mark just appears). */
export function revealById(id: string) {
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('target');
    setTimeout(() => el.classList.remove('target'), 2400);
  });
}
