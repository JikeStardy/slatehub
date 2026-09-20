import { describe, expect, it } from 'bun:test';
import { slatehubIngestURL } from './slatehub-ingest';

describe('slatehubIngestURL', () => {
  it('builds dashboard ingest URLs from the shared v2 prefix', () => {
    expect(slatehubIngestURL('https://hub.example/', 'content-1')).toBe(
      'https://hub.example/api/v2/contents/content-1/data'
    );
  });
});
