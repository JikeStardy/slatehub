export const AUTH_TOKEN_STORAGE_KEY = 'slatehub_jwt';

export const tokenStorage = {
  get: () => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY),
  set: (value: string) => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, value);
  },
  clear: () => {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  },
};
