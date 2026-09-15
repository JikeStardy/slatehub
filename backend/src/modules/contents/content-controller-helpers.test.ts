import { describe, expect, it } from 'bun:test';
import { ValidationError } from '../../common/errors';
import { contentAuthScope, displayProfileIdFromQuery } from './content-controller-helpers';

describe('content read profile query helpers', () => {
  it('accepts omitted and known display_profile_id values', () => {
    expect(displayProfileIdFromQuery(undefined)).toBeUndefined();
    expect(displayProfileIdFromQuery('zectrix-note4-400x300-mono')).toBe(
      'zectrix-note4-400x300-mono'
    );
    expect(displayProfileIdFromQuery('virtual-mono-296x128')).toBe('virtual-mono-296x128');
  });

  it('rejects unknown or repeated display_profile_id values before service dispatch', () => {
    expect(() => displayProfileIdFromQuery('unknown-profile')).toThrow(ValidationError);
    expect(() => displayProfileIdFromQuery(['virtual-mono-296x128'])).toThrow(ValidationError);
  });

  it('adds the validated profile to the auth scope passed by thin controllers', () => {
    expect(contentAuthScope({ userId: 'user-1' }, undefined, 'virtual-mono-296x128')).toEqual({
      userId: 'user-1',
      deviceId: undefined,
      displayProfileId: 'virtual-mono-296x128',
    });
  });
});
