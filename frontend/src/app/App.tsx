import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { RequireAuth } from '@/features/auth/components/RequireAuth';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { Spinner } from '@/components/ui/Spinner';
import { currentDisplayProfileEnvironment } from '@/features/profiles/profile-environment';
import { appRoutes, isSimulatorRouteEnabled, routePaths } from './routes';

const AuthPage = lazy(() =>
  import('@/pages/auth/AuthPage').then((module) => ({ default: module.AuthPage }))
);
const DashboardPage = lazy(() =>
  import('@/pages/dashboard/DashboardPage').then((module) => ({ default: module.DashboardPage }))
);
const GroupDetailPage = lazy(() =>
  import('@/pages/groups/GroupDetailPage').then((module) => ({ default: module.GroupDetailPage }))
);
const ContentNewPage = lazy(() =>
  import('@/pages/contents/ContentNewPage').then((module) => ({ default: module.ContentNewPage }))
);
const ImageContentEditorPage = lazy(() =>
  import('@/pages/contents/ImageContentEditorPage').then((module) => ({
    default: module.ImageContentEditorPage,
  }))
);
const DynamicContentEditorPage = lazy(() =>
  import('@/pages/contents/DynamicContentEditorPage').then((module) => ({
    default: module.DynamicContentEditorPage,
  }))
);
const SimulatorPage = import.meta.env.PROD
  ? null
  : lazy(() =>
      import('@/pages/simulator/SimulatorPage').then((module) => ({
        default: module.SimulatorPage,
      }))
    );

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    // 当前路由没有 hash 锚点导航，只在页面路径切换时回到顶部。
  }, [pathname]);
  return null;
}

export function App() {
  const simulatorEnabled =
    import.meta.env.DEV && isSimulatorRouteEnabled(currentDisplayProfileEnvironment());

  return (
    <ErrorBoundary>
      <ScrollToTop />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path={routePaths.login} element={<AuthPage mode="login" />} />
          <Route path={routePaths.register} element={<AuthPage mode="register" />} />

          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path={routePaths.deviceDetail} element={<DashboardPage />} />
            <Route path={routePaths.groupDetail} element={<GroupDetailPage />} />
            <Route path={routePaths.contentNew} element={<ContentNewPage />} />
            <Route path={routePaths.imageContentEdit} element={<ImageContentEditorPage />} />
            <Route path={routePaths.dynamicContentEdit} element={<DynamicContentEditorPage />} />
            {simulatorEnabled && SimulatorPage && (
              <Route path={routePaths.simulator} element={<SimulatorPage />} />
            )}
          </Route>

          <Route path="*" element={<Navigate to={appRoutes.home} replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Spinner label="加载中" />
    </div>
  );
}
