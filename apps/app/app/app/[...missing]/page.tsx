import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'Page not found' };

/** Any /app address that isn't a screen: the app's own not-found page, inside the app's header and tabs. */
export default function Missing() {
  notFound();
}
