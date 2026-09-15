import { useMutation } from '@tanstack/react-query';
import {
  type ContentMutationResponseT,
  type CreateDynamicContentRequestT,
  type DisplayProfileIdT,
  type DynamicConfigT,
  type IngestResponseT,
} from 'shared';
import { API_PREFIX, api } from '@/lib/http';
import { useInvalidateContentDependencies } from '@/features/contents/query/content-cache-helpers';

export function useCreateDynamicContent(gid: string) {
  const invalidate = useInvalidateContentDependencies(gid);
  return useMutation({
    mutationFn: async (body: CreateDynamicContentRequestT) => {
      const { data } = await api.post<ContentMutationResponseT>(
        `${API_PREFIX}/groups/${gid}/contents`,
        body,
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
      return data;
    },
    onSuccess: (data) => {
      invalidate(data.id);
    },
  });
}

export function useUpdateDynamicContent(gid: string) {
  const invalidate = useInvalidateContentDependencies(gid);
  return useMutation({
    mutationFn: async ({
      contentId,
      frameName,
      config,
    }: {
      contentId: string;
      frameName?: string | null;
      config?: DynamicConfigT;
    }) => {
      const body: { frame_name?: string | null; config?: DynamicConfigT } = {};
      if (frameName !== undefined) body.frame_name = frameName;
      if (config !== undefined) body.config = config;
      const { data } = await api.patch<ContentMutationResponseT>(
        `${API_PREFIX}/contents/${contentId}`,
        body
      );
      return data;
    },
    onSuccess: (data) => {
      invalidate(data.id);
    },
  });
}

export function useRefreshDynamicContent(gid: string) {
  const invalidate = useInvalidateContentDependencies(gid);
  return useMutation({
    mutationFn: async (contentId: string) => {
      const { data } = await api.post<IngestResponseT>(
        `${API_PREFIX}/contents/${contentId}/refresh`
      );
      return data;
    },
    onSuccess: (_data, contentId) => {
      invalidate(contentId);
    },
  });
}

export function usePreviewDynamicContent(contentId: string | undefined) {
  return useMutation({
    mutationFn: async ({
      config,
      displayProfileId,
      frameName,
      data: previewData,
      signal,
    }: {
      config: DynamicConfigT;
      displayProfileId: DisplayProfileIdT;
      frameName?: string | null;
      data?: Record<string, unknown>;
      signal?: AbortSignal;
    }) => {
      const url = contentId
        ? `${API_PREFIX}/contents/${contentId}/preview`
        : `${API_PREFIX}/contents/preview`;
      const body = buildDynamicPreviewBody({
        config,
        displayProfileId,
        frameName,
        data: previewData,
      });
      const { data } = await api.post<ArrayBuffer>(url, body, {
        responseType: 'arraybuffer',
        signal,
      });
      return data;
    },
  });
}

export function buildDynamicPreviewBody({
  config,
  displayProfileId,
  frameName,
  data,
}: {
  config: DynamicConfigT;
  displayProfileId: DisplayProfileIdT;
  frameName?: string | null;
  data?: Record<string, unknown>;
}) {
  return {
    config,
    display_profile_id: displayProfileId,
    frame_name: frameName,
    data,
  };
}
