import { describe, expect, it } from 'bun:test';
import { isSimulatorRouteEnabled } from './routes';

describe('simulator route gating', () => {
  it('enables /simulator only in development and test builds', () => {
    expect(isSimulatorRouteEnabled('production')).toBe(false);
    expect(isSimulatorRouteEnabled('development')).toBe(true);
    expect(isSimulatorRouteEnabled('test')).toBe(true);
  });
});
