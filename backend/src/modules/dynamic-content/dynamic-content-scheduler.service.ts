import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../../infra/config/app.config';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { formatError } from '../../common/utils/error-format';
import { WorkerLoop } from '../../common/worker/worker-loop';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';
import { claimLeaseJobs } from '../../common/worker/lease-claim';

const WORKER_INTERVAL_MS = 10_000;
const WORKER_BATCH_SIZE = 5;
const LEASE_MS = 180_000;
const RETRY_BASE_DELAY_MS = 15_000;
const RETRY_MAX_DELAY_MS = 10 * 60_000;
const MAX_IDLE_SLEEP_MS = 5 * 60_000;

interface RefreshJob {
  id: string;
  dynamicType: string;
  attempts: number;
  leaseUntil: Date;
  leaseToken: string;
}

@Injectable()
export class DynamicContentSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DynamicContentSchedulerService.name);
  private readonly loop: WorkerLoop;

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly renderer: DynamicContentRendererService
  ) {
    this.loop = new WorkerLoop({
      run: () => this.runBatch(),
      onError: (err) => {
        this.logger.warn(
          `Dynamic refresh scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`
        );
      },
      fallbackDelayMs: WORKER_INTERVAL_MS,
    });
  }

  onModuleInit(): void {
    if (!this.config.backgroundWorkers) return;
    this.loop.start(0);
  }

  onModuleDestroy(): void {
    this.loop.stop();
  }

  async tick(): Promise<void> {
    await this.loop.tick();
  }

  private async runBatch(): Promise<number> {
    const jobs = await this.claimDueJobs(WORKER_BATCH_SIZE);
    await Promise.all(
      jobs.map((job) =>
        this.renderDue(job).catch(async (err: unknown) => {
          this.logger.warn(
            `Dynamic refresh job failed for content ${job.id} of type ${job.dynamicType}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          await this.markRetry(job, err).catch((retryErr: unknown) => {
            this.logger.error(
              `Dynamic refresh retry marker failed for content ${job.id}: ${formatError(retryErr)}`
            );
          });
        })
      )
    );
    await this.renderer.cleanupStaleDynamicRenderCandidates().catch((err: unknown) => {
      this.logger.warn(`Dynamic render candidate GC failed: ${formatError(err)}`);
    });
    return jobs.length >= WORKER_BATCH_SIZE ? 0 : this.nextDelayMs(jobs.length > 0);
  }

  private async claimDueJobs(limit: number): Promise<RefreshJob[]> {
    const now = new Date();
    const rows = await this.prisma.content.findMany({
      where: {
        kind: 'dynamic',
        dynamicType: { not: null },
        dynamicRefreshDueAt: { not: null, lte: now },
        OR: [{ dynamicRefreshLeaseUntil: null }, { dynamicRefreshLeaseUntil: { lte: now } }],
      },
      orderBy: [{ dynamicRefreshDueAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true, dynamicType: true, dynamicRefreshAttempts: true },
    });
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    return claimLeaseJobs(
      rows,
      (row) => {
        const leaseToken = randomUUID();
        return row.dynamicType
          ? {
              id: row.id,
              dynamicType: row.dynamicType,
              attempts: row.dynamicRefreshAttempts + 1,
              leaseUntil,
              leaseToken,
            }
          : null;
      },
      async (row, job) => {
        const claimed = await this.prisma.content.updateMany({
          where: {
            id: row.id,
            kind: 'dynamic',
            dynamicRefreshDueAt: { not: null, lte: now },
            OR: [{ dynamicRefreshLeaseUntil: null }, { dynamicRefreshLeaseUntil: { lte: now } }],
          },
          data: {
            dynamicRefreshLeaseUntil: leaseUntil,
            dynamicRefreshLeaseToken: job.leaseToken,
            dynamicRefreshAttempts: { increment: 1 },
          },
        });
        return claimed.count === 1;
      }
    );
  }

  private async renderDue(job: RefreshJob): Promise<void> {
    const result = await this.renderer.renderDynamicContent(job.id, {
      schedulerLeaseUntil: job.leaseUntil,
      schedulerLeaseToken: job.leaseToken,
    });
    this.logger.log(
      `Dynamic content ${job.id} of type ${job.dynamicType} was refreshed and ${
        result.unchanged ? 'did not change' : 'changed'
      }.`
    );
  }

  private async nextDelayMs(jobsWereRendered: boolean): Promise<number> {
    if (jobsWereRendered) return WORKER_INTERVAL_MS;
    const now = new Date();
    const next = await this.prisma.content.findFirst({
      where: {
        kind: 'dynamic',
        dynamicType: { not: null },
        dynamicRefreshDueAt: { not: null, gt: now },
      },
      orderBy: { dynamicRefreshDueAt: 'asc' },
      select: { dynamicRefreshDueAt: true },
    });
    if (!next?.dynamicRefreshDueAt) return MAX_IDLE_SLEEP_MS;
    return Math.min(
      Math.max(next.dynamicRefreshDueAt.getTime() - now.getTime(), WORKER_INTERVAL_MS),
      MAX_IDLE_SLEEP_MS
    );
  }

  private async markRetry(job: RefreshJob, err: unknown): Promise<void> {
    const now = new Date();
    const delayMs = Math.min(
      RETRY_MAX_DELAY_MS,
      RETRY_BASE_DELAY_MS * 2 ** Math.max(job.attempts - 1, 0)
    );
    const retryAt = new Date(now.getTime() + delayMs);
    await this.prisma.content.updateMany({
      where: {
        id: job.id,
        kind: 'dynamic',
        dynamicRefreshLeaseToken: job.leaseToken,
      },
      data: {
        dynamicLastError: formatError(err).slice(0, 512),
        dynamicNextRunAt: retryAt,
        dynamicRefreshDueAt: retryAt,
        dynamicRefreshLeaseUntil: null,
        dynamicRefreshLeaseToken: null,
      },
    });
  }
}
