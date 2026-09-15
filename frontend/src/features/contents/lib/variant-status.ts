import type { ContentSummaryT } from 'shared';

export function compatibilityLabel(status: ContentSummaryT['variant_status']): string {
  switch (status) {
    case 'ready':
      return '变体就绪';
    case 'pending':
      return '正在生成此 Profile 的帧';
    case 'failed':
      return '此 Profile 渲染失败';
    case 'unavailable':
      return '此 Profile 暂无可用变体';
  }
}
