/**
 * Server-side proxy to the Bulwark API. It forwards the request and adds the edge location
 * (Vercel's x-vercel-ip-country / x-vercel-ip-country-region, https://vercel.com/docs/headers/request-headers)
 * with the shared proxy secret, so the API trusts location only when it came from here.
 */
import type { NextRequest } from 'next/server';

const API = process.env.BULWARK_API_URL ?? 'http://localhost:8787';

async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = `${API}/${path.join('/')}${req.nextUrl.search}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-bulwark-proxy-secret': process.env.PROXY_SECRET ?? '' };
  const auth = req.headers.get('authorization');
  if (auth) headers.authorization = auth;
  const country = req.headers.get('x-vercel-ip-country') ?? process.env.DEV_COUNTRY;
  const region = req.headers.get('x-vercel-ip-country-region');
  if (country) headers['x-bulwark-country'] = country;
  if (region) headers['x-bulwark-subdivision'] = region;
  const res = await fetch(url, { method: req.method, headers, ...(req.method === 'GET' ? {} : { body: await req.text() }) });
  return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
}

export { forward as GET, forward as POST };
