import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobService } from './blob.service';
import type { AppConfig } from '../config/app.config';
import { ValidationError } from '../../common/errors';

let blobDir = '/tmp/slate-blob-test';

beforeEach(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'slate-blob-test-'));
});

afterEach(async () => {
  await rm(blobDir, { recursive: true, force: true });
});

function service(): BlobService {
  return new BlobService({ blobDir } as AppConfig);
}

describe('BlobService storage keys', () => {
  it('isolates sources and profile-specific frames in separate directories', () => {
    const blob = service();

    expect(blob.sourceKey('group-1', 'content-1')).toBe('sources/group-1/content-1.source');
    expect(blob.frameKey('group-1', 'content-1', 'zectrix-note4-400x300-mono')).toBe(
      'frames/zectrix-note4-400x300-mono/group-1/content-1.img'
    );
    expect(blob.frameKey('group-1', 'content-1', 'virtual-mono-296x128')).toBe(
      'frames/virtual-mono-296x128/group-1/content-1.img'
    );
  });

  it('rejects frame keys for profiles outside the shared registry', () => {
    expect(() => service().frameKey('group-1', 'content-1', 'unknown-profile')).toThrow(
      /unknown display profile/
    );
  });
});

describe('BlobService storage-key I/O', () => {
  it('atomically replaces a frame and leaves no temporary file behind', async () => {
    const blob = service();
    await blob.onModuleInit();
    const key = blob.frameKey('group-1', 'content-1', 'zectrix-note4-400x300-mono');
    const first = Buffer.alloc(15_000, 0x11);
    const second = Buffer.alloc(15_000, 0x22);

    const writes = await Promise.all([
      blob.writeStorageKey(key, 'frame', first),
      blob.writeStorageKey(key, 'frame', second),
    ]);

    expect(writes[1]).toEqual({ path: blob.storagePath(key), size: 15_000 });
    expect(await blob.readStorageKey(key)).toEqual(second);
    expect(await readdir(join(blobDir, 'frames/zectrix-note4-400x300-mono/group-1'))).toEqual([
      'content-1.img',
    ]);
  });

  it('writes and deletes a source through its relative storage key', async () => {
    const blob = service();
    await blob.onModuleInit();
    const key = blob.sourceKey('group-1', 'content-1');

    await blob.writeStorageKey(key, 'source', Buffer.from('original image'));
    expect(await blob.readStorageKey(key)).toEqual(Buffer.from('original image'));

    await blob.deleteStorageKey(key);
    expect(await blob.readStorageKey(key)).toBeNull();
  });

  it('keeps the legacy group/content/kind API compatible', async () => {
    const blob = service();
    await blob.onModuleInit();
    const bytes = Buffer.from([0xaa, 0x55]);

    expect(await blob.write('group-1', 'content-1', 'image', bytes)).toEqual({
      path: blob.path('group-1', 'content-1', 'image'),
      size: 2,
    });
    expect(await blob.readStorageKey('group-1/content-1.img')).toEqual(bytes);
    expect(await blob.read('group-1', 'content-1', 'image')).toEqual(bytes);

    await blob.delete('group-1', 'content-1', 'image');
    expect(await blob.read('group-1', 'content-1', 'image')).toBeNull();
  });

  it('rejects traversal and storage keys outside the declared kind namespace', async () => {
    const blob = service();

    expect(() => blob.storagePath('../escape.img')).toThrow(/非法 blob/);
    await expect(
      blob.writeStorageKey('sources/group-1/content-1.source', 'frame', Buffer.alloc(1))
    ).rejects.toThrow(/frame storage key/);
    await expect(
      blob.writeStorageKey('frames/unknown-profile/group-1/content-1.img', 'frame', Buffer.alloc(1))
    ).rejects.toThrow(/unknown display profile/);
  });

  it('enforces separate source and frame size limits', async () => {
    const blob = service();

    await expect(
      blob.writeStorageKey(
        blob.sourceKey('group-1', 'content-1'),
        'source',
        Buffer.alloc(10 * 1024 * 1024 + 1)
      )
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      blob.writeStorageKey(
        blob.frameKey('group-1', 'content-1', 'zectrix-note4-400x300-mono'),
        'frame',
        Buffer.alloc(64 * 1024 + 1)
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
