import type { DashboardDataPayloadT } from 'shared';
import { createScriptLogger } from '../helpers/script-logger';
import { requireEnv, stripTrailingSlash } from '../lib/env';
import { getJSON, postJSON } from '../lib/http';
import type { SlateHubJob } from '../lib/job';
import { pushDashboardData } from '../lib/slatehub-ingest';
import {
  formatHourMinuteInTimeZone,
  formatMonthDayMinuteInTimeZone,
  readScriptTimeZone,
} from '../lib/time';

const logger = createScriptLogger('Sub2APIUsageStats');
const TOKEN_REFRESH_BUFFER_SECONDS = 120;

interface Sub2APILoginResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  requires_2fa?: boolean;
  temp_token?: string;
}

interface Sub2APIRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface Sub2APISession {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

interface Sub2APIUsageStatsConfig {
  sub2apiBase: string;
  email: string;
  password: string;
  slatehubAPIBase: string;
  contentID: string;
  timeZone: string;
}

// Sub2API GET /api/v1/usage/dashboard/stats 响应
interface UserDashboardStats {
  total_api_keys: number;
  active_api_keys: number;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_tokens: number;
  total_cost: number;
  total_actual_cost: number;
  today_requests: number;
  today_input_tokens: number;
  today_output_tokens: number;
  today_cache_creation_tokens: number;
  today_cache_read_tokens: number;
  today_tokens: number;
  today_cost: number;
  today_actual_cost: number;
  average_duration_ms: number;
  rpm: number;
  tpm: number;
  by_platform?: Array<{
    platform: string;
    total_requests: number;
    total_tokens: number;
    total_actual_cost: number;
    today_requests: number;
    today_tokens: number;
    today_actual_cost: number;
  }>;
}

let cachedSession: Sub2APISession | null = null;

function readConfig(): Sub2APIUsageStatsConfig {
  return {
    sub2apiBase: stripTrailingSlash(requireEnv('SUB2API_BASE')),
    email: requireEnv('SUB2API_EMAIL'),
    password: requireEnv('SUB2API_PASSWORD'),
    slatehubAPIBase: stripTrailingSlash(requireEnv('SLATEHUB_API_BASE')),
    contentID: requireEnv('SUB2API_CONTENT_ID'),
    timeZone: readScriptTimeZone(),
  };
}

function sessionUsable(session: Sub2APISession | null): boolean {
  if (!session) return false;
  return Date.now() + TOKEN_REFRESH_BUFFER_SECONDS * 1000 < session.expiresAtMs;
}

async function login(config: Sub2APIUsageStatsConfig): Promise<Sub2APISession> {
  const body: Record<string, string> = {
    email: config.email,
    password: config.password,
  };

  const data = await postJSON<Sub2APILoginResponse>(
    `${config.sub2apiBase}/api/v1/auth/login`,
    body,
    'Sub2API login'
  );

  if (data.requires_2fa) {
    throw new Error('Sub2API login requires 2FA; password-based automation cannot continue.');
  }
  if (!data.access_token) {
    throw new Error('Sub2API login did not return access_token.');
  }

  const expiresInSeconds =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
      ? Math.trunc(data.expires_in)
      : 3600;

  logger.info(`Logged in to Sub2API; access token expires in ${expiresInSeconds}s.`);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? '',
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };
}

function buildSessionFromRefreshResponse(data: Sub2APIRefreshResponse): Sub2APISession {
  if (!data.access_token) {
    throw new Error('Sub2API refresh did not return access_token.');
  }
  const expiresInSeconds =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
      ? Math.trunc(data.expires_in)
      : 3600;
  logger.info(`Refreshed Sub2API access token; expires in ${expiresInSeconds}s.`);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? '',
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };
}

async function refreshSession(
  config: Sub2APIUsageStatsConfig,
  refreshToken: string
): Promise<Sub2APISession> {
  const data = await postJSON<Sub2APIRefreshResponse>(
    `${config.sub2apiBase}/api/v1/auth/refresh`,
    { refresh_token: refreshToken },
    'Sub2API refresh'
  );
  return buildSessionFromRefreshResponse(data);
}

