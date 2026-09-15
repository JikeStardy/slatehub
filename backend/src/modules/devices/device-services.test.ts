import { describe, expect, it } from 'bun:test';
import { Prisma } from '@prisma/client';
import {
  frameDescriptorForProfile,
  type ContentSummaryT,
  type RegisterDeviceRequestT,
} from 'shared';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { DeviceSecretAuthCacheService } from '../../infra/auth/device-secret-auth-cache.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors';
import type { CycleResult, GroupsService } from '../groups/groups.service';
import type { DeviceCurrentContentService } from '../contents/device-current-content.service';
import type { PairCodeService } from './pair-code.service';
import { DeviceFirmwareService } from './device-firmware.service';
import { DeviceManagementService } from './device-management.service';
import type { DevicePollSnapshot, TelemetryInput } from './device-types';

interface DeviceRecord {
  id: string;
  mac: string;
  secretHash: string;
  pairCode: string;
  ownerUserId: string | null;
  selectedGroupId: string | null;
  lastRegisteredAt: Date | null;
  fwVersion: string;
  boardId: string;
  displayProfileId: string;
  protocolVersion: number;
}

interface FindUniqueArgs {
  where: {
    id?: string;
    mac?: string;
    pairCode?: string;
  };
}

interface UpdateArgs {
  where: {
    id?: string;
    mac?: string;
  };
  data: Partial<DeviceRecord>;
}

interface CreateArgs {
  data: Pick<
    DeviceRecord,
    | 'mac'
    | 'secretHash'
    | 'pairCode'
    | 'lastRegisteredAt'
    | 'fwVersion'
    | 'boardId'
    | 'displayProfileId'
    | 'protocolVersion'
  >;
  select: {
    id: true;
  };
}

function createService(record?: DeviceRecord): {
  service: DeviceFirmwareService;
  updates: UpdateArgs[];
  creates: CreateArgs[];
  getRecord: () => DeviceRecord | undefined;
} {
  let current = record;
  const updates: UpdateArgs[] = [];
  const creates: CreateArgs[] = [];
  const deviceApi = {
    findUnique: async (args: FindUniqueArgs) => {
      if (args.where.mac !== undefined) {
        if (!current || current.mac !== args.where.mac) return null;
        return {
          id: current.id,
          ownerUserId: current.ownerUserId,
          lastRegisteredAt: current.lastRegisteredAt,
          secretHash: current.secretHash,
        };
      }
      if (args.where.pairCode !== undefined) return null;
      if (args.where.id !== undefined) {
        if (!current || current.id !== args.where.id) return null;
        return current;
      }
      return null;
    },
    findMany: async () => [],
    update: async (args: UpdateArgs) => {
      updates.push(args);
      if (
        !current ||
        (args.where.mac !== undefined && current.mac !== args.where.mac) ||
        (args.where.id !== undefined && current.id !== args.where.id)
      ) {
        throw new Error('missing device');
      }
      current = { ...current, ...args.data };
      return current;
    },
    create: async (args: CreateArgs) => {
      creates.push(args);
      current = {
        id: 'new-device',
        mac: args.data.mac,
        secretHash: args.data.secretHash,
        pairCode: args.data.pairCode,
        ownerUserId: null,
        selectedGroupId: null,
        lastRegisteredAt: args.data.lastRegisteredAt,
        fwVersion: args.data.fwVersion,
        boardId: args.data.boardId,
        displayProfileId: args.data.displayProfileId,
        protocolVersion: args.data.protocolVersion,
      };
      return { id: current.id };
    },
  };
  const txApi = {
    device: deviceApi,
    $queryRaw: async () => [{ id: current?.ownerUserId ?? 'user-1' }],
  };
  const prisma = {
    device: deviceApi,
    $transaction: async <T>(fn: (tx: typeof txApi) => Promise<T>) => fn(txApi),
  };
  return {
    service: new DeviceFirmwareService(
      prisma as unknown as PrismaService,
      {} as GroupsService,
      { invalidateHash: () => undefined } as unknown as DeviceSecretAuthCacheService,
      currentContentStub(),
      pairCodeStub()
    ),
    updates,
    creates,
    getRecord: () => current,
  };
}

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: 'device-1',
    mac: 'AA:BB:CC:DD:EE:FF',
    secretHash: 'old-secret',
    pairCode: 'ABC234',
    ownerUserId: 'user-1',
    selectedGroupId: 'group-1',
    lastRegisteredAt: null,
    fwVersion: '0.1.0',
    boardId: 'zectrix-note4',
    displayProfileId: 'zectrix-note4-400x300-mono',
    protocolVersion: 2,
    ...overrides,
  };
}

