import type { FrameDescriptorT } from 'shared';
import {
  decodeRawFrameToImageData,
  isValidRawFrameLength,
  validateRawFrameDescriptor,
} from '@/lib/eink/bpp';

export interface ValidatedRawFrame {
  bytes: Uint8Array;
  descriptor: FrameDescriptorT;
}

export interface RawFrameCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): Pick<CanvasRenderingContext2D, 'putImageData'> | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

export function validateFetchedFrameBytes(
  data: ArrayBuffer,
  descriptor: FrameDescriptorT
): ValidatedRawFrame {
  const descriptorValidation = validateRawFrameDescriptor(descriptor);
  if (!descriptorValidation.ok) throw new Error(descriptorValidation.message);
  const bytes = new Uint8Array(data);
  if (!isValidRawFrameLength(bytes, descriptor)) {
    throw new Error(
      `raw frame length mismatch: expected ${descriptor.byte_length}, got ${bytes.byteLength}`
    );
  }
  return { bytes, descriptor };
}

export function drawRawFrameToCanvas(
  canvas: RawFrameCanvas,
  bytes: Uint8Array,
  descriptor: FrameDescriptorT
): ImageData {
  canvas.width = descriptor.width;
  canvas.height = descriptor.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 Canvas');
  const imageData = decodeRawFrameToImageData(bytes, descriptor);
  ctx.putImageData(imageData, 0, 0);
  return imageData;
}

export async function rawFrameToPngBlob(
  canvas: RawFrameCanvas,
  bytes: Uint8Array,
  descriptor: FrameDescriptorT
): Promise<Blob> {
  drawRawFrameToCanvas(canvas, bytes, descriptor);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('PNG 导出失败'))),
      'image/png'
    );
  });
}