async function getAccessToken(config: Sub2APIUsageStatsConfig): Promise<string> {
  const session = cachedSession;
  if (session && sessionUsable(session)) {
    return session.accessToken;
  }

  if (session?.refreshToken) {
    try {
      cachedSession = await refreshSession(config, session.refreshToken);
      return cachedSession.accessToken;
    } catch (error) {
      logger.warn(
        `Sub2API refresh failed; falling back to password login: ${
          error instanceof Error ? error.message : error
        }`
      );
    }
  }

  cachedSession = await login(config);
  return cachedSession.accessToken;
}

async function fetchUsageStats(config: Sub2APIUsageStatsConfig): Promise<UserDashboardStats> {
  const accessToken = await getAccessToken(config);
  try {
    return await getJSON<UserDashboardStats>(
      `${config.sub2apiBase}/api/v1/usage/dashboard/stats`,
      'Sub2API usage stats',
      { Authorization: `Bearer ${accessToken}` }
    );
  } catch (error) {
    const session = cachedSession;
    const refreshToken = session?.refreshToken;
    if (refreshToken) {
      try {
        cachedSession = await refreshSession(config, refreshToken);
        return await getJSON<UserDashboardStats>(
          `${config.sub2apiBase}/api/v1/usage/dashboard/stats`,
          'Sub2API usage stats',
          { Authorization: `Bearer ${cachedSession.accessToken}` }
        );
      } catch (refreshError) {
        logger.warn(
          `Sub2API stats retry after refresh failed: ${
            refreshError instanceof Error ? refreshError.message : refreshError
          }`
        );
      }
    }
    cachedSession = null;
    throw error;
  }
}

function formatLastUpdatedLabel(timeZone: string): string {
  return formatMonthDayMinuteInTimeZone(new Date(), timeZone);
}

function formatLastUpdatedTimeLabel(timeZone: string): string {
  return formatHourMinuteInTimeZone(new Date(), timeZone);
}

function cacheHitRatePercent(
  inputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number
): number {
  const denominator = inputTokens + cacheCreationTokens + cacheReadTokens;
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return (cacheReadTokens / denominator) * 100;
}

function costPerMillionTokens(costUsd: number, tokenCount: number): number {
  if (!Number.isFinite(costUsd) || !Number.isFinite(tokenCount) || tokenCount <= 0) return 0;
  return (costUsd / tokenCount) * 1_000_000;
}

function buildDashboardData(stats: UserDashboardStats, timeZone: string): DashboardDataPayloadT {
  return {
    today_cost_usd: stats.today_actual_cost,
    today_request_count: stats.today_requests,
    today_token_count: stats.today_tokens,
    today_cache_hit_rate_percent: cacheHitRatePercent(
      stats.today_input_tokens,
      stats.today_cache_creation_tokens,
      stats.today_cache_read_tokens
    ),
    total_cost_usd: stats.total_actual_cost,
    total_request_count: stats.total_requests,
    total_token_count: stats.total_tokens,
    total_cache_hit_rate_percent: cacheHitRatePercent(
      stats.total_input_tokens,
      stats.total_cache_creation_tokens,
      stats.total_cache_read_tokens
    ),
    average_latency_ms: stats.average_duration_ms,
    today_cost_per_million_tokens_usd: costPerMillionTokens(
      stats.today_actual_cost,
      stats.today_tokens
    ),
    total_cost_per_million_tokens_usd: costPerMillionTokens(
      stats.total_actual_cost,
      stats.total_tokens
    ),
    last_updated_time_label: formatLastUpdatedTimeLabel(timeZone),
    last_updated_label: formatLastUpdatedLabel(timeZone),
    platform_breakdown: (stats.by_platform ?? [])
      .toSorted(
        (a, b) =>
          b.today_actual_cost - a.today_actual_cost ||
          b.today_tokens - a.today_tokens ||
          b.today_requests - a.today_requests
      )
      .slice(0, 2)
      .map((p) => ({
        platform_name: p.platform,
        today_cost_usd: p.today_actual_cost,
        today_request_count: p.today_requests,
        today_token_count: p.today_tokens,
      })),
  };
}

export async function runSub2APIUsageStatsJob(): Promise<void> {
  const config = readConfig();
  const stats = await fetchUsageStats(config);
  await pushDashboardData({
    slatehubAPIBase: config.slatehubAPIBase,
    contentID: config.contentID,
    data: buildDashboardData(stats, config.timeZone),
  });
}

export const job: SlateHubJob = {
  id: 'sub2api-usage-stats',
  description: 'Fetch Sub2API user dashboard usage stats and push them to a SlateHub dashboard frame.',
  run: runSub2APIUsageStatsJob,
};
