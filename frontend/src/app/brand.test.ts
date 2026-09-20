import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PRODUCT_NAME, PRODUCT_TAGLINE, PRODUCT_VERSION_LABEL } from './brand';
import { AUTH_TOKEN_STORAGE_KEY } from '@/features/auth/lib/auth-storage';

describe('SlateHub brand contract', () => {
  it('publishes the hard-renamed product identity', () => {
    expect(PRODUCT_NAME).toBe('SlateHub');
    expect(PRODUCT_TAGLINE).toBe('案头那块墨水屏');
    expect(PRODUCT_VERSION_LABEL).toBe('v0.2');
    expect(AUTH_TOKEN_STORAGE_KEY).toBe('slatehub_jwt');
  });

  it('brands the static document title', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain('<title>SlateHub · 墨笺</title>');
  });
});