interface PollFrame {
  deviceId: string;
  groupId: string;
  seq: number;
  contentId: string;
  manifestEtag: string;
  content: unknown;
}

function contentSummary(overrides: Partial<ContentSummaryT> = {}): ContentSummaryT {
  return {
    id: 'content-2',
    seq: 2,
    content_etag: 'content-etag-2',
    frame_name: null,
    device_status_bar_text: 'Frame 2',
    image_etag: 'image-etag-2',
    audio_etag: null,
    image_size: 123,
    variant_status: 'ready',
    audio_size: null,
    audio_status: 'none',
    audio_source: null,
    audio_voice: null,
    kind: 'image',
    dynamic_type: null,
    next_wake_sec: null,
    frame: frameDescriptorForProfile('zectrix-note4-400x300-mono'),
    ...overrides,
  };
}

function pollDevice(overrides: Partial<DevicePollSnapshot> = {}): DevicePollSnapshot {
  return {
    id: 'device-1',
    mac: 'AA:BB:CC:DD:EE:FF',
    name: null,
    ownerUserId: 'user-1',
    selectedGroupId: 'group-1',
    pairCode: 'ABC234',
    selectedGroup: { manifestEtag: 'manifest-1' },
    boardId: 'zectrix-note4',
    displayProfileId: 'zectrix-note4-400x300-mono',
    protocolVersion: 2,
    ...overrides,
  };
}

function pollGroup(overrides: Partial<CycleResult> = {}): CycleResult {
  return {
    groupId: 'group-1',
    name: 'Group',
    structureEtag: 'structure-1',
    manifestEtag: 'manifest-1',
    sortOrder: 0,
    contentCount: 3,
    position: { current: 1, total: 1 },
    ...overrides,
  };
}

function pollFrame(overrides: Partial<PollFrame> = {}): PollFrame {
  return {
    deviceId: 'device-1',
    groupId: 'group-1',
    seq: 2,
    contentId: 'content-2',
    manifestEtag: 'manifest-1',
    content: {},
    ...overrides,
  };
}

function createPollService(
  opts: {
    device?: DevicePollSnapshot;
    group?: CycleResult;
    currentFrame?: PollFrame | null;
    refreshedFrame?: PollFrame | null;
    currentContent?: ContentSummaryT | null;
    profileManifestEtag?: string;
  } = {}
): {
  service: DeviceFirmwareService;
  calls: {
    telemetryUpdates: unknown[];
    resolved: Array<{ device: DevicePollSnapshot; telemetry: TelemetryInput | undefined }>;
    refreshed: Array<{ frame: PollFrame | null; device: DevicePollSnapshot }>;
    currentContent: unknown[];
    manifestEtags: unknown[];
  };
} {
  const deviceSnapshot = opts.device ?? pollDevice();
  const groupSnapshot = opts.group ?? pollGroup();
  const calls = {
    telemetryUpdates: [] as unknown[],
    resolved: [] as Array<{ device: DevicePollSnapshot; telemetry: TelemetryInput | undefined }>,
    refreshed: [] as Array<{ frame: PollFrame | null; device: DevicePollSnapshot }>,
    currentContent: [] as unknown[],
    manifestEtags: [] as unknown[],
  };
  const prisma = {
    device: {
      update: async (args: unknown) => {
        calls.telemetryUpdates.push(args);
        return deviceSnapshot;
      },
    },
  };
  const groups = {
    describeDeviceGroupSnapshot: async () => groupSnapshot,
  };
  const currentContent = {
    resolveCurrentContentRequest: async (
      device: DevicePollSnapshot,
      telemetry: TelemetryInput | undefined
    ) => {
      calls.resolved.push({ device, telemetry });
      return opts.currentFrame === undefined ? pollFrame() : opts.currentFrame;
    },
    refreshCurrentContentForDeviceIfDue: async (
      frame: PollFrame | null,
      device: DevicePollSnapshot
    ) => {
      calls.refreshed.push({ frame, device });
      return opts.refreshedFrame === undefined ? frame : opts.refreshedFrame;
    },
    currentContentForDevice: (frame: unknown) => {
      calls.currentContent.push(frame);
      return opts.currentContent === undefined ? contentSummary() : opts.currentContent;
    },
    manifestEtagForDeviceGroup: async (device: DevicePollSnapshot, groupId: string) => {
      calls.manifestEtags.push({ device, groupId });
      return opts.profileManifestEtag ?? 'manifest-1';
    },
  };
  return {
    service: new DeviceFirmwareService(
      prisma as unknown as PrismaService,
      groups as unknown as GroupsService,
      { invalidateHash: () => undefined } as unknown as DeviceSecretAuthCacheService,
      currentContent as unknown as DeviceCurrentContentService,
      pairCodeStub()
    ),
    calls,
  };
}

