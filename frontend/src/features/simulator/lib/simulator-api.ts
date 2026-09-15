import type { ContentSummaryT } from 'shared';
import { API_PREFIX, api } from '@/lib/http';
import { validateFetchedFrameBytes, type ValidatedRawFrame } from './simulator-canvas';

export async function fetchFrameBytes(
  content: ContentSummaryT,
  profileId: string
): Promise<ValidatedRawFrame> {
  const { data } = await api.get<ArrayBuffer>(`${API_PREFIX}/contents/${content.id}/image`, {
    responseType: 'arraybuffer',
    params: { display_profile_id: profileId },
  });
  return validateFetchedFrameBytes(data, content.frame);
}
