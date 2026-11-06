import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { AbuseLimitService, MysqlAbuseLimitService } from '../common/security/abuse-limits.js';
import { MAGIC_LINK_IDENTITY_STORE, MAGIC_LINK_STORE, type MagicLinkIdentityStore } from './magic-link.store.js';
import { MagicLinkController } from './magic-link.controller.js';
import { MysqlMagicLinkStore } from './mysql-magic-link.store.js';
import { MagicLinkIdentityProvisioningService } from './magic-link-identity.js';
import {
  MAGIC_LINK_ENVIRONMENT,
  MAGIC_LINK_MAIL_TRANSPORT,
  LocalMagicLinkInbox,
  MagicLinkMailTransport,
  MagicLinkService,
} from './magic-link.service.js';

class DisabledMailTransport extends MagicLinkMailTransport {
  override async send(): Promise<void> {
    throw new Error('No approved magic-link mail provider is configured.');
  }
}

@Module({})
export class MagicLinkModule {
  static register(environment: ApiEnvironment): DynamicModule {
    const localRuntime = environment.nodeEnv === 'development' || environment.nodeEnv === 'test';
    const transport = localRuntime ? new LocalMagicLinkInbox() : new DisabledMailTransport();
    return {
      module: MagicLinkModule,
      providers: [
        { provide: MAGIC_LINK_ENVIRONMENT, useValue: environment },
        { provide: MAGIC_LINK_MAIL_TRANSPORT, useValue: transport },
        { provide: MysqlMagicLinkStore, useFactory: () => new MysqlMagicLinkStore(environment) },
        { provide: MAGIC_LINK_STORE, useExisting: MysqlMagicLinkStore },
        { provide: MAGIC_LINK_IDENTITY_STORE, useExisting: MysqlMagicLinkStore },
        { provide: AbuseLimitService, useFactory: () => new MysqlAbuseLimitService(environment.database) },
        {
          provide: MagicLinkIdentityProvisioningService,
          useFactory: (store: MagicLinkIdentityStore) => new MagicLinkIdentityProvisioningService(store),
          inject: [MAGIC_LINK_IDENTITY_STORE],
        },
        {
          provide: MagicLinkService,
          useFactory: (store: MysqlMagicLinkStore, abuseLimits: AbuseLimitService, mail: MagicLinkMailTransport) =>
            new MagicLinkService(store, abuseLimits, mail, environment),
          inject: [MAGIC_LINK_STORE, AbuseLimitService, MAGIC_LINK_MAIL_TRANSPORT],
        },
      ],
      controllers: [MagicLinkController],
      exports: [MagicLinkIdentityProvisioningService],
    };
  }
}
