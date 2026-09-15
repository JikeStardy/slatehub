import { describe, expect, it } from 'bun:test';
import {
  displayProfileEnvironmentFromMode,
  selectableDisplayProfiles,
} from './profile-environment';

describe('profile environment selection', () => {
  it('filters virtual profiles out of production selectors', () => {
    expect(displayProfileEnvironmentFromMode({ mode: 'production', prod: true })).toBe(
      'production'
    );
    expect(selectableDisplayProfiles('production').map((profile) => profile.id)).toEqual([
      'zectrix-note4-400x300-mono',
    ]);
    expect(selectableDisplayProfiles('development').map((profile) => profile.id)).toContain(
      'virtual-mono-296x128'
    );
  });
});
