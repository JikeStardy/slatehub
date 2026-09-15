import {
  API_PREFIX,
  IngestPayload,
  type DashboardDataPayloadT,
  type IngestResponseT,
} from 'shared';
import { createScriptLogger, truncateScriptLogText } from '../helpers/script-logger';
import { postJSON } from './http';
import { stripTrailingSlash } from './env';

const logger = createScriptLogger('SlateIngest');

export function dashboardIngestURL(slateAPIBase: string, contentID: string): string {
  return `${stripTrailingSlash(slateAPIBase)}${API_PREFIX}/contents/${contentID}/data`;
}

export async function pushDashboardData(input: {
  slateAPIBase: string;
  contentID: string;
  data: DashboardDataPayloadT;
}): Promise<IngestResponseT> {
  const payload = IngestPayload.parse({ version: 1, data: input.data });
  const url = dashboardIngestURL(input.slateAPIBase, input.contentID);
  const result = await postJSON<IngestResponseT>(url, payload, 'Slate push');

  logger.info(
    `Slate accepted dashboard data push: ${truncateScriptLogText(JSON.stringify(result), 1000)}`
  );

  return result;
}
