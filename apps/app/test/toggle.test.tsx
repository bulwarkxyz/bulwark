import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Toggle } from '@/components/app/toggle';

describe('switch', () => {
  it('is a labelled role="switch" that says whether it is on', () => {
    const on = renderToStaticMarkup(<Toggle label="Show alerts in the app" checked onChange={() => {}} />);
    const off = renderToStaticMarkup(<Toggle label="Show alerts in the app" checked={false} onChange={() => {}} />);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(off).toContain('aria-checked="false"');
    expect(on).toContain('aria-label="Show alerts in the app"');
  });
});
