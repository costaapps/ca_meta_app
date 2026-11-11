import { Routes } from '@angular/router';
import { EmbedShellComponent } from './features/embed/embed-shell.component';
import { OAuthReturnComponent } from './features/embed/oauth-return.component';
import { CoexistenceSetupComponent } from './features/coexistence/coexistence-setup.component';
import { portalAuthGuard } from './core/portal/portal-auth.guard';
import { AssetDetailComponent } from './features/portal/asset-detail.component';
import { ConnectionDetailComponent } from './features/portal/connection-detail.component';
import { ConnectionsHomeComponent } from './features/portal/connections-home.component';
import { PortalAccessComponent } from './features/portal/portal-access.component';
import { PortalSectionComponent } from './features/portal/portal-section.component';
import { PortalShellComponent } from './features/portal/portal-shell.component';

export const routes: Routes = [
  { path: 'embed', component: EmbedShellComponent },
  { path: 'oauth/return', component: OAuthReturnComponent },
  { path: 'access', component: PortalAccessComponent },
  {
    path: '',
    component: PortalShellComponent,
    canActivateChild: [portalAuthGuard],
    children: [
      { path: '', redirectTo: '/connections', pathMatch: 'full' },
      { path: 'connections', component: ConnectionsHomeComponent },
      { path: 'connections/new/:flow', component: ConnectionDetailComponent },
      { path: 'assets/:id', component: AssetDetailComponent },
      {
        path: 'templates',
        component: PortalSectionComponent,
        data: { title: 'Modelos', description: 'Os modelos disponíveis serão exibidos após a confirmação dos recursos e permissões desta empresa.' },
      },
      {
        path: 'notifications',
        component: PortalSectionComponent,
        data: { title: 'Notificações', description: 'As notificações serão exibidas após a confirmação do contexto e da empresa pelo servidor.' },
      },
      { path: 'setup/coexistence', component: CoexistenceSetupComponent },
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
