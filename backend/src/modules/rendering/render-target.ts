import {
  DEFAULT_DISPLAY_PROFILE_ID,
  type DisplayProfileT,
  frameByteLength,
  getDisplayProfile,
} from 'shared';
import { ValidationError } from '../../common/errors';

export type RenderLayoutFamily = 'note4' | 'compact';

export interface RenderTarget {
  profileId: string;
  width: number;
  height: number;
  pixelFormat: DisplayProfileT['pixel_format'];
  frameCodec: DisplayProfileT['frame_codec'];
  byteLength: number;
  layoutFamily: RenderLayoutFamily;
}

export interface MonoFrameCanvas {
  readonly width: number;
  readonly height: number;
  toRaw1bpp(): Buffer;
}

export function renderTargetForProfile(profileId: string): RenderTarget {
  return renderTargetFromProfile(getDisplayProfile(profileId));
}

export function renderTargetFromProfile(profile: DisplayProfileT): RenderTarget {
  return {
    profileId: profile.id,
    width: profile.width,
    height: profile.height,
    pixelFormat: profile.pixel_format,
    frameCodec: profile.frame_codec,
    byteLength: frameByteLength(profile),
    layoutFamily: layoutFamilyForProfile(profile.id),
  };
}

export const NOTE4_RENDER_TARGET = renderTargetForProfile(DEFAULT_DISPLAY_PROFILE_ID);

export function assertSupportedMonoEncoding(target: RenderTarget): void {
  if (target.pixelFormat !== 'mono1' || target.frameCodec !== 'raw_mono1_msb') {
    throw new ValidationError(`不支持的帧编码: ${target.pixelFormat}/${target.frameCodec}`, {
      code: 'unsupported_frame_encoding',
    });
  }
}

export function assertFrameSize(buf: Buffer, target: RenderTarget): void {
  if (buf.length !== target.byteLength) {
    throw new ValidationError(
      `帧大小不匹配: 当前 ${buf.length} 字节, 期望 ${target.byteLength} 字节`,
      { code: 'frame_size_mismatch' }
    );
  }
}

export function encodeMonoFrame(canvas: MonoFrameCanvas, target: RenderTarget): Buffer {
  assertSupportedMonoEncoding(target);
  if (canvas.width !== target.width || canvas.height !== target.height) {
    throw new ValidationError(
      `画布尺寸不匹配: 当前 ${canvas.width}x${canvas.height}, 期望 ${target.width}x${target.height}`,
      { code: 'canvas_size_mismatch' }
    );
  }
  const raw = canvas.toRaw1bpp();
  assertFrameSize(raw, target);
  return raw;
}

function layoutFamilyForProfile(profileId: string): RenderLayoutFamily {
  switch (profileId) {
    case 'zectrix-note4-400x300-mono':
      return 'note4';
    case 'virtual-mono-296x128':
      return 'compact';
    default:
      throw new ValidationError(`尚未实现 display profile: ${profileId}`, {
        code: 'display_profile_not_renderable',
      });
  }
}
