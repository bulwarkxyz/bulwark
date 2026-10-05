import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#C6F25A" />
      <path d="M16 7l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9v-6l8-3z" fill="none" stroke="#0B1300" strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 font-semibold">
          <Mark /> Bulwark <span className="font-normal text-fd-muted-foreground">docs</span>
        </span>
      ),
      url: '/',
    },
    links: [
      { text: 'Home', url: '/../', external: true },
      { text: 'Open the app', url: '/../app', external: true },
    ],
  };
}
