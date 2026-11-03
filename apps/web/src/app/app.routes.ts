import { Routes } from '@angular/router';
import { ChannelListComponent } from './features/channels/pages/channel-list/channel-list.component';
import { ChannelSetupComponent } from './features/channels/pages/channel-setup/channel-setup.component';
import { ChannelTemplatesComponent } from './features/channels/pages/channel-templates/channel-templates.component';
import { EmbedShellComponent } from './features/embed/embed-shell.component';
import { OAuthReturnComponent } from './features/embed/oauth-return.component';

export const routes: Routes = [
  { path: 'embed', component: EmbedShellComponent },
  { path: 'oauth/return', component: OAuthReturnComponent },
  {
    path: 'setup',
    component: ChannelSetupComponent,
    data: { metaProduct: null }
  },
  {
    path: 'setup/callback',
    component: ChannelSetupComponent,
    data: { metaProduct: 'FACEBOOK' }
  },
  {
    path: 'setup/whatsapp/callback',
    component: ChannelSetupComponent,
    data: { metaProduct: 'WHATSAPP' }
  },
  {
    path: 'setup/facebook/callback',
    component: ChannelSetupComponent,
    data: { metaProduct: 'FACEBOOK' }
  },
  {
    path: 'setup/instagram/callback',
    component: ChannelSetupComponent,
    data: { metaProduct: 'INSTAGRAM' }
  },
  {
    path: 'channels',
    component: ChannelListComponent
  },
  {
    path: 'templates',
    component: ChannelTemplatesComponent
  },
  {
    path: '',
    redirectTo: '/setup',
    pathMatch: 'full'
  },
  {
    path: '**',
    redirectTo: '/setup'
  }
];
