import { describe, expect, it } from 'bun:test';
import { ValidationError } from '../../common/errors';
import { DynamicContentService } from './dynamic-content.service';

describe('DynamicContentService display profile guard', () => {
  it('passes a virtual profile through to direct preview rendering in test', async () => {
    const calls: string[] = [];
    const service = new DynamicContentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        renderPreviewDirect: async (
          _dynamicType: string,
          _config: unknown,
          _frameName: string | null,
          _data: unknown,
          displayProfileId: string
        ) => {
          calls.push(displayProfileId);
          return Buffer.alloc(4_736);
        },
      } as never,
      { nodeEnv: 'test' } as never
    );

    await expect(
      service.previewDirect({
        config: { type: 'daily_calendar', tz: 'Asia/Shanghai' },
        display_profile_id: 'virtual-mono-296x128',
      })
    ).resolves.toHaveLength(4_736);
    expect(calls).toEqual(['virtual-mono-296x128']);
  });

  it('rejects production direct preview requests for virtual display profiles', async () => {
    const calls: string[] = [];
    const service = new DynamicContentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        renderPreviewDirect: async (
          _dynamicType: string,
          _config: unknown,
          _frameName: string | null,
          _data: unknown,
          displayProfileId: string
        ) => {
          calls.push(displayProfileId);
          return Buffer.alloc(4_736);
        },
      } as never,
      { nodeEnv: 'production' } as never
    );

    await expect(
      service.previewDirect({
        config: { type: 'daily_calendar', tz: 'Asia/Shanghai' },
        display_profile_id: 'virtual-mono-296x128',
      })
    ).rejects.toThrow(ValidationError);
    expect(calls).toEqual([]);
  });

  it('rejects production stored-content preview requests for virtual display profiles', async () => {
    const calls: string[] = [];
    const service = new DynamicContentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        renderPreview: async (
          _contentId: string,
          _ownerUserId: string,
          _config: unknown,
          _frameName: string | null | undefined,
          displayProfileId: string
        ) => {
          calls.push(displayProfileId);
          return Buffer.alloc(4_736);
        },
      } as never,
      { nodeEnv: 'production' } as never
    );

    await expect(
      service.preview('content-1', 'user-1', {
        config: { type: 'daily_calendar', tz: 'Asia/Shanghai' },
        display_profile_id: 'virtual-mono-296x128',
      })
    ).rejects.toThrow(ValidationError);
    expect(calls).toEqual([]);
  });

  it('allows production direct preview requests for production display profiles', async () => {
    const calls: string[] = [];
    const service = new DynamicContentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        renderPreviewDirect: async (
          _dynamicType: string,
          _config: unknown,
          _frameName: string | null,
          _data: unknown,
          displayProfileId: string
        ) => {
          calls.push(displayProfileId);
          return Buffer.alloc(15_000);
        },
      } as never,
      { nodeEnv: 'production' } as never
    );

    await expect(
      service.previewDirect({
        config: { type: 'daily_calendar', tz: 'Asia/Shanghai' },
        display_profile_id: 'zectrix-note4-400x300-mono',
      })
    ).resolves.toHaveLength(15_000);
    expect(calls).toEqual(['zectrix-note4-400x300-mono']);
  });

  it('allows development stored-content data preview for virtual display profiles', async () => {
    const calls: string[] = [];
    const service = new DynamicContentService(
      {
        content: {
          findUnique: async () => ({
            kind: 'dynamic',
            dynamicType: 'dashboard',
            frameName: null,
            group: { ownerUserId: 'user-1' },
          }),
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        renderPreviewDirect: async (
          _dynamicType: string,
          _config: unknown,
          _frameName: string | null,
          _data: unknown,
          displayProfileId: string
        ) => {
          calls.push(displayProfileId);
          return Buffer.alloc(4_736);
        },
      } as never,
      { nodeEnv: 'development' } as never
    );

    await expect(
      service.preview('content-1', 'user-1', {
        config: { type: 'dashboard' },
        data: { date: '2026-09-16' },
        display_profile_id: 'virtual-mono-296x128',
      })
    ).resolves.toHaveLength(4_736);
    expect(calls).toEqual(['virtual-mono-296x128']);
  });

  it('installs a foreground lease token before dashboard ingest rendering', async () => {
    const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const renderCalls: Array<{ contentId: string; opts: Record<string, unknown> | undefined }> = [];
    const service = new DynamicContentService(
      {
        content: {
          findUnique: async () => ({
            sortOrder: 7,
            kind: 'dynamic',
            dynamicType: 'dashboard',
          }),
          updateMany: async (args: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            updates.push(args);
            return { count: 1 };
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        renderDynamicContent: async (contentId: string, opts?: Record<string, unknown>) => {
          renderCalls.push({ contentId, opts });
          return {
            contentId,
            imageEtag: 'image-etag',
            audioEtag: null,
            groupEtag: 'group-etag',
            contentEtag: 'content-etag',
            renderedAt: new Date('2026-05-17T04:10:00.000Z'),
            unchanged: false,
          };
        },
      } as never,
      { nodeEnv: 'test' } as never
    );

    await expect(
      service.ingestDashboard('content-1', { data: { total_requests: 1 } } as never)
    ).resolves.toMatchObject({
      id: 'content-1',
      seq: 7,
      image_etag: 'image-etag',
      manifest_etag: 'group-etag',
      content_etag: 'content-etag',
    });

    expect(updates).toHaveLength(1);
    const token = updates[0]!.data.dynamicRefreshLeaseToken;
    expect(updates[0]!.where).toMatchObject({
      id: 'content-1',
      kind: 'dynamic',
      dynamicType: 'dashboard',
    });
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(updates[0]!.data.dynamicRefreshLeaseUntil).toBeInstanceOf(Date);
    expect(renderCalls).toEqual([
      {
        contentId: 'content-1',
        opts: expect.objectContaining({
          force: true,
          dataOverride: { total_requests: 1 },
          schedulerLeaseUntil: updates[0]!.data.dynamicRefreshLeaseUntil,
          schedulerLeaseToken: token,
          claimedLeaseOwner: 'foreground',
        }),
      },
    ]);
  });

  it('installs and passes a foreground lease token when patching frame name or config', async () => {
    const updates: Record<string, unknown>[] = [];
    const renderCalls: Array<{ contentId: string; opts: Record<string, unknown> | undefined }> = [];
    const service = new DynamicContentService(
      {
        content: {
          findUnique: async () => ({
            id: 'content-1',
            groupId: 'group-1',
            sortOrder: 3,
            kind: 'dynamic',
            dynamicType: 'daily_calendar',
            dynamicConfig: { type: 'daily_calendar', tz: 'Asia/Shanghai' },
          }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            updates.push(data);
            return {};
          },
        },
      } as never,
      {} as never,
      { assertOwned: async () => undefined } as never,
      {} as never,
      {
        renderDynamicContent: async (contentId: string, opts?: Record<string, unknown>) => {
          renderCalls.push({ contentId, opts });
          return {
            contentId,
            imageEtag: 'image-etag',
            audioEtag: null,
            groupEtag: 'group-etag',
            contentEtag: 'content-etag',
            renderedAt: new Date(),
            unchanged: false,
          };
        },
      } as never,
      { nodeEnv: 'test' } as never
    );

    await service.patch('content-1', 'user-1', { frame_name: 'new name' });
    await service.patch('content-1', 'user-1', {
      config: { type: 'daily_calendar', tz: 'Asia/Tokyo' },
    });

    expect(updates[0]).toMatchObject({
      frameName: 'new name',
      dynamicRefreshLeaseUntil: expect.any(Date),
      dynamicRefreshLeaseToken: expect.any(String),
    });
    expect(updates[1]).toMatchObject({
      dynamicRefreshDueAt: expect.any(Date),
      dynamicRefreshLeaseUntil: expect.any(Date),
      dynamicRefreshLeaseToken: expect.any(String),
    });
    expect(renderCalls).toEqual([
      {
        contentId: 'content-1',
        opts: expect.objectContaining({
          force: true,
          schedulerLeaseUntil: updates[0]!.dynamicRefreshLeaseUntil,
          schedulerLeaseToken: updates[0]!.dynamicRefreshLeaseToken,
          claimedLeaseOwner: 'foreground',
        }),
      },
      {
        contentId: 'content-1',
        opts: expect.objectContaining({
          force: true,
          schedulerLeaseUntil: updates[1]!.dynamicRefreshLeaseUntil,
          schedulerLeaseToken: updates[1]!.dynamicRefreshLeaseToken,
          claimedLeaseOwner: 'foreground',
        }),
      },
    ]);
  });

  it('installs and passes a foreground lease token when patchFrameNameIfDynamic updates a frame name', async () => {
    const updates: Record<string, unknown>[] = [];
    const renderCalls: Array<{ contentId: string; opts: Record<string, unknown> | undefined }> = [];
    const service = new DynamicContentService(
      {
        content: {
          findUnique: async () => ({
            groupId: 'group-1',
            sortOrder: 4,
            kind: 'dynamic',
            dynamicType: 'daily_calendar',
            group: { ownerUserId: 'user-1' },
          }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            updates.push(data);
            return {};
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        renderDynamicContent: async (contentId: string, opts?: Record<string, unknown>) => {
          renderCalls.push({ contentId, opts });
          return {
            contentId,
            imageEtag: 'image-etag',
            audioEtag: null,
            groupEtag: 'group-etag',
            contentEtag: 'content-etag',
            renderedAt: new Date(),
            unchanged: false,
          };
        },
      } as never,
      { nodeEnv: 'test' } as never
    );

    await service.patchFrameNameIfDynamic('content-1', 'user-1', 'patched');

    expect(updates).toEqual([
      expect.objectContaining({
        frameName: 'patched',
        dynamicRefreshLeaseUntil: expect.any(Date),
        dynamicRefreshLeaseToken: expect.any(String),
      }),
    ]);
    expect(renderCalls).toEqual([
      {
        contentId: 'content-1',
        opts: expect.objectContaining({
          force: true,
          schedulerLeaseUntil: updates[0]!.dynamicRefreshLeaseUntil,
          schedulerLeaseToken: updates[0]!.dynamicRefreshLeaseToken,
          claimedLeaseOwner: 'foreground',
        }),
      },
    ]);
  });

  it('prevents a scheduler claim from stealing the foreground lease installed by patch', async () => {
    const now = new Date('2026-05-17T04:10:00.000Z');
    const contentState: {
      dynamicRefreshLeaseUntil: Date | null;
      dynamicRefreshLeaseToken: string | null;
    } = {
      dynamicRefreshLeaseUntil: null,
      dynamicRefreshLeaseToken: null,
    };
    const schedulerClaimCounts: number[] = [];
    const prisma = {
      content: {
        findUnique: async () => ({
          id: 'content-1',
          groupId: 'group-1',
          sortOrder: 3,
          kind: 'dynamic',
          dynamicType: 'daily_calendar',
          dynamicConfig: { type: 'daily_calendar', tz: 'Asia/Shanghai' },
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          contentState.dynamicRefreshLeaseUntil =
            (data.dynamicRefreshLeaseUntil as Date | null | undefined) ?? null;
          contentState.dynamicRefreshLeaseToken =
            (data.dynamicRefreshLeaseToken as string | null | undefined) ?? null;
          return {};
        },
        updateMany: async (args: {
          where: {
            OR?: Array<{ dynamicRefreshLeaseUntil: null | { lte: Date } }>;
          };
        }) => {
          const claimable = args.where.OR?.some((predicate) => {
            if (predicate.dynamicRefreshLeaseUntil === null) {
              return contentState.dynamicRefreshLeaseUntil === null;
            }
            return (
              contentState.dynamicRefreshLeaseUntil !== null &&
              contentState.dynamicRefreshLeaseUntil.getTime() <=
                predicate.dynamicRefreshLeaseUntil.lte.getTime()
            );
          });
          const count = claimable ? 1 : 0;
          schedulerClaimCounts.push(count);
          return { count };
        },
      },
    };
    const renderCalls: Array<{ opts: Record<string, unknown> | undefined }> = [];
    const service = new DynamicContentService(
      prisma as never,
      {} as never,
      { assertOwned: async () => undefined } as never,
      {} as never,
      {
        renderDynamicContent: async (contentId: string, opts?: Record<string, unknown>) => {
          renderCalls.push({ opts });
          const attemptedSchedulerClaim = await prisma.content.updateMany({
            where: {
              OR: [{ dynamicRefreshLeaseUntil: null }, { dynamicRefreshLeaseUntil: { lte: now } }],
            },
          });
          expect(attemptedSchedulerClaim.count).toBe(0);
          expect(opts).toEqual(
            expect.objectContaining({
              force: true,
              schedulerLeaseUntil: contentState.dynamicRefreshLeaseUntil,
              schedulerLeaseToken: contentState.dynamicRefreshLeaseToken,
              claimedLeaseOwner: 'foreground',
            })
          );
          return {
            contentId,
            imageEtag: 'image-etag',
            audioEtag: null,
            groupEtag: 'group-etag',
            contentEtag: 'content-etag',
            renderedAt: now,
            unchanged: false,
          };
        },
      } as never,
      { nodeEnv: 'test' } as never
    );

    await service.patch('content-1', 'user-1', { frame_name: 'foreground patch' });

    expect(schedulerClaimCounts).toEqual([0]);
    expect(contentState.dynamicRefreshLeaseUntil?.getTime()).toBeGreaterThan(now.getTime());
    expect(contentState.dynamicRefreshLeaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(renderCalls).toHaveLength(1);
  });
});
