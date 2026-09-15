import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceSummaryT } from 'shared';
import { DeviceStatusGrid } from './DeviceStatusGrid';

describe('DeviceStatusGrid profile metadata', () => {
  it('renders board, profile, protocol and firmware fields', () => {
    const markup = renderToStaticMarkup(
      <DeviceStatusGrid device={device()} online lastSeenAgo="刚刚" />
    );

    expect(markup).toContain('zectrix-note4');
    expect(markup).toContain('zectrix-note4-400x300-mono');
    expect(markup).toContain('v2');
    expect(markup).toContain('0.2.0');
  });
});

function device(): DeviceSummaryT {
  return {
    id: 'device-1',
    mac: 'AA:BB:CC:DD:EE:FF',
    name: 'Desk',
    selected_group_id: null,
    last_seen_at: new Date().toISOString(),
    battery_pct: 88,
    rssi_dbm: -55,
    fw_version: '0.2.0',
    board_id: 'zectrix-note4',
    display_profile_id: 'zectrix-note4-400x300-mono',
    protocol_version: 2,
    owner_user_id: 'user-1',
    sort_order: 0,
  };
}
