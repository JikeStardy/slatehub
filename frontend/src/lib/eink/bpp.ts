import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  FrameDescriptor,
  frameDescriptorForProfile,
  type FrameDescriptorT,
} from 'shared';
import { INK_RGB, PAPER_HEX, PAPER_RGB } from './colors';

export interface DecodedRgbaFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type RawFrameValidation =
  | { ok: true }
  | {
      ok: false;
      reason: 'unsupported-format' | 'invalid-dimensions' | 'invalid-byte-length';
      message: string;
    };

export function clearCanvas(
  ctx: CanvasRenderingContext2D,
  canvas?: { width: number; height: number }
): void {
  ctx.fillStyle = PAPER_HEX;
  ctx.fillRect(0, 0, canvas?.width ?? FRAME_WIDTH, canvas?.height ?? FRAME_HEIGHT);
}

export function decodeBppImage(
  bytes: Uint8Array | ArrayBuffer,
  width: number = FRAME_WIDTH,
  height: number = FRAME_HEIGHT,
  paperColor: readonly [number, number, number] = PAPER_RGB,
  inkColor: readonly [number, number, number] = INK_RGB
): ImageData {
  const byteView = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const data = new ImageData(width, height);
  const bpr = width >> 3;
  const pixels = new Uint32Array(data.data.buffer);
  const paperPixel = rgbaPixel(paperColor);
  const inkPixel = rgbaPixel(inkColor);
  let dst = 0;

  for (let y = 0; y < height; y++) {
    const rowStart = y * bpr;
    for (let byteOffset = 0; byteOffset < bpr; byteOffset++) {
      const byte = byteView[rowStart + byteOffset]!;
      pixels[dst++] = byte & 0b1000_0000 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0100_0000 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0010_0000 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0001_0000 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0000_1000 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0000_0100 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0000_0010 ? paperPixel : inkPixel;
      pixels[dst++] = byte & 0b0000_0001 ? paperPixel : inkPixel;
    }
  }

  return data;
}

export function validateRawFrameDescriptor(descriptor: FrameDescriptorT): RawFrameValidation {
  const parsed = FrameDescriptor.safeParse(descriptor);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid-dimensions',
      message: '帧描述符不匹配 Display Profile',
    };
  }
  const expectedDescriptor = frameDescriptorForProfile(parsed.data.profile_id);
  if (
    parsed.data.width !== expectedDescriptor.width ||
    parsed.data.height !== expectedDescriptor.height ||
    parsed.data.pixel_format !== expectedDescriptor.pixel_format ||
    parsed.data.frame_codec !== expectedDescriptor.frame_codec ||
    parsed.data.byte_length !== expectedDescriptor.byte_length
  ) {
    return {
      ok: false,
      reason: 'invalid-dimensions',
      message: '帧描述符不匹配 Display Profile',
    };
  }
  if (descriptor.pixel_format !== 'mono1' || descriptor.frame_codec !== 'raw_mono1_msb') {
    return {
      ok: false,
      reason: 'unsupported-format',
      message: '仅支持 mono1 + raw_mono1_msb 帧',
    };
  }
  if (descriptor.width <= 0 || descriptor.height <= 0 || descriptor.width % 8 !== 0) {
    return {
      ok: false,
      reason: 'invalid-dimensions',
      message: '帧宽高不合法',
    };
  }
  const expected = (descriptor.width * descriptor.height) / 8;
  if (descriptor.byte_length !== expected) {
    return {
      ok: false,
      reason: 'invalid-byte-length',
      message: `帧长度应为 ${expected} bytes`,
    };
  }
  return { ok: true };
}

export function isValidRawFrameLength(
  bytes: Uint8Array | ArrayBuffer,
  descriptor: FrameDescriptorT
): boolean {
  const byteLength = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length;
  return validateRawFrameDescriptor(descriptor).ok && byteLength === descriptor.byte_length;
}

export function decodeRawFrameToRgba(
  bytes: Uint8Array | ArrayBuffer,
  descriptor: FrameDescriptorT,
  paperColor: readonly [number, number, number] = PAPER_RGB,
  inkColor: readonly [number, number, number] = INK_RGB
): DecodedRgbaFrame {
  const validation = validateRawFrameDescriptor(descriptor);
  if (!validation.ok) throw new Error(validation.message);
  const byteView = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (byteView.byteLength !== descriptor.byte_length) {
    throw new Error(
      `raw frame length mismatch: expected ${descriptor.byte_length}, got ${byteView.byteLength}`
    );
  }

  const data = new Uint8ClampedArray(descriptor.width * descriptor.height * 4);
  const bpr = descriptor.width >> 3;
  let dst = 0;
  for (let y = 0; y < descriptor.height; y++) {
    const rowStart = y * bpr;
    for (let byteOffset = 0; byteOffset < bpr; byteOffset++) {
      const byte = byteView[rowStart + byteOffset]!;
      for (let bit = 7; bit >= 0; bit--) {
        const color = byte & (1 << bit) ? paperColor : inkColor;
        data[dst++] = color[0];
        data[dst++] = color[1];
        data[dst++] = color[2];
        data[dst++] = 255;
      }
    }
  }
  return { width: descriptor.width, height: descriptor.height, data };
}

export function decodeRawFrameToImageData(
  bytes: Uint8Array | ArrayBuffer,
  descriptor: FrameDescriptorT
): ImageData {
  const rgba = decodeRawFrameToRgba(bytes, descriptor);
  const imageDataArray = rgba.data as ImageDataArray;
  return new ImageData(imageDataArray, rgba.width, rgba.height);
}

export function frameRgbaHash(frame: DecodedRgbaFrame): string {
  let inkWeighted = 0;
  let paperWeighted = 0;
  for (let i = 0; i < frame.data.length; i += 4) {
    const pixel = frame.data[i]! + frame.data[i + 1]! + frame.data[i + 2]!;
    if (pixel < 128 * 3) inkWeighted = (inkWeighted + (i / 4 + 1) * pixel) % 100_000_000;
    else paperWeighted = (paperWeighted + (i / 4 + 1) * pixel) % 100_000_000;
  }
  return `${frame.width}x${frame.height}:${inkWeighted}:${paperWeighted}`;
}

export function isValidBppLength(
  bytes: Uint8Array | ArrayBuffer,
  width: number = FRAME_WIDTH,
  height: number = FRAME_HEIGHT
): boolean {
  const byteLength = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length;
  return byteLength === (width * height) / 8;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0a0b0c0d]).buffer)[0] === 0x0d;

function rgbaPixel(color: readonly [number, number, number]): number {
  const [r, g, b] = color;
  return LITTLE_ENDIAN
    ? 0xff000000 | (b << 16) | (g << 8) | r
    : (r << 24) | (g << 16) | (b << 8) | 0xff;
}
