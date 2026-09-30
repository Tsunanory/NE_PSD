import { describe, expect, it } from 'vitest';
import { isAllowedNavigation, packagedRendererUrl } from '../../apps/desktop/src/main/window.js';

describe('desktop window policy', () => {
  it('allows only the packaged app origin', () => {
    expect(isAllowedNavigation(packagedRendererUrl(), 'production')).toBe(true);
    expect(isAllowedNavigation('https://evil.example/', 'production')).toBe(false);
    expect(isAllowedNavigation('http://localhost:5173/', 'production')).toBe(false);
  });


  it('requires an exact packaged origin', () => {
    expect(isAllowedNavigation('file:///app/index.html.evil', 'production')).toBe(false);
  });
});
