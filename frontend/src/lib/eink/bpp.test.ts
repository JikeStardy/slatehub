import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_DISPLAY_PROFILE_ID,
  frameDescriptorForProfile,
  type FrameDescriptorT,
} from 'shared';
import {
  decodeRawFrameToRgba,
  frameRgbaHash,
  isValidRawFrameLength,
  validateRawFrameDescriptor,
} from './bpp';

const note4 = frameDescriptorForProfile(DEFAULT_DISPLAY_PROFILE_ID);
const virtual = frameDescriptorForProfile('virtual-mono-296x128');

describe('descriptor-driven raw mono frame decoding', () => {
  it('rejects unsupported descriptors and exact length mismatches', () => {
    expect(
      validateRawFrameDescriptor({ ...note4, frame_codec: 'png' } as unknown as FrameDescriptorT).ok
    ).toBe(false);
    expect(
      validateRawFrameDescriptor({
        ...note4,
        pixel_format: 'gray4',
      } as unknown as FrameDescriptorT).ok
    ).toBe(false);
    expect(validateRawFrameDescriptor({ ...note4, byte_length: note4.byte_length - 1 }).ok).toBe(
      false
    );
    expect(isValidRawFrameLength(new Uint8Array(note4.byte_length - 1), note4)).toBe(false);
    expect(isValidRawFrameLength(new Uint8Array(note4.byte_length), note4)).toBe(true);
  });

  it('decodes Note4 and virtual profile dimensions from descriptors', () => {
    expect(decodeRawFrameToRgba(new Uint8Array(note4.byte_length).fill(0xff), note4)).toMatchObject(
      {
        width: 400,
        height: 300,
      }
    );
    expect(
      decodeRawFrameToRgba(new Uint8Array(virtual.byte_length).fill(0xff), virtual)
    ).toMatchObject({
      width: 296,
      height: 128,
    });
  });

  it('keeps canvas pixels and PNG encoder input pixels identical for deterministic mono bytes', () => {
    const bytes = new Uint8Array(virtual.byte_length);
    bytes.fill(0xff);
    bytes[0] = 0b1010_0000;

    const rgba = decodeRawFrameToRgba(bytes, virtual);

    expect(Array.from(rgba.data.slice(0, 16))).toEqual([
      245, 243, 237, 255, 20, 17, 13, 255, 245, 243, 237, 255, 20, 17, 13, 255,
    ]);
    expect(frameRgbaHash(rgba)).toBe('296x128:1600:82658400');
  });
});
