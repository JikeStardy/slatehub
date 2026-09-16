import { describe, expect, it } from 'bun:test';
import type { AppConfig } from '../../infra/config/app.config';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { DynamicContentRendererService } from './dynamic-content-renderer.service';
import { DynamicContentSchedulerService } from './dynamic-content-scheduler.service';

describe('DynamicContentSchedulerService', () => {
  it('looks up the next due job when the current tick has no work', async () => {
    const calls: string[] = [];
    const prisma = {
      content: {
        findMany: async () => {
          calls.push('findMany');
          return [];
        },
        findFirst: async () => {
          calls.push('findFirst');
          return { dynamicRefreshDueAt: new Date(Date.now() + 60_000) };
        },
      },
    };
    const service = new DynamicContentSchedulerService(
      { backgroundWorkers: true } as AppConfig,
      prisma as unknown as PrismaService,
      { cleanupStaleDynamicRenderCandidates: async () => 0 } as DynamicContentRendererService
    );

    await service.tick();
    service.onModuleDestroy();

    expect(calls).toEqual(['findMany', 'findFirst']);
  });

  it('clears its scheduled timer on module destroy', () => {
    const service = new DynamicContentSchedulerService(
      { backgroundWorkers: true } as AppConfig,
      {} as PrismaService,
      {} as DynamicContentRendererService
    );

    service.onModuleInit();
    const loop = (service as unknown as { loop: { timer: unknown } }).loop;
    expect(loop.timer).not.toBeNull();

    service.onModuleDestroy();
    expect(loop.timer).toBeNull();
  });

  it('logs retry marker failures instead of swallowing them inside a job catch', async () => {
    const logged: string[] = [];
    const service = new DynamicContentSchedulerService(
      { backgroundWorkers: true } as AppConfig,
      {
        content: {
          findMany: async () => [
            { id: 'content-1', dynamicType: 'weather', dynamicRefreshAttempts: 0 },
          ],
          updateMany: async ({
            data,
          }: {
            data?: { dynamicRefreshLeaseUntil?: Date; dynamicRefreshAttempts?: unknown };
          }) => {
            if (data?.dynamicRefreshAttempts) return { count: 1 };
            throw new Error('db unavailable');
          },
          findFirst: async () => null,
        },
      } as unknown as PrismaService,
      {
        renderDynamicContent: async () => {
          throw new Error('render failed');
        },
        cleanupStaleDynamicRenderCandidates: async () => 0,
      } as unknown as DynamicContentRendererService
    );
    (
      service as unknown as {
        logger: { warn: (msg: string) => void; error: (msg: string) => void };
      }
    ).logger = {
      warn: (msg: string) => logged.push(`warn:${msg}`),
      error: (msg: string) => logged.push(`error:${msg}`),
    };

    await service.tick();
    service.onModuleDestroy();

    expect(logged.some((msg) => msg.includes('Dynamic refresh job failed'))).toBe(true);
    expect(logged.some((msg) => msg.includes('Dynamic refresh retry marker failed'))).toBe(true);
  });

  it('marks scheduler-owned retry due and next run at the same timestamp without incrementing attempts again', async () => {
    const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const service = new DynamicContentSchedulerService(
      { backgroundWorkers: true } as AppConfig,
      {
        content: {
          findMany: async () => [
            { id: 'content-1', dynamicType: 'weather', dynamicRefreshAttempts: 1 },
          ],
          updateMany: async (args: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            updates.push(args);
            if ('dynamicRefreshAttempts' in args.data) return { count: 1 };
            return { count: 1 };
          },
          findFirst: async () => null,
        },
      } as unknown as PrismaService,
      {
        renderDynamicContent: async () => {
          throw new Error('render failed');
        },
        cleanupStaleDynamicRenderCandidates: async () => 0,
      } as unknown as DynamicContentRendererService
    );

    await service.tick();
    service.onModuleDestroy();

    const claim = updates.find((update) => 'dynamicRefreshAttempts' in update.data);
    const retry = updates.find((update) => 'dynamicLastError' in update.data);
    expect(claim?.data.dynamicRefreshAttempts).toEqual({ increment: 1 });
    expect(typeof claim?.data.dynamicRefreshLeaseToken).toBe('string');
    expect(retry?.where.dynamicRefreshLeaseToken).toBe(claim?.data.dynamicRefreshLeaseToken);
    expect(retry?.data.dynamicRefreshAttempts).toBeUndefined();
    expect(retry?.data.dynamicRefreshLeaseUntil).toBeNull();
    expect(retry?.data.dynamicRefreshLeaseToken).toBeNull();
    expect(retry?.data.dynamicRefreshDueAt).toBeInstanceOf(Date);
    expect(retry?.data.dynamicNextRunAt).toBeInstanceOf(Date);
    expect(retry?.data.dynamicRefreshDueAt).toBe(retry?.data.dynamicNextRunAt);
    expect((retry?.data.dynamicRefreshDueAt as Date).getTime()).toBe(
      (retry?.data.dynamicNextRunAt as Date).getTime()
    );
  });

  it('passes its claimed lease to the dynamic renderer for fencing', async () => {
    const renderCalls: Array<{
      contentId: string;
      schedulerLeaseUntil?: Date;
      schedulerLeaseToken?: string;
    }> = [];
    const service = new DynamicContentSchedulerService(
      { backgroundWorkers: true } as AppConfig,
      {
        content: {
          findMany: async () => [
            { id: 'content-1', dynamicType: 'weather', dynamicRefreshAttempts: 0 },
          ],
          updateMany: async () => ({ count: 1 }),
          findFirst: async () => null,
        },
      } as unknown as PrismaService,
      {
        renderDynamicContent: async (contentId, opts) => {
          renderCalls.push({
            contentId,
            schedulerLeaseUntil: opts?.schedulerLeaseUntil,
            schedulerLeaseToken: opts?.schedulerLeaseToken,
          });
          return {
            contentId,
            imageEtag: 'image-etag',
            contentEtag: 'content-etag',
            audioEtag: null,
            groupEtag: 'group-etag',
            renderedAt: new Date(),
            unchanged: false,
          };
        },
        cleanupStaleDynamicRenderCandidates: async () => 0,
      } as unknown as DynamicContentRendererService
    );

    await service.tick();
    service.onModuleDestroy();

    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]?.contentId).toBe('content-1');
    expect(renderCalls[0]?.schedulerLeaseUntil).toBeInstanceOf(Date);
    expect(renderCalls[0]?.schedulerLeaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
