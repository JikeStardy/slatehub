const simulatorRoutePath = import.meta.env.DEV ? '/simulator' : '';
const simulatorNavLabel = import.meta.env.DEV ? '设备模拟器' : '';

export const routePaths = {
  home: '/',
  login: '/login',
  register: '/register',
  simulator: simulatorRoutePath,
  deviceDetail: '/devices/:did',
  groupDetail: '/groups/:gid',
  contentNew: '/groups/:gid/contents/new',
  imageContentEdit: '/groups/:gid/contents/image/:contentId/edit',
  dynamicContentEdit: '/groups/:gid/contents/dynamic/:contentId/edit',
} as const;

export const appRoutes = {
  home: routePaths.home,
  login: routePaths.login,
  register: routePaths.register,
  simulator: routePaths.simulator,
  device: (deviceId: string) => `/devices/${deviceId}`,
  group: (gid: string) => `/groups/${gid}`,
  newContent: (gid: string) => `/groups/${gid}/contents/new`,
  editImageContent: (gid: string, contentId: string) =>
    `/groups/${gid}/contents/image/${contentId}/edit`,
  editDynamicContent: (gid: string, contentId: string) =>
    `/groups/${gid}/contents/dynamic/${contentId}/edit`,
} as const;

export function isSimulatorRouteEnabled(environment: 'production' | 'development' | 'test') {
  return environment !== 'production';
}

export function layoutNavItems(
  environment: 'production' | 'development' | 'test',
  devBuild = import.meta.env.DEV,
  simulatorPath = simulatorRoutePath,
  simulatorLabel = simulatorNavLabel
) {
  return !devBuild || environment === 'production'
    ? []
    : ([{ href: simulatorPath, label: simulatorLabel }] as const);
}
