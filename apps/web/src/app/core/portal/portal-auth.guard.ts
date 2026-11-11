import { inject } from '@angular/core';
import { CanActivateChildFn, Router, UrlTree } from '@angular/router';
import { PortalEntryReturnStore } from './portal-entry-return.store';
import { PortalSessionService } from './portal-session.service';
import { safeReturnUrl } from './safe-return-url';

export { safeReturnUrl } from './safe-return-url';

export const portalAuthGuard: CanActivateChildFn = async (_childRoute, state): Promise<boolean | UrlTree> => {
  const sessions = inject(PortalSessionService);
  const returnTargets = inject(PortalEntryReturnStore);
  const router = inject(Router);
  const session = await sessions.ensureCurrentSession(true);
  if (session) {
    const canonicalUrl = safeReturnUrl(state.url);
    return canonicalUrl === state.url ? true : router.parseUrl(canonicalUrl);
  }
  returnTargets.remember(safeReturnUrl(state.url));
  return router.createUrlTree(['/access']);
};
