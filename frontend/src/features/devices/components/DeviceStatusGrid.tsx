import { Wifi } from 'lucide-react';
import type { DeviceSummaryT } from 'shared';
import { rssiLabel } from '@/features/devices/lib/rssi';
import { BatteryLevelIcon } from './BatteryLevelIcon';
import { DeviceMetaCard } from './DeviceMetaCard';

export function DeviceStatusGrid({
  device,
  online,
  lastSeenAgo,
}: {
  device: DeviceSummaryT;
  online: boolean;
  lastSeenAgo: string;
}) {
  const battery = device.battery_pct;

  return (
    <section>
      <h3 className="font-sans text-[12px] uppercase tracking-wide text-stone mb-2">状态</h3>
      <div className="grid grid-cols-2 gap-3">
        <DeviceMetaCard
          icon={<BatteryLevelIcon level={battery} size={16} />}
          label="电量"
          value={online && battery != null ? `${battery}%` : '—'}
          warn={online && battery != null && battery < 20}
          stale={!online}
        />
        <DeviceMetaCard
          icon={<Wifi size={16} />}
          label="信号"
          value={online && device.rssi_dbm != null ? `${device.rssi_dbm} dBm` : '—'}
          hint={online ? rssiLabel(device.rssi_dbm) : undefined}
          stale={!online}
        />
        <DeviceMetaCard label="固件" value={device.fw_version ?? '—'} mono />
        <DeviceMetaCard label="协议" value={`v${device.protocol_version}`} mono />
        <DeviceMetaCard label="Board" value={device.board_id} mono />
        <DeviceMetaCard label="Profile" value={device.display_profile_id} mono />
        <DeviceMetaCard label="心跳" value={lastSeenAgo} />
      </div>
    </section>
  );
}
