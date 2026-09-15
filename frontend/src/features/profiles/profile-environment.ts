import {
  DEFAULT_DISPLAY_PROFILE_ID,
  displayProfilesForEnvironment,
  type DisplayProfileIdT,
  type DisplayProfileEnvironmentT,
} from 'shared';

export function displayProfileEnvironmentFromMode({
  mode,
  prod,
}: {
  mode: string;
  prod: boolean;
}): DisplayProfileEnvironmentT {
  if (prod) return 'production';
  if (mode === 'test') return 'test';
  return 'development';
}

export function currentDisplayProfileEnvironment(): DisplayProfileEnvironmentT {
  return displayProfileEnvironmentFromMode({
    mode: import.meta.env.MODE,
    prod: import.meta.env.PROD,
  });
}

export function selectableDisplayProfiles(environment = currentDisplayProfileEnvironment()) {
  return displayProfilesForEnvironment(environment);
}

export function defaultDisplayProfileId(): DisplayProfileIdT {
  return DEFAULT_DISPLAY_PROFILE_ID;
}