describe('DeviceFirmwareService.registerOrReset', () => {
  it('creates a new device with lastRegisteredAt', async () => {
    const { service, creates, getRecord } = createService();

    const result = await service.registerOrReset(registerRequest());

    expect(result.deviceId).toBe('new-device');
    expect(result.reclaimed).toBe(false);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.data.lastRegisteredAt).toBeInstanceOf(Date);
    expect(creates[0]!.data).toMatchObject({
      boardId: 'zectrix-note4',
      displayProfileId: 'zectrix-note4-400x300-mono',
      protocolVersion: 2,
      fwVersion: '0.2.0',
    });
    expect(getRecord()?.lastRegisteredAt).toBeInstanceOf(Date);
  });

  it('rejects a bound device reset inside the throttle window', async () => {
    const { service, updates, getRecord } = createService(
      device({ lastRegisteredAt: new Date(Date.now() - 1_000) })
    );

    await expect(service.registerOrReset(registerRequest())).rejects.toThrow(ConflictError);

    expect(updates).toHaveLength(0);
    expect(getRecord()?.ownerUserId).toBe('user-1');
    expect(getRecord()?.selectedGroupId).toBe('group-1');
  });

  it('rejects an unowned device reset inside the throttle window', async () => {
    const { service, updates, getRecord } = createService(
      device({
        ownerUserId: null,
        selectedGroupId: null,
        lastRegisteredAt: new Date(Date.now() - 1_000),
      })
    );

    await expect(service.registerOrReset(registerRequest())).rejects.toThrow(ConflictError);

    expect(updates).toHaveLength(0);
    expect(getRecord()?.ownerUserId).toBeNull();
  });

  it('allows a bound device reset after the throttle window', async () => {
    const { service, updates, getRecord } = createService(
      device({ lastRegisteredAt: new Date(Date.now() - 61_000) })
    );

    const result = await service.registerOrReset(registerRequest());

    expect(result.reclaimed).toBe(true);
    expect(updates).toHaveLength(1);
    expect(getRecord()?.ownerUserId).toBeNull();
    expect(getRecord()?.selectedGroupId).toBeNull();
    expect(updates[0]!.data).toMatchObject({
      boardId: 'zectrix-note4',
      displayProfileId: 'zectrix-note4-400x300-mono',
      protocolVersion: 2,
      fwVersion: '0.2.0',
    });
  });

  it('normalizes raw MAC input before looking up an existing device', async () => {
    const { service, updates, getRecord } = createService(
      device({ mac: 'AA:BB:CC:DD:EE:FF', lastRegisteredAt: new Date(Date.now() - 61_000) })
    );

    const result = await service.registerOrReset(registerRequest({ mac: 'aa-bb-cc-dd-ee-ff' }));

    expect(result.deviceId).toBe('device-1');
    expect(result.reclaimed).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.where).toEqual({ id: 'device-1' });
    expect(updates[0]!.data.mac).toBe('AA:BB:CC:DD:EE:FF');
    expect(getRecord()?.mac).toBe('AA:BB:CC:DD:EE:FF');
  });
});

function registerRequest(overrides: Partial<RegisterDeviceRequestT> = {}): RegisterDeviceRequestT {
  return {
    mac: 'AA:BB:CC:DD:EE:FF',
    board_id: 'zectrix-note4',
    protocol_version: 2,
    fw_version: '0.2.0',
    ...overrides,
  };
}

