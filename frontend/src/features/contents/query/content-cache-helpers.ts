import { useCallback } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ContentDetailT } from 'shared';
import { groupKeys } from '@/features/groups/query/keys';
import { contentKeys } from './keys';

const AUDIO_GENERATING_REFETCH_INTERVAL_MS = 2500;

type AudioStatusRow = Pick<ContentDetailT, 'audio_status'>;
type AudioStatusQueryData = AudioStatusRow | AudioStatusRow[];

export function audioGenerationRefetchInterval(query: { state: { data?: AudioStatusQueryData } }) {
  const data = query.state.data;
  const hasGeneratingAudio = Array.isArray(data)
    ? data.some(isGeneratingAudio)
    : isGeneratingAudio(data);
  return hasGeneratingAudio ? AUDIO_GENERATING_REFETCH_INTERVAL_MS : false;
}

export function useInvalidateContentDependencies(gid: string) {
  const qc = useQueryClient();
  return useCallback(
    (contentId?: string) => invalidateContentDependencies(qc, gid, contentId),
    [gid, qc]
  );
}

function isGeneratingAudio(row: AudioStatusRow | undefined): boolean {
  return row?.audio_status === 'pending' || row?.audio_status === 'generating';
}

export async function invalidateContentDependencies(
  qc: QueryClient,
  gid: string,
  contentId?: string
) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: contentKeys.groupRoot(gid) }),
    qc.invalidateQueries({ queryKey: groupKeys.list }),
    qc.invalidateQueries({ queryKey: groupKeys.detail(gid) }),
  ]);
  if (contentId) {
    await qc.invalidateQueries({ queryKey: contentKeys.detailRoot(contentId) });
    qc.removeQueries({ queryKey: contentKeys.imageRoot(contentId) });
    qc.removeQueries({ queryKey: contentKeys.audioRoot(contentId) });
  }
}

export function applyOptimisticContentOrder(
  qc: QueryClient,
  groupKey: ReturnType<typeof contentKeys.group>,
  order: string[]
): ContentDetailT[] | undefined {
  const previous = qc.getQueryData<ContentDetailT[]>(groupKey);
  if (previous) {
    const byId = new Map(previous.map((c) => [c.id, c]));
    const reordered: ContentDetailT[] = order
      .map((id, idx) => {
        const item = byId.get(id);
        return item ? { ...item, seq: idx } : undefined;
      })
      .filter((c): c is ContentDetailT => c !== undefined);
    qc.setQueryData<ContentDetailT[]>(groupKey, reordered);
  }
  return previous;
}
