import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

function Mark() {
  return (
    // The Bulwark mark in ink: lime is reserved for the protected state.
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
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
    githubUrl: 'https://github.com/bulwarkxyz/bulwark',
    links: [
      { text: 'Home', url: '/../', external: true },
      { text: 'Open the app', url: '/../app', external: true },
      { text: 'X', url: 'https://x.com/bulwarkxyz', external: true },
    ],
  };
}
