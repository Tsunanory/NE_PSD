import { describe, expect, it } from 'vitest';
import { isAllowedNavigation, isAllowedRootHandle } from '../../apps/desktop/src/main/window.js';

describe('desktop window policy', () => {
  it('allows only the packaged app origin', () => {
    expect(isAllowedNavigation('file:///app/index.html', 'production')).toBe(true);
    expect(isAllowedNavigation('https://evil.example/', 'production')).toBe(false);
    expect(isAllowedNavigation('http://localhost:5173/', 'production')).toBe(false);
  });

  it('rejects stale and traversal root handles', () => {
    expect(isAllowedRootHandle({ rootId: 'assets', relativePath: 'cat.png', roots: { assets: '/tmp/assets' } })).toBe(false);
    expect(isAllowedRootHandle({ rootId: 'assets', relativePath: '../secret', roots: { assets: '/tmp/assets' } })).toBe(false);
    expect(isAllowedRootHandle({ rootId: 'stale', relativePath: 'cat.png', roots: { assets: '/tmp/assets' } })).toBe(false);
  });

  it('requires an exact packaged origin', () => {
    expect(isAllowedNavigation('file:///app/index.html.evil', 'production')).toBe(false);
  });
});
