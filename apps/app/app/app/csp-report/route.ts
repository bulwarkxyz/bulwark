/**
 * Where browsers send Content Security Policy reports (security-headers.mjs). Each report becomes one log
 * line with the directive, the blocked host and the page's path: no query strings, no full URLs, nothing
 * about the visitor. Bodies over 16 KB are dropped.
 */
export const dynamic = 'force-dynamic';

type Report = { 'violated-directive'?: string; 'effective-directive'?: string; effectiveDirective?: string; 'blocked-uri'?: string; blockedURL?: string; 'document-uri'?: string; documentURL?: string };

/** "https://host/path?q" → "https://host"; keywords such as "inline" or "eval" stay as they are. */
function origin(u: string | undefined): string {
  if (!u) return '?';
  try {
    return new URL(u).origin;
  } catch {
    return u.slice(0, 40);
  }
}
function pathOf(u: string | undefined): string {
  try {
    return u ? new URL(u).pathname.slice(0, 80) : '?';
  } catch {
    return '?';
  }
}

export async function POST(req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > 16_384) return new Response(null, { status: 204 });
  let reports: Report[] = [];
  try {
    const body = JSON.parse(text) as { 'csp-report'?: Report } | { body?: Report }[];
    reports = Array.isArray(body) ? body.map((r) => r.body ?? {}) : body['csp-report'] ? [body['csp-report']] : [];
  } catch {
    return new Response(null, { status: 204 });
  }
  for (const r of reports.slice(0, 10)) {
    const directive = r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? '?';
    console.warn(`csp-report ${directive.split(' ')[0]} blocked=${origin(r['blocked-uri'] ?? r.blockedURL)} page=${pathOf(r['document-uri'] ?? r.documentURL)}`);
  }
  return new Response(null, { status: 204 });
}
