import { describe, expect, it } from 'bun:test';
import { frameDescriptorForProfile } from 'shared';
import {
  drawRawFrameToCanvas,
  rawFrameToPngBlob,
  validateFetchedFrameBytes,
} from './simulator-canvas';

const virtual = frameDescriptorForProfile('virtual-mono-296x128');

class TestImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;

  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

globalThis.ImageData = TestImageData as typeof ImageData;

describe('simulator canvas and fetched raw frame validation', () => {
  it('accepts exactly 4736-byte virtual frames and rejects 4735 bytes', () => {
    expect(
      validateFetchedFrameBytes(new ArrayBuffer(virtual.byte_length), virtual).bytes
    ).toHaveLength(4736);
    expect(() =>
      validateFetchedFrameBytes(new ArrayBuffer(virtual.byte_length - 1), virtual)
    ).toThrow('raw frame length mismatch');
  });

  it('draws decoded pixels to canvas with descriptor dimensions', () => {
    const canvas = createCanvasDouble();
    const bytes = new Uint8Array(virtual.byte_length).fill(0xff);
    bytes[0] = 0b0100_0000;

    const drawn = drawRawFrameToCanvas(canvas, bytes, virtual);

    expect(canvas.width).toBe(296);
    expect(canvas.height).toBe(128);
    expect(drawn.width).toBe(296);
    expect(drawn.height).toBe(128);
    expect(Array.from(canvas.context.imageData!.data.slice(0, 8))).toEqual([
      20, 17, 13, 255, 245, 243, 237, 255,
    ]);
  });

  it('exports PNG from the exact drawn canvas pixels and propagates toBlob errors', async () => {
    const canvas = createCanvasDouble();
    const bytes = new Uint8Array(virtual.byte_length).fill(0xff);
    bytes[0] = 0;

    await expect(rawFrameToPngBlob(canvas, bytes, virtual)).resolves.toBe(canvas.blob);
    expect(canvas.context.imageData?.data[0]).toBe(20);
    expect(canvas.pixelsAtBlob?.[0]).toBe(20);

    const failing = createCanvasDouble({ failBlob: true });
    await expect(rawFrameToPngBlob(failing, bytes, virtual)).rejects.toThrow('PNG 导出失败');
  });
});

function createCanvasDouble({ failBlob = false } = {}) {
  const context: { imageData: ImageData | null; putImageData: (data: ImageData) => void } = {
    imageData: null,
    putImageData(data: ImageData) {
      this.imageData = data;
    },
  };
  const blob = new Blob(['png'], { type: 'image/png' });
  return {
    width: 0,
    height: 0,
    context,
    blob,
    pixelsAtBlob: null as Uint8ClampedArray | null,
    getContext(type: string) {
      return type === '2d' ? context : null;
    },
    toBlob(callback: (blob: Blob | null) => void, type?: string) {
      expect(type).toBe('image/png');
      this.pixelsAtBlob = context.imageData?.data ?? null;
      callback(failBlob ? null : blob);
    },
  };
}
