import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { AbuseLimitService, MysqlAbuseLimitService } from '../common/security/abuse-limits.js';
import { MAGIC_LINK_STORE } from './magic-link.store.js';
import { MagicLinkController } from './magic-link.controller.js';
import { MysqlMagicLinkStore } from './mysql-magic-link.store.js';
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
        { provide: MAGIC_LINK_STORE, useFactory: () => new MysqlMagicLinkStore(environment) },
        { provide: AbuseLimitService, useFactory: () => new MysqlAbuseLimitService(environment.database) },
        {
          provide: MagicLinkService,
          useFactory: (store: MysqlMagicLinkStore, abuseLimits: AbuseLimitService, mail: MagicLinkMailTransport) =>
            new MagicLinkService(store, abuseLimits, mail, environment),
          inject: [MAGIC_LINK_STORE, AbuseLimitService, MAGIC_LINK_MAIL_TRANSPORT],
        },
      ],
      controllers: [MagicLinkController],
    };
  }
}
