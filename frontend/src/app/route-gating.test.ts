import { describe, expect, it } from 'bun:test';
import { isSimulatorRouteEnabled, layoutNavItems } from './routes';

describe('simulator route gating', () => {
  it('enables /simulator only in development and test builds', () => {
    expect(isSimulatorRouteEnabled('production')).toBe(false);
    expect(isSimulatorRouteEnabled('development')).toBe(true);
    expect(isSimulatorRouteEnabled('test')).toBe(true);
  });

  it('excludes simulator navigation in production', () => {
    expect(
      layoutNavItems('production', true, '/simulator', '设备模拟器').some(
        (item) => item.href === '/simulator'
      )
    ).toBe(false);
    expect(
      layoutNavItems('development', true, '/simulator', '设备模拟器').some(
        (item) => item.href === '/simulator'
      )
    ).toBe(true);
    expect(layoutNavItems('development', false)).toEqual([]);
  });
});
