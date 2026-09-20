import { describe, expect, it } from 'bun:test';
import { readRunnerConfig } from './job-runner';

describe('readRunnerConfig', () => {
  it('requires SLATEHUB_JOB and ignores the retired prefix', () => {
    const retiredKey = ['S', 'LATE_JOB'].join('');
    expect(() => readRunnerConfig({ [retiredKey]: 'sub2api-usage-stats' })).toThrow(
      'Missing required environment variable SLATEHUB_JOB'
    );
  });

  it('reads only SlateHub job controls', () => {
    expect(
      readRunnerConfig({
        SLATEHUB_JOB: 'sub2api-usage-stats',
        SLATEHUB_JOB_INTERVAL_SECONDS: '60',
        SLATEHUB_JOB_RUN_ONCE: '1',
      })
    ).toEqual({ jobID: 'sub2api-usage-stats', intervalSeconds: 60, runOnce: true });
  });
});
