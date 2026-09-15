import { useQuery } from '@tanstack/react-query';
import type { ContentDetailT } from 'shared';
import { API_PREFIX, api } from '@/lib/http';
import { audioGenerationRefetchInterval } from './content-cache-helpers';
import { contentKeys } from './keys';

export function useGroupContents(gid: string | undefined, displayProfileId?: string | null) {
  return useQuery({
    queryKey: contentKeys.group(gid, displayProfileId),
    queryFn: async () => {
      const { data } = await api.get<ContentDetailT[]>(`${API_PREFIX}/groups/${gid}/contents`, {
        params: displayProfileId ? { display_profile_id: displayProfileId } : undefined,
      });
      return data;
    },
    enabled: !!gid,
    refetchInterval: audioGenerationRefetchInterval,
  });
}

export function useContentDetail(contentId: string | undefined, displayProfileId?: string | null) {
  return useQuery({
    queryKey: contentKeys.detail(contentId, displayProfileId),
    queryFn: async () => {
      const { data } = await api.get<ContentDetailT>(`${API_PREFIX}/contents/${contentId}`, {
        params: displayProfileId ? { display_profile_id: displayProfileId } : undefined,
      });
      return data;
    },
    enabled: !!contentId,
    refetchInterval: audioGenerationRefetchInterval,
  });
}
