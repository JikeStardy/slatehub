import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_DISPLAY_PROFILE_ID,
  DynamicConfig,
  type DisplayProfileIdT,
  type DynamicConfigT,
  type DynamicTypeT,
} from 'shared';
import { effectiveDynamicFrameName } from '@/features/dynamic/model/display-name';
import { usePreviewDynamicContent } from '@/features/dynamic/query/dynamic-content-queries';

type PreviewContentType = DynamicTypeT | 'image';

export function useDynamicPreview({
  contentId,
  type,
  config,
  frameName,
  dashboardData,
  displayProfileId = DEFAULT_DISPLAY_PROFILE_ID,
  debounceMs = 800,
}: {
  contentId?: string;
  type: PreviewContentType | null;
  config: DynamicConfigT | null;
  frameName: string;
  dashboardData?: Record<string, unknown> | null;
  displayProfileId?: DisplayProfileIdT;
  debounceMs?: number;
}) {
  const preview = usePreviewDynamicContent(contentId);
  const [livePreviewData, setLivePreviewData] = useState<ArrayBuffer | null>(null);
  const previewSeq = useRef(0);
  const previewMutate = preview.mutate;

  const invalidatePreview = useCallback(() => {
    previewSeq.current++;
    setLivePreviewData(null);
  }, []);

  useEffect(() => {
    if (!config || type === 'image' || type === null) {
      invalidatePreview();
      return;
    }
    const parsed = DynamicConfig.safeParse(config);
    if (!parsed.success) {
      invalidatePreview();
      return;
    }
    const seq = ++previewSeq.current;
    setLivePreviewData(null);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewMutate(
        {
          config: parsed.data,
          displayProfileId,
          frameName: effectiveDynamicFrameName(type, parsed.data, frameName),
          data: parsed.data.type === 'dashboard' ? (dashboardData ?? undefined) : undefined,
          signal: controller.signal,
        },
        {
          onSuccess: (data) => {
            if (seq === previewSeq.current) setLivePreviewData(data);
          },
          onError: () => {
            if (seq === previewSeq.current) setLivePreviewData(null);
          },
        }
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    config,
    dashboardData,
    debounceMs,
    displayProfileId,
    frameName,
    invalidatePreview,
    previewMutate,
    type,
  ]);

  return { livePreviewData, previewPending: preview.isPending, invalidatePreview };
}