describe('DeviceFirmwareService.poll', () => {
  it('returns current_content for a non-timer poll when the current manifest still matches', async () => {
    const currentContent = contentSummary({ id: 'content-2', seq: 2 });
    const { service, calls } = createPollService({ currentContent });
    const telemetry: TelemetryInput = {
      wake_reason: 'button',
      current_group: 'group-1',
      current_content_seq: 2,
      manifest_etag: 'manifest-1',
    };

    const state = await service.poll('device-1', telemetry);

    expect(calls.resolved).toHaveLength(1);
    expect(calls.resolved[0]!.telemetry).toEqual(telemetry);
    expect(calls.refreshed).toHaveLength(0);
    expect(calls.currentContent).toHaveLength(1);
    expect(state.current_content).toEqual(currentContent);
  });

  it('returns null current_content when the selected group manifest no longer matches', async () => {
    const { service, calls } = createPollService({
      profileManifestEtag: 'manifest-2',
      currentFrame: pollFrame({ manifestEtag: 'manifest-1' }),
    });

    const state = await service.poll('device-1', {
      wake_reason: 'button',
      current_group: 'group-1',
      current_content_seq: 2,
      manifest_etag: 'manifest-1',
    });

    expect(calls.currentContent).toHaveLength(0);
    expect(state.current_content).toBeNull();
  });

  it('refreshes the current dynamic content before returning timer poll state', async () => {
    const currentFrame = pollFrame({ contentId: 'content-before' });
    const refreshedFrame = pollFrame({ contentId: 'content-after' });
    const { service, calls } = createPollService({ currentFrame, refreshedFrame });

    const state = await service.poll('device-1', {
      wake_reason: 'timer',
      current_group: 'group-1',
      current_content_seq: 2,
      manifest_etag: 'manifest-1',
    });

    expect(calls.refreshed).toEqual([{ frame: currentFrame, device: pollDevice() }]);
    expect(calls.currentContent).toEqual([refreshedFrame]);
    expect(state.current_content?.id).toBe('content-2');
  });

  it('returns group and current_content against the profile-specific manifest etag', async () => {
    const currentContent = contentSummary({ id: 'content-2', seq: 2 });
    const { service } = createPollService({
      group: pollGroup({ manifestEtag: 'legacy-global-manifest' }),
      currentFrame: pollFrame({ manifestEtag: 'profile-manifest' }),
      currentContent,
    });
    const currentContentService = service[
      'currentContent'
    ] as unknown as DeviceCurrentContentService & {
      manifestEtagForDeviceGroup: () => Promise<string>;
    };
    currentContentService.manifestEtagForDeviceGroup = async () => 'profile-manifest';

    const state = await service.poll('device-1', {
      wake_reason: 'button',
      current_group: 'group-1',
      current_content_seq: 2,
      manifest_etag: 'profile-manifest',
    });

    expect(state.group?.manifest_etag).toBe('profile-manifest');
    expect(state.current_content).toEqual(currentContent);
  });
});

function createClaimService(
  record?: DeviceRecord,
  opts: {
    raceOnUpdate?: 'P2025' | 'P2002';
    raceTarget?: string[];
    ownerGroups?: { id: string }[];
  } = {}
): {
  service: DeviceManagementService;
  updates: { where: unknown; data: Partial<DeviceRecord> }[];
  getRecord: () => DeviceRecord | undefined;
} {
  let current = record;
  const updates: { where: unknown; data: Partial<DeviceRecord> }[] = [];
  const deviceApi = {
    findUnique: async (args: { where: { pairCode?: string } }) => {
      if (!current || args.where.pairCode !== current.pairCode) return null;
      return current;
    },
    findMany: async () => [],
    findFirst: async () => ({ sortOrder: 1 }),
    update: async (args: {
      where: { id?: string; ownerUserId?: string | null };
      data: Partial<DeviceRecord> & { sortOrder?: number };
    }) => {
      updates.push(args);
      if (opts.raceOnUpdate) {
        throw new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: opts.raceOnUpdate,
          clientVersion: 'test',
          meta: opts.raceTarget ? { target: opts.raceTarget } : undefined,
        });
      }
      if (
        !current ||
        args.where.id !== current.id ||
        (args.where.ownerUserId !== undefined && args.where.ownerUserId !== current.ownerUserId)
      ) {
        throw new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: 'test',
        });
      }
      current = { ...current, ...args.data };
      return current;
    },
  };
  const txApi = {
    device: deviceApi,
    $queryRaw: async () => [{ id: 'user-2' }],
  };
  const prisma = {
    device: deviceApi,
    $transaction: async <T>(fn: (tx: typeof txApi) => Promise<T>) => fn(txApi),
  };
  const groups = {
    listOwnerGroups: async () =>
      opts.ownerGroups ?? [
        {
          id: 'group-1',
          name: 'Group 1',
          structureEtag: 'structure-1',
          manifestEtag: 'manifest-1',
          sortOrder: 0,
          _count: { contents: 0 },
        },
      ],
  };
  return {
    service: new DeviceManagementService(
      prisma as unknown as PrismaService,
      groups as unknown as GroupsService,
      pairCodeStub()
    ),
    updates,
    getRecord: () => current,
  };
}

