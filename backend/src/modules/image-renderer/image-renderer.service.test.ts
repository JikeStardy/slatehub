import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ImageRendererService } from './image-renderer.service';
import { ImageRenderCacheService } from './image-render-cache.service';
import {
  NOTE4_RENDER_TARGET,
  renderTargetForProfile,
} from '../dynamic-content/rendering/render-target';

const VIRTUAL_RENDER_TARGET = renderTargetForProfile('virtual-mono-296x128');

let tmp = '';
let cache: ImageRenderCacheService;
let renderer: ImageRendererService;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'render-test-'));
  cache = new ImageRenderCacheService({ blobDir: tmp } as never);
  renderer = new ImageRendererService(cache);
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

async function makePng(
  width: number,
  height: number,
  fill: { r: number; g: number; b: number }
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: fill },
  })
    .png()
    .toBuffer();
}

describe('ImageRendererService', () => {
  it('白图渲染后全白(全 0xff)', async () => {
    const input = await makePng(800, 600, { r: 255, g: 255, b: 255 });
    const { data, width, height } = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET);
    expect(width).toBe(NOTE4_RENDER_TARGET.width);
    expect(height).toBe(NOTE4_RENDER_TARGET.height);
    expect(data.length).toBe(NOTE4_RENDER_TARGET.byteLength);
    expect(data.every((b) => b === 0xff)).toBe(true);
  });

  it('按显式 target 渲染静态图', async () => {
    const input = await makePng(800, 600, { r: 180, g: 180, b: 180 });
    const note4 = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET, { autoInvert: false });
    const virtual = await renderer.renderTo1bpp(input, VIRTUAL_RENDER_TARGET, {
      autoInvert: false,
    });

    expect(note4.width).toBe(400);
    expect(note4.height).toBe(300);
    expect(note4.data.length).toBe(15000);
    expect(virtual.width).toBe(296);
    expect(virtual.height).toBe(128);
    expect(virtual.data.length).toBe(4736);
  });

  it('黑图(autoInvert 触发) 仍是白', async () => {
    const input = await makePng(800, 600, { r: 0, g: 0, b: 0 });
    const { data } = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET);
    expect(data.every((b) => b === 0xff)).toBe(true);
  });

  it('autoInvert=false 时全黑图保持全黑(全 0x00)', async () => {
    const input = await makePng(800, 600, { r: 0, g: 0, b: 0 });
    const { data } = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET, {
      autoInvert: false,
    });
    expect(data.every((b) => b === 0x00)).toBe(true);
  });

  it('size 验证', async () => {
    const input = await makePng(100, 100, { r: 128, g: 128, b: 128 });
    const { data } = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET);
    expect(() => renderer.validateFrameSize(data, NOTE4_RENDER_TARGET)).not.toThrow();
    expect(() => renderer.validateFrameSize(Buffer.alloc(100), NOTE4_RENDER_TARGET)).toThrow();
  });

  it('width 不是 8 的倍数时报错', async () => {
    const input = await makePng(100, 100, { r: 0, g: 0, b: 0 });
    const invalidTarget = {
      ...NOTE4_RENDER_TARGET,
      width: 401,
    };
    await expect(renderer.renderTo1bpp(input, invalidTarget)).rejects.toThrow(/8 的倍数/);
  });

  it('不支持的静态图编码会失败', async () => {
    const input = await makePng(100, 100, { r: 0, g: 0, b: 0 });
    await expect(
      renderer.renderTo1bpp(input, {
        ...NOTE4_RENDER_TARGET,
        frameCodec: 'reserved_codec' as never,
      })
    ).rejects.toThrow(/不支持的帧编码/);
  });

  it('mode 默认为 threshold(向后兼容)', async () => {
    const input = await makePng(400, 300, { r: 255, g: 255, b: 255 });
    const { data: defaultData } = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET);
    const { data: explicitData } = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET, {
      mode: 'threshold',
    });
    expect(Buffer.compare(defaultData, explicitData)).toBe(0);
  });

  it('atkinson 全黑图(autoInvert off) 输出全黑', async () => {
    const input = await makePng(400, 300, { r: 0, g: 0, b: 0 });
    const { data } = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET, {
      mode: 'atkinson',
      autoInvert: false,
    });
    expect(data.every((b) => b === 0x00)).toBe(true);
  });

  it('bayer8 全白图输出全白', async () => {
    const input = await makePng(400, 300, { r: 255, g: 255, b: 255 });
    const { data } = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET, { mode: 'bayer8' });
    expect(data.every((b) => b === 0xff)).toBe(true);
  });

  it('同图二次渲染应命中缓存（fromCache=true）', async () => {
    const input = await makePng(400, 300, { r: 32, g: 64, b: 128 });
    const r1 = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET, { mode: 'floyd' });
    expect(r1.fromCache).toBe(false);
    const r2 = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET, { mode: 'floyd' });
    expect(r2.fromCache).toBe(true);
    expect(Buffer.compare(r1.data, r2.data)).toBe(0);
  });

  it('同 key 并发未命中时只执行一次 compute', async () => {
    const localCache = new ImageRenderCacheService({ blobDir: tmp } as never);
    const key = `concurrent-${Date.now()}`;
    let calls = 0;

    const [first, second] = await Promise.all([
      localCache.getOrCompute(key, async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Buffer.from('cached');
      }),
      localCache.getOrCompute(key, async () => {
        calls += 1;
        return Buffer.from('duplicate');
      }),
    ]);

    expect(calls).toBe(1);
    expect([first.fromCache, second.fromCache].sort()).toEqual([false, true]);
    expect(first.data.toString()).toBe(second.data.toString());
  });

  it('compute 失败后清理 in-flight entry，后续请求可重新计算', async () => {
    const localCache = new ImageRenderCacheService({ blobDir: tmp } as never);
    const key = `retry-after-failure-${Date.now()}`;
    let calls = 0;

    await expect(
      localCache.getOrCompute(key, async () => {
        calls += 1;
        throw new Error('render failed');
      })
    ).rejects.toThrow('render failed');

    const result = await localCache.getOrCompute(key, async () => {
      calls += 1;
      return Buffer.from('recovered');
    });

    expect(calls).toBe(2);
    expect(result.fromCache).toBe(false);
    expect(result.data.toString()).toBe('recovered');
  });

  it('cache path resolves relative blobDir to an absolute root', () => {
    const localCache = new ImageRenderCacheService({ blobDir: './relative-blobs' } as never);
    const path = localCache.path('abcdef');

    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(resolve('./relative-blobs/image-render-cache/ab/abcdef.bin'));
  });

  it('opts 不同 → key 不同 → fromCache=false', async () => {
    const input = await makePng(400, 300, { r: 100, g: 100, b: 100 });
    const r1 = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET, {
      mode: 'threshold',
      threshold: 100,
    });
    const r2 = await renderer.renderTo1bpp(input, NOTE4_RENDER_TARGET, {
      mode: 'threshold',
      threshold: 200,
    });
    expect(r1.fromCache).toBe(false);
    expect(r2.fromCache).toBe(false);
  });
});
