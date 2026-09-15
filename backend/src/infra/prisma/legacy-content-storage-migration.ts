import {
  DEFAULT_BOARD_ID,
  frameDescriptorForProfile,
  getBoardDefinition,
  type FrameCodecT,
  type PixelFormatT,
} from 'shared';

export interface LegacyDeviceRow {
  id: string;
}

export interface LegacyContentRow {
  id: string;
  groupId: string;
  kind: 'image' | 'dynamic';
  imageEtag: string;
  imageSize: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LegacyContentStorageSeed {
  devices: readonly LegacyDeviceRow[];
  contents: readonly LegacyContentRow[];
}

export interface DeviceProfileBackfill {
  id: string;
  boardId: string;
  displayProfileId: string;
  protocolVersion: number;
}

export interface UnavailableContentSourceBackfill {
  contentId: string;
  status: 'unavailable';
  sourceEtag: null;
  mimeType: null;
  size: null;
  storageKey: null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReadyContentVariantBackfill {
  id: string;
  contentId: string;
  profileId: string;
  status: 'ready';
  pixelFormat: PixelFormatT;
  frameCodec: FrameCodecT;
  width: number;
  height: number;
  frameEtag: string;
  frameSize: number;
  storageKey: string;
  renderVersion: number;
  lastError: null;
  leaseUntil: null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LegacyContentStorageProjection {
  devices: DeviceProfileBackfill[];
  sources: UnavailableContentSourceBackfill[];
  variants: ReadyContentVariantBackfill[];
}

/**
 * Executable business-semantics model for the legacy SQL backfill. It deliberately does not
 * execute SQL: callers can project seeded legacy rows into the rows the migration must create.
 */
export function projectLegacyContentStorageMigration(
  seed: LegacyContentStorageSeed
): LegacyContentStorageProjection {
  const board = getBoardDefinition(DEFAULT_BOARD_ID);
  const frame = frameDescriptorForProfile(board.display_profile_id);

  return {
    devices: seed.devices.map((device) => ({
      id: device.id,
      boardId: board.id,
      displayProfileId: board.display_profile_id,
      protocolVersion: 2,
    })),
    sources: seed.contents
      .filter((content) => content.kind === 'image')
      .map((content) => ({
        contentId: content.id,
        status: 'unavailable',
        sourceEtag: null,
        mimeType: null,
        size: null,
        storageKey: null,
        createdAt: content.createdAt,
        updatedAt: content.updatedAt,
      })),
    variants: seed.contents.map((content) => ({
      id: content.id,
      contentId: content.id,
      profileId: frame.profile_id,
      status: 'ready',
      pixelFormat: frame.pixel_format,
      frameCodec: frame.frame_codec,
      width: frame.width,
      height: frame.height,
      frameEtag: content.imageEtag,
      frameSize: content.imageSize,
      storageKey: `${content.groupId}/${content.id}.img`,
      renderVersion: 1,
      lastError: null,
      leaseUntil: null,
      attempts: 0,
      createdAt: content.createdAt,
      updatedAt: content.updatedAt,
    })),
  };
}
