import { useQuery } from '@tanstack/react-query';
import { API_PREFIX, api } from '@/lib/http';
import { contentKeys } from './keys';

export function useContentImage(
  contentId: string,
  etag: string | null | undefined,
  displayProfileId?: string | null
) {
  return useQuery({
    queryKey: contentKeys.image(contentId, etag, displayProfileId),
    queryFn: async () => {
      const { data } = await api.get<ArrayBuffer>(`${API_PREFIX}/contents/${contentId}/image`, {
        responseType: 'arraybuffer',
        params: displayProfileId ? { display_profile_id: displayProfileId } : undefined,
      });
      return data;
    },
    staleTime: Infinity,
    enabled: !!contentId && !!etag,
  });
}
