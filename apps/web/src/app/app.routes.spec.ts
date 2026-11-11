import { portalAuthGuard } from './core/portal/portal-auth.guard';
import { routes } from './app.routes';

describe('portal route map', () => {
  const shellRoute = routes.find((route) => route.path === '');
  const children = shellRoute?.children ?? [];

  it('protects the connection and management routes with the portal session guard', () => {
    expect(shellRoute?.canActivateChild).toContain(portalAuthGuard);
    expect(children.map((route) => route.path)).toEqual(expect.arrayContaining([
      'connections', 'connections/new/:flow', 'assets/:id', 'templates', 'notifications',
    ]));
  });

  it('keeps access and Suite4 bootstrap public and retains only safe legacy aliases', () => {
    expect(routes.find((route) => route.path === 'access')?.component).toBeTruthy();
    expect(routes.find((route) => route.path === 'embed')?.component).toBeTruthy();
    expect(children.find((route) => route.path === 'setup')?.redirectTo).toBe('/connections');
    expect(children.find((route) => route.path === 'channels')?.redirectTo).toBe('/connections');
    expect(children.find((route) => route.path === 'setup/callback')?.redirectTo).toBe('/connections');
  });
});
