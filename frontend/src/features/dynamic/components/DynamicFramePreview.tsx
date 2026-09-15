import {
  DEFAULT_DISPLAY_PROFILE_ID,
  frameDescriptorForProfile,
  type FrameDescriptorT,
} from 'shared';
import { Spinner } from '@/components/ui/Spinner';
import { FrameBitmapPreview } from '@/components/eink/FrameBitmapPreview';

export function DynamicFramePreview({
  data,
  pending,
  hasConfig,
  caption,
  descriptor = frameDescriptorForProfile(DEFAULT_DISPLAY_PROFILE_ID),
}: {
  data: ArrayBuffer | null;
  pending: boolean;
  hasConfig: boolean;
  caption?: string | null;
  descriptor?: FrameDescriptorT;
}) {
  const showPlaceholder = !data;
  return (
    <div
      className="frame-preview-surface"
      style={{ aspectRatio: `${descriptor.width} / ${descriptor.height}` }}
    >
      <FrameBitmapPreview data={data} descriptor={descriptor} caption={caption} />
      {showPlaceholder && !pending && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <span className="font-serif italic text-[13px] text-stone-light">
            {hasConfig ? '修改参数后自动更新' : '选择类型后开始配置'}
          </span>
        </div>
      )}
      {pending && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <Spinner />
        </div>
      )}
    </div>
  );
}

export function SavedOrLiveDynamicFramePreview({
  savedData,
  savedPending,
  liveData,
  livePending,
  hasConfig,
  caption,
  descriptor = frameDescriptorForProfile(DEFAULT_DISPLAY_PROFILE_ID),
}: {
  savedData?: ArrayBuffer;
  savedPending?: boolean;
  liveData: ArrayBuffer | null;
  livePending: boolean;
  hasConfig: boolean;
  caption?: string | null;
  descriptor?: FrameDescriptorT;
}) {
  const displayData = liveData ?? savedData ?? null;
  const pending = livePending || (!liveData && Boolean(savedPending));

  return (
    <DynamicFramePreview
      data={displayData}
      pending={pending}
      hasConfig={hasConfig}
      caption={caption}
      descriptor={descriptor}
    />
  );
}
