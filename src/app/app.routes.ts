import { Routes } from '@angular/router';
import { ChannelListComponent } from './features/channels/pages/channel-list/channel-list.component';
import { ChannelSetupComponent } from './features/channels/pages/channel-setup/channel-setup.component';
import { ChannelTemplatesComponent } from './features/channels/pages/channel-templates/channel-templates.component';

export const routes: Routes = [
  // Página de Setup/Conexão (Página Inicial)
  {
    path: 'setup',
    component: ChannelSetupComponent
  },
  
  // Página de Listagem de Canais
  {
    path: 'channels',
    component: ChannelListComponent
  },

  // Página de Templates WhatsApp
  {
    path: 'templates',
    component: ChannelTemplatesComponent
  },
  
  // Callback do Facebook (volta para a página de setup onde trata sucesso/erro)
  {
    path: 'setup/callback',
    component: ChannelSetupComponent
  },
  
  // Redirect padrão (começa no setup)
  {
    path: '',
    redirectTo: '/setup',
    pathMatch: 'full'
  },
  
  // Wildcard (qualquer rota não encontrada vai para setup)
  {
    path: '**',
    redirectTo: '/setup'
  }
];

