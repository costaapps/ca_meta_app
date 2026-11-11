import { DynamicModule, Module } from '@nestjs/common';
import { MetaSubscriptionService } from '../meta-subscriptions/meta-subscription.service.js';
import { MetaSubscriptionsModule } from '../meta-subscriptions/meta-subscriptions.module.js';
import { PortalSessionVerifier } from '../identity/identity.trust.js';
import { TenantContextService } from '../identity/identity.service.js';
import { PortalSessionGuard } from '../identity/portal-session.guard.js';
import { FacebookPageSelectionService } from './facebook-page-selection.service.js';
import { FacebookPagesController } from './facebook-pages.controller.js';

@Module({})
export class FacebookPagesModule {
  static register(identityModule: DynamicModule, metaSubscriptionsModule: DynamicModule): DynamicModule {
    return {
      module: FacebookPagesModule,
      imports: [identityModule, metaSubscriptionsModule],
      controllers: [FacebookPagesController],
      providers: [
        { provide: PortalSessionGuard, useFactory: (sessions: PortalSessionVerifier) => new PortalSessionGuard(sessions),
          inject: [PortalSessionVerifier] },
        { provide: FacebookPageSelectionService,
          useFactory: (subscriptions: MetaSubscriptionService, tenantContexts: TenantContextService) =>
            new FacebookPageSelectionService(subscriptions, tenantContexts),
          inject: [MetaSubscriptionService, TenantContextService] },
      ],
    };
  }
}
