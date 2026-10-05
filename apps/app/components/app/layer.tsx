'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The top layer: every menu, list, sheet and tooltip renders here, through a portal outside the page's
 * panels, so no panel's overflow or stacking context can clip or cover it. Stacking follows one scale
 * (app.css): --z-popover for menus and lists, --z-sheet for phone sheets, --z-tooltip above both.
 */
export const LAYER_ID = 'bw-layer';

export function TopLayer() {
  return <div id={LAYER_ID} className="bw layer" />;
}

/** Renders children into the top layer (nothing on the server, nothing before the layer exists). */
export function InLayer({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.getElementById(LAYER_ID)), []);
  return el ? createPortal(children, el) : null;
}

export const isPhoneWidth = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches;

/**
 * Where a floating box goes next to its anchor: below it, or above when there isn't room below; kept
 * inside the viewport with an 8px margin; re-measured on scroll (any scrolling ancestor) and resize.
 */
export function useAnchored(anchor: React.RefObject<HTMLElement | null>, open: boolean, opts: { width?: number | 'anchor'; maxHeight?: number; gap?: number } = {}) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number; above: boolean } | null>(null);
  const measure = useCallback(() => {
    const a = anchor.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = opts.gap ?? 6;
    const width = Math.min(opts.width === 'anchor' || opts.width === undefined ? Math.max(r.width, 180) : opts.width, vw - 16);
    const left = Math.min(Math.max(8, r.left), vw - 8 - width);
    const below = vh - r.bottom - gap - 8;
    const aboveRoom = r.top - gap - 8;
    const want = opts.maxHeight ?? 360;
    const above = below < Math.min(want, 200) && aboveRoom > below;
    const maxHeight = Math.max(120, Math.min(want, above ? aboveRoom : below));
    setPos({ top: above ? r.top - gap : r.bottom + gap, left, width, maxHeight, above });
  }, [anchor, opts.width, opts.maxHeight, opts.gap]);
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);
  return pos;
}

/** Closes on a pointer press outside both the anchor and the floating box. */
export function useOutside(refs: Array<React.RefObject<HTMLElement | null>>, open: boolean, onOutside: () => void) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      cb.current();
    };
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
