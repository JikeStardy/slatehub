import { describe, expect, it } from 'bun:test';
import { etagMatches } from '../../common/utils/etag';
import {
  contentFrameResourceEtag,
  contentSummaryEtag,
  manifestReadEtag,
  MIN_DYNAMIC_WAKE_SEC,
  nextWakeSec,
} from './content-presenter';

describe('nextWakeSec', () => {
  const now = new Date('2026-01-01T00:00:00.000Z').getTime();

  it('returns null for static frames (no nextRunAt)', () => {
    expect(nextWakeSec(null, now)).toBeNull();
  });

  it('returns remaining seconds for a future refresh', () => {
    expect(nextWakeSec(new Date(now + 3600_000), now)).toBe(3600);
  });

  it('floors a due / overdue dynamic frame to the minimum instead of 0', () => {
    expect(nextWakeSec(new Date(now), now)).toBe(MIN_DYNAMIC_WAKE_SEC);
    expect(nextWakeSec(new Date(now - 10_000), now)).toBe(MIN_DYNAMIC_WAKE_SEC);
  });

  it('floors a sub-minimum positive interval to the minimum', () => {
    expect(nextWakeSec(new Date(now + 5_000), now)).toBe(MIN_DYNAMIC_WAKE_SEC);
  });
});

describe('profile-scoped read ETags', () => {
  it('keeps frame, content, and manifest validators isolated by profile', () => {
    const frameEtag = 'same-frame-digest';
    const note4Frame = contentFrameResourceEtag('zectrix-note4-400x300-mono', frameEtag);
    const virtualFrame = contentFrameResourceEtag('virtual-mono-296x128', frameEtag);
    const note4Content = contentSummaryEtag('zectrix-note4-400x300-mono', frameEtag);
    const virtualContent = contentSummaryEtag('virtual-mono-296x128', frameEtag);

    expect(note4Frame).not.toBe(virtualFrame);
    expect(note4Content).not.toBe(virtualContent);
    expect(etagMatches(`"${note4Frame}"`, virtualFrame)).toBe(false);

    const note4Manifest = manifestReadEtag({
      profileId: 'zectrix-note4-400x300-mono',
      groupStructureEtag: 'structure',
      contents: [],
    });
    const virtualManifest = manifestReadEtag({
      profileId: 'virtual-mono-296x128',
      groupStructureEtag: 'structure',
      contents: [],
    });

    expect(note4Manifest).not.toBe(virtualManifest);
    expect(etagMatches(`"${note4Manifest}"`, virtualManifest)).toBe(false);
  });
});
