import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppConfig } from '../../infra/config/app.config';

export interface CacheKeyParts {
  sourceEtag: string;
  profileId: string;
  width: number;
  height: number;
  pixelFormat: string;
  frameCodec: string;
  threshold: number;
  mode: string;
  autoInvert: boolean;
  letterbox: boolean;
}

const GC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GC_MAX_AGE_DAYS = 7;

@Injectable()
export class ImageRenderCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImageRenderCacheService.name);
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  private readonly cacheRoot: string;
  private gcTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly config: AppConfig) {
    this.cacheRoot = resolve(this.config.blobDir, 'image-render-cache');
  }

  onModuleInit(): void {
    this.scheduleGc(GC_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.gcTimer) clearTimeout(this.gcTimer);
    this.gcTimer = null;
  }

  key(parts: CacheKeyParts): string {
    const raw = [
      parts.sourceEtag,
      parts.profileId,
      parts.width,
      parts.height,
      parts.pixelFormat,
      parts.frameCodec,
      parts.threshold,
      parts.mode,
      parts.autoInvert ? 1 : 0,
      parts.letterbox ? 1 : 0,
    ].join('|');
    return createHash('sha1').update(raw).digest('hex');
  }

  /** {BLOB_DIR}/image-render-cache/{key0..2}/{key}.bin —— 两层 hex 前缀避免单目录爆 inode。 */
  path(key: string): string {
    return resolve(this.cacheRoot, key.slice(0, 2), `${key}.bin`);
  }

  async tryRead(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  /**
   * 命中缓存直接返；未命中调 compute() 算并落盘。
   * 同 key 并发时只跑一次 compute。
   */
  async getOrCompute(
    key: string,
    compute: () => Promise<Buffer>
  ): Promise<{ data: Buffer; fromCache: boolean }> {
    const hit = await this.tryRead(key);
    if (hit) return { data: hit, fromCache: true };

    const flight = this.inFlight.get(key);
    if (flight) {
      const data = await flight;
      return { data, fromCache: true };
    }

    const promise = (async () => {
      try {
        const data = await compute();
        await this.write(key, data);
        return data;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    const data = await promise;
    return { data, fromCache: false };
  }

  /** 按 mtime 清掉 maxAgeDays 之前的条目（cron-friendly，不依赖 noatime 挂载行为）。 */
  async gc(maxAgeDays: number): Promise<{ removed: number }> {
    const root = this.cacheRoot;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
      await stat(root);
    } catch {
      return { removed: 0 };
    }

    for (const prefix of await readdir(root)) {
      const dir = join(root, prefix);
      for (const file of await readdir(dir).catch(() => [])) {
        const fp = join(dir, file);
        try {
          const s = await stat(fp);
          if (s.mtimeMs < cutoff) {
            await unlink(fp);
            removed++;
          }
        } catch {
          /* skip */
        }
      }
      await rmdir(dir).catch((err: unknown) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
          this.logger.warn(
            `Image render cache GC failed to remove empty prefix ${prefix}: ${formatCacheError(err)}`
          );
        }
      });
    }
    this.logger.log(
      `Image render cache GC removed ${removed} entries older than ${maxAgeDays} day(s).`
    );
    return { removed };
  }

  private scheduleGc(delayMs: number): void {
    this.gcTimer = setTimeout(() => {
      void this.gc(GC_MAX_AGE_DAYS)
        .catch((err: unknown) => {
          this.logger.warn(
            `Image render cache GC failed for root ${this.cacheRoot}: ${formatCacheError(err)}`
          );
        })
        .finally(() => this.scheduleGc(GC_INTERVAL_MS));
    }, delayMs);
    this.gcTimer.unref?.();
  }
}

function formatCacheError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
