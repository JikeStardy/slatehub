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
});
