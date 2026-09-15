import { DEFAULT_DISPLAY_PROFILE_ID, frameDescriptorForProfile } from 'shared';
import type { DitherMode, FrameDescriptorT } from 'shared';
import type { RefObject } from 'react';
import { cn } from '@/lib/cn';
import { StatusBarOverlay } from '@/components/eink/StatusBarOverlay';
import { usePreviewCanvasRenderer } from './usePreviewCanvasRenderer';

interface PreviewCanvasProps {
  imageFile: File | null;
  existingImage: ArrayBuffer | undefined;
  existingImagePending?: boolean;
  descriptor?: FrameDescriptorT;
  threshold: number;
  mode: DitherMode;
  scale: number;
  offset: { x: number; y: number };
  onOffsetChange: (o: { x: number; y: number }) => void;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  statusCaption?: string | null;
  showStatusBar?: boolean;
}

export function PreviewCanvas({
  imageFile,
  existingImage,
  existingImagePending,
  descriptor = frameDescriptorForProfile(DEFAULT_DISPLAY_PROFILE_ID),
  threshold,
  mode,
  scale,
  offset,
  onOffsetChange,
  canvasRef,
  statusCaption,
  showStatusBar = true,
}: PreviewCanvasProps) {
  const authoringDescriptor = imageFile
    ? frameDescriptorForProfile(DEFAULT_DISPLAY_PROFILE_ID)
    : descriptor;
  const pan = usePreviewCanvasRenderer({
    imageFile,
    existingImage,
    threshold,
    mode,
    scale,
    offset,
    onOffsetChange,
    canvasRef,
    descriptor: authoringDescriptor,
  });

  return (
    <div
      className="frame-preview-surface"
      style={{ aspectRatio: `${authoringDescriptor.width} / ${authoringDescriptor.height}` }}
    >
      {existingImagePending && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">加载中…</span>
        </div>
      )}
      {!imageFile && !existingImage && !existingImagePending && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">选图后显示预览</span>
        </div>
      )}
      {imageFile && (
        <div className="absolute inset-0 flex items-end justify-center pb-3 pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">
            拖拽定位 · 滑块缩放
          </span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={authoringDescriptor.width}
        height={authoringDescriptor.height}
        className={cn('block w-full h-full', pan.isDragging && 'cursor-grabbing')}
        style={{
          imageRendering: 'auto',
          cursor: imageFile ? 'grab' : 'default',
        }}
        onPointerDown={pan.onPointerDown}
        onPointerMove={pan.onPointerMove}
        onPointerUp={pan.onPointerUp}
        onPointerCancel={pan.onPointerUp}
      />
      {showStatusBar && <StatusBarOverlay caption={statusCaption} />}
    </div>
  );
}
