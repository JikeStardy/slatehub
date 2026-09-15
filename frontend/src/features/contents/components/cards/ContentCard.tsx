import { memo } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { ContentDetailT } from 'shared';
import { DragHandle } from '@/components/ui/DragHandle';
import { useRefreshDynamicContent } from '@/features/dynamic/query/dynamic-content-queries';
import { useContentImage } from '@/features/contents/query/content-image-queries';
import { useMutationAction } from '@/hooks/useMutationAction';
import { AudioPlayPreview } from '../audio/AudioPlayPreview';
import { AudioStatusBadge } from './AudioStatusBadge';
import { ContentCardActions } from './ContentCardActions';
import { ContentCardShell } from './ContentCardShell';
import { useDeleteContentWithConfirm } from '@/features/contents/hooks/useDeleteContentWithConfirm';
import { FrameBitmapPreview } from '@/components/eink/FrameBitmapPreview';
import { useSortableStyle } from '@/components/dnd/useSortableStyle';
import { compatibilityLabel } from '@/features/contents/lib/variant-status';

interface ContentCardProps {
  gid: string;
  content: ContentDetailT;
  onEdit: (content: ContentDetailT) => void;
}

export const ContentCard = memo(function ContentCard({ gid, content, onEdit }: ContentCardProps) {
  const isDynamic = content.kind === 'dynamic';
  const refresh = useRefreshDynamicContent(gid);
  const { deleteWithConfirm, isPending: deletePending } = useDeleteContentWithConfirm({
    gid,
    content,
  });
  const img = useContentImage(content.id, content.image_etag, content.frame.profile_id);
  const variantReady = content.variant_status === 'ready';
  const { attributes, listeners, setNodeRef, style, isDragging } = useSortableStyle(content.id);
  const refreshContent = useMutationAction<string>({
    isPending: refresh.isPending,
    run: (contentId, callbacks) => refresh.mutate(contentId, callbacks),
    successToast: '已刷新',
    errorToast: '刷新失败',
  });

  return (
    <ContentCardShell
      nodeRef={setNodeRef}
      style={style}
      isDragging={isDragging}
      loading={variantReady && img.isPending}
      error={variantReady && !!img.error}
      frameName={content.frame_name}
      seq={content.seq}
      preview={
        <FrameBitmapPreview
          data={img.data}
          descriptor={content.frame}
          caption={content.device_status_bar_text}
          showStatusBar={false}
        />
      }
      mediaMeta={
        <span className="absolute bottom-2 left-2 bg-paper border border-ink px-1.5 font-mono text-[10px] pointer-events-none">
          {content.frame.width}x{content.frame.height}
        </span>
      }
      topRight={
        <AudioStatusBadge
          status={content.audio_status}
          etag={content.audio_etag}
          error={isDynamic ? content.audio_error : undefined}
        />
      }
      titleMeta={
        content.variant_status !== 'ready' ? (
          <p
            className="mt-0.5 flex items-center gap-1 truncate font-sans text-[11px] text-clay"
            title={compatibilityLabel(content.variant_status)}
          >
            <AlertCircle size={11} className="shrink-0" />
            <span className="truncate">{compatibilityLabel(content.variant_status)}</span>
          </p>
        ) : isDynamic && content.dynamic_render_error ? (
          <p
            className="mt-0.5 flex items-center gap-1 truncate font-sans text-[11px] text-clay"
            title={content.dynamic_render_error}
          >
            <AlertCircle size={11} className="shrink-0" />
            <span className="truncate">{content.dynamic_render_error}</span>
          </p>
        ) : undefined
      }
      actions={
        <ContentCardActions
          dragHandle={<DragHandle attributes={attributes} listeners={listeners} />}
          extraActions={
            isDynamic ? (
              <button
                type="button"
                onClick={() => refreshContent(content.id)}
                aria-label="立即刷新"
                title="立即刷新"
                disabled={refresh.isPending}
                className="p-1.5 text-stone hover:text-ink hover:bg-cream transition-colors disabled:opacity-50"
              >
                <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : undefined} />
              </button>
            ) : null
          }
          audioPreview={
            content.audio_etag ? (
              <AudioPlayPreview contentId={content.id} etag={content.audio_etag} />
            ) : null
          }
          onEdit={() => onEdit(content)}
          onDelete={deleteWithConfirm}
          deleteDisabled={deletePending}
        />
      }
    />
  );
});
