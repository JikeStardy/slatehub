import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import {
  DEFAULT_DISPLAY_PROFILE_ID,
  frameDescriptorForProfile,
  type FrameDescriptorT,
} from 'shared';
import { cn } from '@/lib/cn';
import { clearCanvas, decodeRawFrameToImageData, isValidRawFrameLength } from '@/lib/eink/bpp';
import { StatusBarOverlay } from './StatusBarOverlay';

interface FrameBitmapPreviewProps {
  data?: ArrayBuffer | null;
  descriptor?: FrameDescriptorT;
  caption?: string | null;
  className?: string;
  showStatusBar?: boolean;
}

export function FrameBitmapPreview({
  data,
  descriptor = frameDescriptorForProfile(DEFAULT_DISPLAY_PROFILE_ID),
  caption,
  className,
  showStatusBar = true,
}: FrameBitmapPreviewProps) {
  const canvasRef = useContentBitmap(data, descriptor);

  return (
    <div
      className={cn(
        'relative flex h-full w-full items-center justify-center overflow-hidden bg-paper',
        className
      )}
      style={{ aspectRatio: `${descriptor.width} / ${descriptor.height}` }}
    >
      <canvas
        ref={canvasRef}
        width={descriptor.width}
        height={descriptor.height}
        className="block max-h-full max-w-full"
        style={{
          aspectRatio: `${descriptor.width} / ${descriptor.height}`,
          height: 'auto',
          imageRendering: 'pixelated',
          width: '100%',
        }}
      />
      {showStatusBar && <StatusBarOverlay caption={caption} />}
    </div>
  );
}

function useContentBitmap(data: ArrayBuffer | null | undefined, descriptor: FrameDescriptorT) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageData = useMemo(() => decodeContentBitmap(data, descriptor), [data, descriptor]);

  useLayoutEffect(() => {
    drawContentBitmap(canvasRef.current, imageData, descriptor);
  }, [descriptor, imageData]);

  return useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
  }, []);
}

function drawContentBitmap(
  canvas: HTMLCanvasElement | null,
  data: ImageData | null,
  descriptor: FrameDescriptorT
): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!data) {
    clearCanvas(ctx, descriptor);
    return;
  }

  ctx.putImageData(data, 0, 0);
}

function decodeContentBitmap(
  data: ArrayBuffer | null | undefined,
  descriptor: FrameDescriptorT
): ImageData | null {
  if (!data) return null;
  const bytes = new Uint8Array(data);
  if (!isValidRawFrameLength(bytes, descriptor)) return null;
  return decodeRawFrameToImageData(bytes, descriptor);
}
