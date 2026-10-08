import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Page not found · Bulwark' };

/** Addresses outside /app (the landing and docs are separate sites): a plain page that points back in. */
export default function RootNotFound() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16, font: '14px/1.5 var(--font-geist), system-ui, sans-serif' }} className="root-404">
      <div style={{ maxWidth: 440, textAlign: 'center', display: 'grid', gap: 12, justifyItems: 'center' }}>
        <b style={{ fontSize: 15 }}>Bulwark</b>
        <h1 style={{ fontSize: 22, margin: 0 }}>This page isn’t here.</h1>
        <p style={{ margin: 0, opacity: 0.75 }}>The address may be mistyped, or the page has moved.</p>
        <a href="/app" style={{ minHeight: 40, padding: '0 16px', borderRadius: 8, display: 'inline-flex', alignItems: 'center', fontWeight: 600, textDecoration: 'none', border: '1px solid currentColor', color: 'inherit' }}>
          Go to the app
        </a>
      </div>
    </main>
  );
}
