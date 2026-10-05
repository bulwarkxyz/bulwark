import { redirect } from 'next/navigation';

/** The app lives under /app; the landing page is a separate site. */
export default function Root() {
  redirect('/app');
}
