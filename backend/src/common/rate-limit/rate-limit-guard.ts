import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { RateLimitedError } from '../errors';
import {
  FixedWindowRateLimiter,
  type FixedWindowRateLimiterOptions,
} from './fixed-window-rate-limiter';

export const RATE_LIMIT_KEY = 'slatehub:rate-limit';

export interface RateLimitGuardOptions {
  limiter: FixedWindowRateLimiterOptions;
  maxPerWindow: number | ((req: FastifyRequest) => number);
  key: (req: FastifyRequest) => string;
  message: string | ((req: FastifyRequest) => string);
}

export const RateLimit = (options: RateLimitGuardOptions): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, options);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiters = new WeakMap<RateLimitGuardOptions, FixedWindowRateLimiter>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const opts = this.reflector.getAllAndOverride<RateLimitGuardOptions>(RATE_LIMIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!opts) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const limiter = this.limiterFor(opts);
    const maxPerWindow =
      typeof opts.maxPerWindow === 'function' ? opts.maxPerWindow(req) : opts.maxPerWindow;
    const hit = limiter.hit(opts.key(req), maxPerWindow);
    if (hit.allowed) return true;

    throw new RateLimitedError(
      typeof opts.message === 'function' ? opts.message(req) : opts.message,
      { retry_after_sec: hit.retryAfterSec }
    );
  }

  private limiterFor(opts: RateLimitGuardOptions): FixedWindowRateLimiter {
    const existing = this.limiters.get(opts);
    if (existing) return existing;
    const created = new FixedWindowRateLimiter(opts.limiter);
    this.limiters.set(opts, created);
    return created;
  }
}
