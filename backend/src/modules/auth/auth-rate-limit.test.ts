import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { RateLimitedError } from '../../common/errors';
import { createRateLimitGuard } from '../../common/rate-limit/test-utils';
import { authRateLimit } from './auth-rate-limit';

function context(
  url: string,
  ip = '127.0.0.1',
  routeUrl: string | undefined = url
): ExecutionContext {
  return {
    getHandler: () => context,
    getClass: () => Object,
    switchToHttp: () => ({
      getRequest: () => ({ method: 'POST', url, ip, headers: {}, routeOptions: { url: routeUrl } }),
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe('authRateLimit', () => {
  it('rate-limits login attempts per client ip', () => {
    const guard = createRateLimitGuard(authRateLimit);

    for (let i = 0; i < 10; i++) {
      expect(guard.canActivate(context('/api/v2/sessions'))).toBe(true);
    }

    try {
      guard.canActivate(context('/api/v2/sessions'));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      const detail = (err as RateLimitedError).detail as { retry_after_sec?: number };
      expect(typeof detail.retry_after_sec).toBe('number');
      expect(detail.retry_after_sec).toBeGreaterThan(0);
      expect(detail.retry_after_sec).toBeLessThanOrEqual(60);
    }
  });

  it('classifies register only by the exact route path', () => {
    const guard = createRateLimitGuard(authRateLimit);

    for (let i = 0; i < 5; i++) {
      expect(guard.canActivate(context('/api/v2/users', '127.0.0.2', '/api/v2/users'))).toBe(true);
    }
    expect(() => guard.canActivate(context('/api/v2/users', '127.0.0.2', '/api/v2/users'))).toThrow(
      RateLimitedError
    );

    const nested = createRateLimitGuard(authRateLimit);
    for (let i = 0; i < 6; i++) {
      expect(
        nested.canActivate(
          context('/api/v2/devices/device-1/users', '127.0.0.3', '/api/v2/devices/:id/users')
        )
      ).toBe(true);
    }
  });
});
