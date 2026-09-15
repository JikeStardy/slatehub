import type { Prisma } from '@prisma/client';
import { DEFAULT_BOARD_ID, DEFAULT_DISPLAY_PROFILE_ID, type DeviceSummaryT } from 'shared';
import type { DeviceGroupSnapshot } from '../groups/groups.service';

export interface TelemetryInput {
  battery_pct?: number;
  rssi_dbm?: number;
  fw_version?: string;
  wake_reason?: 'timer' | 'button' | 'power_on' | 'charge' | 'other';
  current_group?: string | null;
  current_content_seq?: number;
  current_content_etag?: string;
  manifest_etag?: string;
}

export interface DevicePollSnapshot extends DeviceGroupSnapshot {
  id: string;
  mac: string;
  name: string | null;
  ownerUserId: string | null;
  selectedGroupId: string | null;
  pairCode: string;
  selectedGroup: { manifestEtag: string } | null;
}

export const DEVICE_SUMMARY_SELECT = {
  id: true,
  mac: true,
  name: true,
  selectedGroupId: true,
  lastSeenAt: true,
  batteryPct: true,
  rssiDbm: true,
  fwVersion: true,
  ownerUserId: true,
  sortOrder: true,
} as const satisfies Prisma.DeviceSelect;

export type DeviceRow = Prisma.DeviceGetPayload<{ select: typeof DEVICE_SUMMARY_SELECT }>;

export const DEVICE_CLAIM_SELECT = {
  ...DEVICE_SUMMARY_SELECT,
  pairCode: true,
} as const satisfies Prisma.DeviceSelect;

export function toDeviceSummary(d: DeviceRow): DeviceSummaryT {
  return {
    id: d.id,
    mac: d.mac,
    name: d.name,
    selected_group_id: d.selectedGroupId,
    last_seen_at: d.lastSeenAt?.toISOString() ?? null,
    battery_pct: d.batteryPct,
    rssi_dbm: d.rssiDbm,
    fw_version: d.fwVersion,
    board_id: DEFAULT_BOARD_ID,
    display_profile_id: DEFAULT_DISPLAY_PROFILE_ID,
    protocol_version: 2,
    owner_user_id: d.ownerUserId,
    sort_order: d.sortOrder,
  };
}
