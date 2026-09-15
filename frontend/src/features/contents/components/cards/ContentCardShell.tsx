import type { CSSProperties, ReactNode } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';

interface ContentCardShellProps {
  nodeRef: (node: HTMLElement | null) => void;
  style: CSSProperties;
  isDragging: boolean;
  loading: boolean;
  error: boolean;
  frameName: string | null;
  seq: number;
  preview?: ReactNode;
  topRight?: ReactNode;
  titleMeta?: ReactNode;
  mediaMeta?: ReactNode;
  actions: ReactNode;
}

export function ContentCardShell({
  nodeRef,
  style,
  isDragging,
  loading,
  error,
  frameName,
  seq,
  preview,
  topRight,
  titleMeta,
  mediaMeta,
  actions,
}: ContentCardShellProps) {
  return (
    <div
      ref={nodeRef}
      style={style}
      className={cn('craft-card flex flex-col overflow-hidden', isDragging && 'opacity-90')}
    >
      <div className="content-card-media">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center text-stone-light text-[12px]">
            加载失败
          </div>
        ) : (
          (preview ?? null)
        )}

        <span className="absolute top-2 left-2 bg-paper border border-ink px-1.5 font-mono text-[10px] pointer-events-none">
          {String(seq + 1).padStart(2, '0')}
        </span>
        {mediaMeta}

        {topRight}
      </div>

      <div className="px-3.5 pt-2.5 pb-2 flex-1 min-w-0">
        <p
          className={cn(
            'font-serif text-[15px] truncate leading-snug',
            frameName ? 'text-ink' : 'text-stone-light italic'
          )}
        >
          {frameName ?? '未命名'}
        </p>
        {titleMeta}
      </div>

      <div className="px-2 py-2 border-t border-line flex items-center gap-0.5">{actions}</div>
    </div>
  );
}
