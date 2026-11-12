import { portalAuthGuard } from './core/portal/portal-auth.guard';
import { routes } from './app.routes';

describe('portal route map', () => {
  const shellRoute = routes.find((route) => route.path === '');
  const children = shellRoute?.children ?? [];

  it('lazy-loads the public entry, Suite4 bootstrap and authenticated portal views', () => {
    for (const path of ['embed', 'oauth/return', 'access']) {
      const route = routes.find((candidate) => candidate.path === path);
      expect(route?.component).toBeUndefined();
      expect(route?.loadComponent).toEqual(expect.any(Function));
    }
    expect(shellRoute?.component).toBeUndefined();
    expect(shellRoute?.loadComponent).toEqual(expect.any(Function));
    for (const path of ['connections', 'connections/new/:flow', 'connections/:id', 'assets/:id', 'templates', 'notifications', 'setup/coexistence']) {
      const route = children.find((candidate) => candidate.path === path);
      expect(route?.component).toBeUndefined();
      expect(route?.loadComponent).toEqual(expect.any(Function));
    }
  });

  it('protects portal routes and retains the documented safe legacy aliases', () => {
    expect(shellRoute?.canActivateChild).toContain(portalAuthGuard);
    expect(children.find((route) => route.path === 'setup')?.redirectTo).toBe('/connections');
    expect(children.find((route) => route.path === 'channels')?.redirectTo).toBe('/connections');
    for (const path of ['setup/callback', 'setup/whatsapp/callback', 'setup/facebook/callback', 'setup/instagram/callback']) {
      expect(children.find((route) => route.path === path)?.redirectTo).toBe('/connections');
    }
  });
});
