import { Injectable } from '@nestjs/common';
import type { ContentVariant } from '@prisma/client';
import { displayProfilesForEnvironment } from 'shared';
import { ValidationError } from '../../common/errors';
import { computeETag } from '../../common/utils/etag';
import { formatError } from '../../common/utils/error-format';
import { BlobService } from '../../infra/blob/blob.service';
import { AppConfig } from '../../infra/config/app.config';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { KeyedPromiseQueue } from '../../common/worker/keyed-promise-queue';
import {
  assertFrameSize,
  assertSupportedMonoEncoding,
  renderTargetFromProfile,
  type RenderTarget,
} from './render-target';

const MAX_VARIANT_ERROR_LENGTH = 512;

export interface RenderContentVariantsInput {
  groupId: string;
  contentId: string;
  render: (target: RenderTarget) => Buffer | Promise<Buffer>;
}

export interface VariantRenderResult {
  profileId: string;
  status: 'ready' | 'failed';
  changed: boolean;
  frameEtag?: string;
  frameSize?: number;
  storageKey?: string;
  renderVersion?: number;
  error?: string;
}

export interface RenderContentVariantsResult {
  contentId: string;
  renderVersion: number;
  results: VariantRenderResult[];
}

@Injectable()
export class VariantRenderService {
  private readonly renderQueue = new KeyedPromiseQueue();

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly config: AppConfig
  ) {}

  async renderContentVariants(
    input: RenderContentVariantsInput
  ): Promise<RenderContentVariantsResult> {
    return this.renderQueue.run(input.contentId, () => this.renderContentVariantsExclusive(input));
  }

  private async renderContentVariantsExclusive(
    input: RenderContentVariantsInput
  ): Promise<RenderContentVariantsResult> {
    const profiles = displayProfilesForEnvironment(this.config.nodeEnv);
    const renderVersion = await this.nextRenderVersion(input.contentId);
    const results: VariantRenderResult[] = [];

    for (const profile of profiles) {
      let target: RenderTarget;
      try {
        target = this.resolveRenderTarget(profile);
      } catch (err: unknown) {
        results.push(profileBoundaryFailure(profile.id, err));
        continue;
      }

      let previous: ContentVariant | null;
      try {
        previous = await this.findVariant(input.contentId, target.profileId);
      } catch (err: unknown) {
        results.push(profileBoundaryFailure(profile.id, err));
        continue;
      }

      results.push(await this.renderOne(input, target, previous, renderVersion));
    }

    return { contentId: input.contentId, renderVersion, results };
  }

  protected resolveRenderTarget(
    profile: Parameters<typeof renderTargetFromProfile>[0]
  ): RenderTarget {
    return renderTargetFromProfile(profile);
  }

  private async renderOne(
    input: RenderContentVariantsInput,
    target: RenderTarget,
    previous: ContentVariant | null,
    renderVersion: number
  ): Promise<VariantRenderResult> {
    try {
      assertSupportedMonoEncoding(target);
      const frame = await input.render(target);
      assertFrameSize(frame, target);
      return await this.commitReadyVariant(input, target, previous, frame, renderVersion);
    } catch (err: unknown) {
      return this.commitFailedVariant(input.contentId, target, previous, err, renderVersion);
    }
  }

  private async commitReadyVariant(
    input: RenderContentVariantsInput,
    target: RenderTarget,
    previous: ContentVariant | null,
    frame: Buffer,
    renderVersion: number
  ): Promise<VariantRenderResult> {
    const storageKey = this.blob.frameKey(input.groupId, input.contentId, target.profileId);
    const previousBytes = await this.blob.readStorageKey(storageKey);
    const frameEtag = computeETag(frame);

    await this.blob.writeStorageKey(storageKey, 'frame', frame);
    try {
      const row = await this.prisma.contentVariant.upsert({
        where: { contentId_profileId: { contentId: input.contentId, profileId: target.profileId } },
        create: {
          contentId: input.contentId,
          profileId: target.profileId,
          status: 'ready',
          pixelFormat: target.pixelFormat,
          frameCodec: target.frameCodec,
          width: target.width,
          height: target.height,
          frameEtag,
          frameSize: frame.length,
          storageKey,
          renderVersion,
          lastError: null,
          leaseUntil: null,
          attempts: 0,
        },
        update: {
          status: 'ready',
          pixelFormat: target.pixelFormat,
          frameCodec: target.frameCodec,
          width: target.width,
          height: target.height,
          frameEtag,
          frameSize: frame.length,
          storageKey,
          renderVersion,
          lastError: null,
          leaseUntil: null,
          attempts: 0,
        },
      });
      return readyResult(row, true);
    } catch (err: unknown) {
      const rollbackErr = await this.rollbackBlobWrite(storageKey, previousBytes).then(
        () => null,
        (rollbackError: unknown) => rollbackError
      );
      if (rollbackErr) {
        return failedRollbackResult(target.profileId, err, rollbackErr);
      }
      return this.failedPersistenceResult(target.profileId, previous, err);
    }
  }

  private async commitFailedVariant(
    contentId: string,
    target: RenderTarget,
    previous: ContentVariant | null,
    err: unknown,
    renderVersion: number
  ): Promise<VariantRenderResult> {
    const error = boundedError(err);
    const attempts = (previous?.attempts ?? 0) + 1;
    const priorReady = previous?.status === 'ready' && previous.frameEtag && previous.storageKey;

    try {
      const row = await this.prisma.contentVariant.upsert({
        where: { contentId_profileId: { contentId, profileId: target.profileId } },
        create: {
          contentId,
          profileId: target.profileId,
          status: 'failed',
          pixelFormat: target.pixelFormat,
          frameCodec: target.frameCodec,
          width: target.width,
          height: target.height,
          frameEtag: null,
          frameSize: null,
          storageKey: null,
          renderVersion,
          lastError: error,
          leaseUntil: null,
          attempts,
        },
        update: priorReady
          ? {
              status: 'ready',
              lastError: error,
              leaseUntil: null,
              attempts,
            }
          : {
              status: 'failed',
              pixelFormat: target.pixelFormat,
              frameCodec: target.frameCodec,
              width: target.width,
              height: target.height,
              frameEtag: null,
              frameSize: null,
              storageKey: null,
              renderVersion,
              lastError: error,
              leaseUntil: null,
              attempts,
            },
      });

      if (row.status === 'ready') return { ...readyResult(row, false), error };
      return { profileId: target.profileId, status: 'failed', changed: true, error };
    } catch (persistErr: unknown) {
      return this.failedPersistenceResult(target.profileId, previous, persistErr);
    }
  }

  private async rollbackBlobWrite(storageKey: string, previousBytes: Buffer | null): Promise<void> {
    if (previousBytes) {
      await this.blob.writeStorageKey(storageKey, 'frame', previousBytes);
      return;
    }
    await this.blob.deleteStorageKey(storageKey);
  }

  private failedPersistenceResult(
    profileId: string,
    previous: ContentVariant | null,
    err: unknown
  ): VariantRenderResult {
    const error = boundedError(err);
    if (
      previous?.status === 'ready' &&
      previous.frameEtag &&
      previous.frameSize &&
      previous.storageKey
    ) {
      return {
        profileId,
        status: 'ready',
        changed: false,
        frameEtag: previous.frameEtag,
        frameSize: previous.frameSize,
        storageKey: previous.storageKey,
        renderVersion: previous.renderVersion,
        error,
      };
    }
    return { profileId, status: 'failed', changed: false, error };
  }

  private async findVariant(contentId: string, profileId: string): Promise<ContentVariant | null> {
    return this.prisma.contentVariant.findUnique({
      where: { contentId_profileId: { contentId, profileId } },
    });
  }

  private async nextRenderVersion(contentId: string): Promise<number> {
    const variants = await this.prisma.contentVariant.findMany({
      where: { contentId },
      select: { renderVersion: true },
    });
    return Math.max(0, ...variants.map((variant) => variant.renderVersion)) + 1;
  }
}

function readyResult(
  row: Pick<
    ContentVariant,
    'profileId' | 'frameEtag' | 'frameSize' | 'storageKey' | 'renderVersion'
  >,
  changed: boolean
): VariantRenderResult {
  if (!row.frameEtag || row.frameSize === null || !row.storageKey) {
    throw new ValidationError('ready variant 缺少帧元数据', { code: 'invalid_ready_variant' });
  }
  return {
    profileId: row.profileId,
    status: 'ready',
    changed,
    frameEtag: row.frameEtag,
    frameSize: row.frameSize,
    storageKey: row.storageKey,
    renderVersion: row.renderVersion,
  };
}

function profileBoundaryFailure(profileId: string, err: unknown): VariantRenderResult {
  return { profileId, status: 'failed', changed: false, error: boundedError(err) };
}

function failedRollbackResult(
  profileId: string,
  persistErr: unknown,
  rollbackErr: unknown
): VariantRenderResult {
  return {
    profileId,
    status: 'failed',
    changed: false,
    error: `${boundedError(persistErr)}; blob rollback failed: ${boundedError(rollbackErr)}`,
  };
}

function boundedError(err: unknown): string {
  return formatError(err).slice(0, MAX_VARIANT_ERROR_LENGTH);
}
