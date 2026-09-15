import { describe, expect, it } from 'bun:test';
import {
  API_PREFIX,
  FrameDescriptor,
  RegisterDeviceRequest,
  PreviewDynamicContentRequest,
  displayProfilesForEnvironment,
  frameByteLength,
  getBoardDefinition,
  getDisplayProfile,
} from '../src/index.js';

describe('display profile registry', () => {
  it('maps the Note4 board to its unique production display profile', () => {
    const board = getBoardDefinition('zectrix-note4');

    expect(board.display_profile_id).toBe('zectrix-note4-400x300-mono');
    expect(getDisplayProfile(board.display_profile_id)).toMatchObject({
      id: 'zectrix-note4-400x300-mono',
      width: 400,
      height: 300,
      pixel_format: 'mono_1bpp_msb',
      frame_codec: 'raw',
    });
  });

  it('keeps profile identifiers unique and exposes the virtual profile only outside production', () => {
    const developmentProfiles = displayProfilesForEnvironment('development');
    const productionProfiles = displayProfilesForEnvironment('production');

    expect(new Set(developmentProfiles.map((profile) => profile.id)).size).toBe(
      developmentProfiles.length
    );
    expect(developmentProfiles.map((profile) => profile.id)).toContain('virtual-mono-296x128');
    expect(productionProfiles.map((profile) => profile.id)).not.toContain('virtual-mono-296x128');
  });

  it('derives packed mono frame sizes from profile dimensions', () => {
    expect(frameByteLength(getDisplayProfile('zectrix-note4-400x300-mono'))).toBe(15000);
    expect(frameByteLength(getDisplayProfile('virtual-mono-296x128'))).toBe(4736);
  });

  it('rejects unimplemented pixel formats through frame descriptor validation', () => {
    const result = FrameDescriptor.safeParse({
      profile_id: 'zectrix-note4-400x300-mono',
      width: 400,
      height: 300,
      pixel_format: 'gray_4bpp',
      frame_codec: 'raw',
      byte_length: 60000,
    });

    expect(result.success).toBe(false);
  });
});

describe('v2 device and render payloads', () => {
  it('requires board, protocol, firmware, and display profile fields', () => {
    expect(API_PREFIX).toBe('/api/v2');
    expect(
      RegisterDeviceRequest.safeParse({
        mac: 'AA:BB:CC:DD:EE:FF',
        board_id: 'zectrix-note4',
        protocol_version: 2,
        fw_version: '0.2.0',
      }).success
    ).toBe(true);
    expect(RegisterDeviceRequest.safeParse({ mac: 'AA:BB:CC:DD:EE:FF' }).success).toBe(false);
    expect(
      PreviewDynamicContentRequest.safeParse({
        config: { type: 'daily_calendar', tz: 'Asia/Shanghai' },
        display_profile_id: 'unsupported-profile',
      }).success
    ).toBe(false);
  });
});
