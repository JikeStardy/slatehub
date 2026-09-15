import { describe, expect, it } from 'bun:test';
import { dashboardIngestURL } from './slate-ingest';

describe('dashboardIngestURL', () => {
  it('builds dashboard ingest URLs from the shared v2 prefix', () => {
    expect(dashboardIngestURL('https://slate.example/', 'content-1')).toBe(
      'https://slate.example/api/v2/contents/content-1/data'
    );
  });
});
