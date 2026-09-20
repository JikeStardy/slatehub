import {
  API_PREFIX,
  IngestPayload,
  type DashboardDataPayloadT,
  type IngestResponseT,
} from 'shared';
import { createScriptLogger, truncateScriptLogText } from '../helpers/script-logger';
import { postJSON } from './http';
import { stripTrailingSlash } from './env';

const logger = createScriptLogger('SlateHubIngest');

export function slatehubIngestURL(slatehubAPIBase: string, contentID: string): string {
  return `${stripTrailingSlash(slatehubAPIBase)}${API_PREFIX}/contents/${contentID}/data`;
}

export async function pushDashboardData(input: {
  slatehubAPIBase: string;
  contentID: string;
  data: DashboardDataPayloadT;
}): Promise<IngestResponseT> {
  const payload = IngestPayload.parse({ version: 1, data: input.data });
  const url = slatehubIngestURL(input.slatehubAPIBase, input.contentID);
  const result = await postJSON<IngestResponseT>(url, payload, 'SlateHub push');

  logger.info(
    `SlateHub accepted dashboard data push: ${truncateScriptLogText(JSON.stringify(result), 1000)}`
  );

  return result;
}
