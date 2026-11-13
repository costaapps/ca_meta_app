import { Routes } from '@angular/router';
import { portalAuthGuard } from './core/portal/portal-auth.guard';

export const routes: Routes = [
  { path: 'embed', loadComponent: () => import('./features/embed/embed-shell.component').then((m) => m.EmbedShellComponent) },
  { path: 'oauth/return', loadComponent: () => import('./features/embed/oauth-return.component').then((m) => m.OAuthReturnComponent) },
  { path: 'access', loadComponent: () => import('./features/portal/portal-access.component').then((m) => m.PortalAccessComponent) },
  {
    path: '',
    loadComponent: () => import('./features/portal/portal-shell.component').then((m) => m.PortalShellComponent),
    canActivateChild: [portalAuthGuard],
    children: [
      { path: '', redirectTo: '/connections', pathMatch: 'full' },
      { path: 'connections', loadComponent: () => import('./features/portal/connections-home.component').then((m) => m.ConnectionsHomeComponent) },
      { path: 'onboarding', loadComponent: () => import('./features/portal/onboarding/portal-onboarding.component').then((m) => m.PortalOnboardingComponent) },
      { path: 'connections/new/:flow', loadComponent: () => import('./features/portal/connection-detail.component').then((m) => m.ConnectionDetailComponent) },
      { path: 'connections/:id', loadComponent: () => import('./features/portal/connection-record-detail.component').then((m) => m.ConnectionRecordDetailComponent) },
      { path: 'assets/:id', loadComponent: () => import('./features/portal/asset-detail.component').then((m) => m.AssetDetailComponent) },
      {
        path: 'templates',
        loadComponent: () => import('./features/portal/whatsapp-templates.component').then((m) => m.WhatsAppTemplatesComponent),
      },
      {
        path: 'notifications',
        loadComponent: () => import('./features/portal/notifications.component').then((m) => m.NotificationsComponent),
      },
      { path: 'setup/coexistence', loadComponent: () => import('./features/coexistence/coexistence-setup.component').then((m) => m.CoexistenceSetupComponent) },
      // Legacy entry points never carry authentication authority; the session guard still applies.
      { path: 'setup/whatsapp/callback', redirectTo: '/connections' },
      { path: 'setup/facebook/callback', redirectTo: '/connections' },
      { path: 'setup/instagram/callback', redirectTo: '/connections' },
      { path: 'setup/callback', redirectTo: '/connections' },
      { path: 'setup', redirectTo: '/connections' },
      { path: 'channels', redirectTo: '/connections' },
      { path: '**', redirectTo: '/connections' },
    ],
  },
  { path: '**', redirectTo: '/access' },
];
