import { inject } from '@angular/core';
import { CanActivateChildFn, Router, UrlTree } from '@angular/router';
import { PortalSessionService } from './portal-session.service';

export const portalAuthGuard: CanActivateChildFn = async (_childRoute, state): Promise<boolean | UrlTree> => {
  const sessions = inject(PortalSessionService);
  const router = inject(Router);
  const session = await sessions.ensureCurrentSession(true);
  if (session) {
    const canonicalUrl = safeReturnUrl(state.url);
    return canonicalUrl === state.url ? true : router.parseUrl(canonicalUrl);
  }
  return router.createUrlTree(['/access'], { queryParams: { returnUrl: safeReturnUrl(state.url) } });
};

export function safeReturnUrl(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/connections';
  const [path, query = ''] = value.split('?', 2);
  if (path === '/access' || path === '/embed' || path === '/oauth/return' || path === '/setup' ||
      path.startsWith('/setup/') || path === '/channels') return '/connections';
  const safePaths = path === '/connections' || path === '/templates' || path === '/notifications' ||
    /^\/connections\/new\/[a-z-]+$/.test(path) || /^\/assets\/[A-Za-z0-9_-]{1,128}$/.test(path);
  if (!safePaths) return '/connections';
  const parameters = new URLSearchParams(query);
  const safeParameters = new URLSearchParams();
  const allowedKeys = new Set(['authVariant', 'filter', 'page', 'pageSize', 'product', 'sort', 'state']);
  const instagramVariants = new Set(['INSTAGRAM_LOGIN', 'INSTAGRAM_VIA_FACEBOOK_LOGIN']);
  for (const [key, value] of parameters) {
    if (!allowedKeys.has(key) || value.length > 128) continue;
    if (key === 'authVariant' && (path !== '/connections/new/instagram' || !instagramVariants.has(value))) continue;
    safeParameters.set(key, value);
  }
  const queryString = safeParameters.toString();
  return queryString ? `${path}?${queryString}` : path;
}
