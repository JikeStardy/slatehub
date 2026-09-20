import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobService } from './blob.service';
import type { AppConfig } from '../config/app.config';
import { ValidationError } from '../../common/errors';

let blobDir = '/tmp/slatehub-blob-test';

beforeEach(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'slatehub-blob-test-'));
});

afterEach(async () => {
  await rm(blobDir, { recursive: true, force: true });
});

function service(): BlobService {
  return new BlobService({ blobDir } as AppConfig);
}

async function scanUntilCandidate(blob: BlobService, olderThan: Date, maxEntries: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const scan = await blob.listStaleFrameCandidateKeys({
      olderThan,
      limit: 10,
      maxEntries,
    });
    if (scan.candidates.length > 0 || scan.done) return scan;
  }
  throw new Error('stale frame scan did not make progress to a candidate');
}

async function drainStaleFrameScan(blob: BlobService, olderThan: Date): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const scan = await blob.listStaleFrameCandidateKeys({
      olderThan,
      limit: 10,
      maxEntries: 100,
    });
    if (scan.done) return;
  }
  throw new Error('stale frame scan did not finish a cycle');
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

  it('requires candidate frame attempt tokens to be UUIDs', () => {
    const blob = service();

    expect(() =>
      blob.frameCandidateKey('group-1', 'content-1', 'zectrix-note4-400x300-mono', 'not-a-uuid')
    ).toThrow(/非法 blob attemptToken/);
  });

  it('streams stale frame candidates with bounded per-dirent progress across calls', async () => {
    const blob = service();
    const oldDate = new Date('2026-05-15T04:10:00.000Z');
    const now = new Date('2026-05-17T04:10:00.000Z');
    const key = blob.frameCandidateKey(
      'group-1',
      'content-001',
      'zectrix-note4-400x300-mono',
      '11111111-1111-4111-8111-111111111111'
    );
    for (let index = 0; index < 25; index++) {
      await mkdir(
        join(
          blobDir,
          'frames/zectrix-note4-400x300-mono',
          `empty-${String(index).padStart(2, '0')}`
        ),
        { recursive: true }
      );
    }
    await blob.writeStorageKey(key, 'frame', Buffer.from(key));
    await utimes(blob.storagePath(key), oldDate, oldDate);

    const first = await blob.listStaleFrameCandidateKeys({
      olderThan: now,
      limit: 10,
      maxEntries: 1,
    });

    expect(first.scannedEntries).toBe(1);
    expect(first.candidates).toEqual([]);
    expect(first.done).toBe(false);

    const reached = await scanUntilCandidate(blob, now, 5);

    expect(reached.candidates.map((candidate) => candidate.storageKey)).toContain(key);

    await drainStaleFrameScan(blob, now);
    const restarted = await scanUntilCandidate(blob, now, 100);
    expect(restarted.candidates.map((candidate) => candidate.storageKey)).toContain(key);
  });

  it('does not start a queued stale-frame scan after module destruction begins', async () => {
    const blob = service();
    const scan = blob.listStaleFrameCandidateKeys({
      olderThan: new Date('2026-05-17T04:10:00.000Z'),
      limit: 10,
      maxEntries: 10,
    });
    const destroy = blob.onModuleDestroy();

    await expect(scan).resolves.toEqual({ candidates: [], scannedEntries: 0, done: true });
    await expect(destroy).resolves.toBeUndefined();
    await expect(
      blob.listStaleFrameCandidateKeys({
        olderThan: new Date('2026-05-17T04:10:00.000Z'),
        limit: 10,
        maxEntries: 10,
      })
    ).resolves.toEqual({ candidates: [], scannedEntries: 0, done: true });
  });

  it('serializes iterator shutdown behind an active stale-frame scan', async () => {
    const blob = service();
    let releaseNext!: () => void;
    let markNextStarted!: () => void;
    let closed = false;
    const nextStarted = new Promise<void>((resolve) => {
      markNextStarted = resolve;
    });
    const mayReturnEntry = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    async function* delayedIterator(): AsyncGenerator<Record<string, never>> {
      try {
        markNextStarted();
        await mayReturnEntry;
        yield {};
      } finally {
        closed = true;
      }
    }
    (
      blob as unknown as {
        staleFrameCandidateIterator: AsyncGenerator<Record<string, never>> | null;
      }
    ).staleFrameCandidateIterator = delayedIterator();

    const scan = blob.listStaleFrameCandidateKeys({
      olderThan: new Date('2026-05-17T04:10:00.000Z'),
      limit: 10,
      maxEntries: 1,
    });
    await nextStarted;
    const destroy = blob.onModuleDestroy();
    releaseNext();

    await expect(scan).resolves.toEqual({ candidates: [], scannedEntries: 1, done: false });
    await expect(destroy).resolves.toBeUndefined();
    expect(closed).toBe(true);
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

  it('re-stats under the storage-key queue before conditional stale deletion', async () => {
    const blob = service();
    const key = blob.frameCandidateKey(
      'group-1',
      'content-1',
      'zectrix-note4-400x300-mono',
      '11111111-1111-4111-8111-111111111111'
    );
    const oldDate = new Date('2026-05-15T04:10:00.000Z');
    const touchedAt = new Date('2026-05-17T04:10:00.000Z');
    const cutoff = new Date('2026-05-16T04:10:00.000Z');
    await blob.writeStorageKey(key, 'frame', Buffer.from('frame'));
    await utimes(blob.storagePath(key), oldDate, oldDate);

    const scanned = await blob.listStaleFrameCandidateKeys({
      olderThan: cutoff,
      limit: 10,
    });
    expect(scanned.candidates.map((candidate) => candidate.storageKey)).toEqual([key]);

    await blob.touchStorageKey(key, 'frame', touchedAt);
    await expect(blob.deleteStorageKeyIfOlderThan(key, 'frame', cutoff)).resolves.toBe(false);
    expect(await blob.readStorageKey(key)).toEqual(Buffer.from('frame'));

    await utimes(blob.storagePath(key), oldDate, oldDate);
    await expect(blob.deleteStorageKeyIfOlderThan(key, 'frame', cutoff)).resolves.toBe(true);
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
