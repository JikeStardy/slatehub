import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_DISPLAY_PROFILE_ID,
  DynamicConfig,
  type DisplayProfileIdT,
  type DynamicConfigT,
  type DynamicTypeT,
} from 'shared';
import { defaultConfig } from '@/features/dynamic/model/default-config';
import {
  defaultDynamicFrameName,
  effectiveDynamicFrameName,
  effectiveDynamicStatusBarText,
  frameNameForSyncedDynamicConfigChange,
} from '@/features/dynamic/model/display-name';
import { dynamicConfigKey } from '@/features/dynamic/model/json-parse';
import { useDynamicPreview } from './useDynamicPreview';

interface UseDynamicContentFormOptions {
  contentId?: string;
  initialType?: DynamicTypeT | null;
  initialConfig?: DynamicConfigT | null;
  initialFrameName?: string | null;
  initialDashboardData?: Record<string, unknown> | null;
  requireDashboardData?: boolean;
  displayProfileId?: DisplayProfileIdT;
}

export function useDynamicContentForm({
  contentId,
  initialType = null,
  initialConfig = null,
  initialFrameName = null,
  initialDashboardData = null,
  requireDashboardData = false,
  displayProfileId = DEFAULT_DISPLAY_PROFILE_ID,
}: UseDynamicContentFormOptions = {}) {
  const [type, setType] = useState<DynamicTypeT | null>(initialType);
  const [config, setConfig] = useState<DynamicConfigT | null>(initialConfig);
  const [frameName, setFrameName] = useState(() =>
    initialType && initialConfig
      ? (initialFrameName ?? defaultDynamicFrameName(initialType, initialConfig))
      : ''
  );
  const [dashboardData, setDashboardData] = useState<Record<string, unknown> | null>(
    initialDashboardData
  );
  const { livePreviewData, previewPending, invalidatePreview } = useDynamicPreview({
    contentId,
    type,
    config,
    frameName,
    dashboardData,
    displayProfileId,
  });
  const configKey = useMemo(() => (config ? dynamicConfigKey(config) : ''), [config]);
  const hasDashboardData = dashboardData !== null && Object.keys(dashboardData).length > 0;
  const dashboardDataSatisfied = !requireDashboardData || hasDashboardData;

  const loadType = useCallback(
    (nextType: DynamicTypeT, nextDashboardData: Record<string, unknown> | null = null) => {
      invalidatePreview();
      const nextConfig = defaultConfig(nextType);
      setType(nextType);
      setConfig(nextConfig);
      setFrameName(defaultDynamicFrameName(nextType, nextConfig));
      setDashboardData(nextDashboardData);
    },
    [invalidatePreview]
  );

  const reset = useCallback(() => {
    invalidatePreview();
    setType(null);
    setConfig(null);
    setFrameName('');
    setDashboardData(null);
  }, [invalidatePreview]);

  const changeConfig = useCallback((next: DynamicConfigT) => {
    setConfig((previous) => {
      if (previous) {
        const nextFrameName = frameNameForSyncedDynamicConfigChange(previous, next);
        if (nextFrameName) setFrameName(nextFrameName);
      }
      return next;
    });
  }, []);

  const submitConfig = useCallback(() => {
    if (!type || !config) return { ok: false as const, error: 'config: 请选择动态类型' };
    const parsed = DynamicConfig.safeParse(config);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return {
        ok: false as const,
        error: `${first?.path.join('.') || 'config'}: ${first?.message ?? '请检查'}`,
      };
    }
    if (parsed.data.type === 'dashboard' && !dashboardDataSatisfied) {
      return { ok: false as const, error: 'dashboard 初始数据不能为空' };
    }
    const parsedType = parsed.data.type;
    return {
      ok: true as const,
      type: parsedType,
      config: parsed.data,
      frameName: effectiveDynamicFrameName(parsedType, parsed.data, frameName),
      dashboardData: parsed.data.type === 'dashboard' ? (dashboardData ?? undefined) : undefined,
    };
  }, [config, dashboardData, dashboardDataSatisfied, frameName, type]);

  return {
    type,
    setType,
    config,
    setConfig,
    configKey,
    frameName,
    setFrameName,
    dashboardData,
    setDashboardData,
    hasDashboardData,
    canSubmit: !!(type && config && (type !== 'dashboard' || dashboardDataSatisfied)),
    previewPending,
    livePreviewData,
    caption: effectiveDynamicStatusBarText(type, config, frameName),
    invalidatePreview,
    loadType,
    reset,
    changeConfig,
    submitConfig,
  };
}
