'use client';

/**
 * The last resort, when even the app's frame fails: its own page with inline styles, since the app's
 * stylesheet may be what failed. Dark, like the app's default.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const btn = { minHeight: 40, padding: '0 16px', borderRadius: 8, font: '600 14px system-ui, sans-serif', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } as const;
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#090C10', color: '#E6E9EE', font: '14px/1.5 system-ui, sans-serif', padding: 16 }}>
        <title>Bulwark hit a problem</title>
        <main role="alert" style={{ maxWidth: 460, textAlign: 'center', display: 'grid', gap: 12, justifyItems: 'center' }}>
          <b style={{ fontSize: 15 }}>Bulwark</b>
          <h1 style={{ fontSize: 22, margin: 0 }}>The app hit a problem.</h1>
          <p style={{ margin: 0, color: '#A9B1BC' }}>Nothing was sent or signed, and the guard keeps running on Bulwark’s servers with your signed rules. Try again, or reload the page.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button type="button" onClick={reset} style={{ ...btn, border: 0, background: '#E6E9EE', color: '#090C10' }}>
              Try again
            </button>
            <a href="/app" style={{ ...btn, border: '1px solid #2A313B', color: '#E6E9EE' }}>
              Go to Markets
            </a>
          </div>
          {error.digest ? <small style={{ color: '#7D8794', fontFamily: 'ui-monospace, monospace' }}>Reference {error.digest}</small> : null}
        </main>
      </body>
    </html>
  );
}