function pairCodeStub(code = 'NEW234'): PairCodeService {
  return {
    generateUniquePairCode: async () => code,
  } as unknown as PairCodeService;
}

function currentContentStub(): DeviceCurrentContentService {
  return {} as unknown as DeviceCurrentContentService;
}

describe('DeviceManagementService.claimByPairCode', () => {
  it('claims an unowned device and assigns the first owner group', async () => {
    const { service, getRecord } = createClaimService(
      device({
        ownerUserId: null,
        selectedGroupId: null,
        displayProfileId: 'virtual-mono-296x128',
        protocolVersion: 7,
      })
    );

    const result = await service.claimByPairCode('ABC234', 'user-2');

    expect(result.id).toBe('device-1');
    expect(result.owner_user_id).toBe('user-2');
    expect(result.selected_group_id).toBe('group-1');
    expect(result.sort_order).toBe(2);
    expect(result).toMatchObject({
      board_id: 'zectrix-note4',
      display_profile_id: 'virtual-mono-296x128',
      protocol_version: 7,
    });
    expect(getRecord()?.pairCode).not.toBe('ABC234');
  });

  it('leaves an empty selected_group_id when owner has no group yet', async () => {
    const { service } = createClaimService(device({ ownerUserId: null, selectedGroupId: null }), {
      ownerGroups: [],
    });

    const result = await service.claimByPairCode('ABC234', 'user-2');

    expect(result.selected_group_id).toBeNull();
  });

  it('returns a clear not-found error for an invalid pair code', async () => {
    const { service } = createClaimService(device({ ownerUserId: null, selectedGroupId: null }));

    await expect(service.claimByPairCode('NOPE99', 'user-2')).rejects.toThrow(NotFoundError);
  });

  it('rejects with forbidden when device is already owned by another user', async () => {
    const { service, updates } = createClaimService(
      device({ ownerUserId: 'user-1', selectedGroupId: 'group-1' })
    );

    await expect(service.claimByPairCode('ABC234', 'user-2')).rejects.toThrow(ForbiddenError);
    // 不应尝试任何 update。
    expect(updates).toHaveLength(0);
  });

  it('is a no-op when the same owner re-claims their own device', async () => {
    const { service, updates, getRecord } = createClaimService(
      device({ ownerUserId: 'user-1', selectedGroupId: 'group-1' })
    );

    const result = await service.claimByPairCode('ABC234', 'user-1');

    expect(result.owner_user_id).toBe('user-1');
    // 同 owner re-claim：不应轮换 pairCode、不应改 sortOrder。
    expect(updates).toHaveLength(0);
    expect(getRecord()?.pairCode).toBe('ABC234');
  });

  it('maps concurrent CAS misses (P2025) to conflict instead of a generic prisma error', async () => {
    const { service } = createClaimService(device({ ownerUserId: null, selectedGroupId: null }), {
      raceOnUpdate: 'P2025',
    });

    await expect(service.claimByPairCode('ABC234', 'user-2')).rejects.toThrow(ConflictError);
  });

  it('maps pair_code unique-constraint collisions (P2002) to conflict as well', async () => {
    const { service } = createClaimService(device({ ownerUserId: null, selectedGroupId: null }), {
      raceOnUpdate: 'P2002',
      raceTarget: ['pair_code'],
    });

    await expect(service.claimByPairCode('ABC234', 'user-2')).rejects.toThrow(ConflictError);
  });
});
