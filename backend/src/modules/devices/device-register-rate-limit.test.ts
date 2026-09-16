import { describe, expect, it } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { RateLimitedError } from '../../common/errors';
import { createRateLimitGuard } from '../../common/rate-limit/test-utils';
import { deviceRegisterRateLimit } from './device-rate-limits';

function context(ip = '127.0.0.1'): ExecutionContext {
  return {
    getHandler: () => context,
    getClass: () => Object,
    switchToHttp: () => ({
      getRequest: () => ({ ip, headers: {}, method: 'POST', url: '/api/v2/devices' }),
    }),
  } as unknown as ExecutionContext;
}

describe('deviceRegisterRateLimit', () => {
  it('rate-limits device registration per client ip', () => {
    const guard = createRateLimitGuard(deviceRegisterRateLimit);

    for (let i = 0; i < 20; i++) {
      expect(guard.canActivate(context())).toBe(true);
    }

    expect(() => guard.canActivate(context())).toThrow(RateLimitedError);
  });
});
