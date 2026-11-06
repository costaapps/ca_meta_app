import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { IDENTITY_REPOSITORY } from './identity.repository.js';
import { ServiceTenantAuthorizationService, TenantAuthorizationService, TenantContextService } from './identity.service.js';
import { MysqlIdentityRepository } from './mysql-identity.repository.js';
import { IDENTITY_ADMINISTRATION_REPOSITORY } from './identity-administration.repository.js';
import { IdentityAdministrationService } from './identity-administration.service.js';
import { MysqlIdentityAdministrationRepository } from './mysql-identity-administration.repository.js';
import { PlatformIdentityAdminAuthority, PortalSessionVerifier } from './identity.trust.js';
import { MysqlPortalSessionStore } from './mysql-portal-session.store.js';
import {
  MysqlPortalSessionService,
  PORTAL_SESSION_STORE,
  PortalPreAuthService,
  PortalSessionIssuer,
} from './portal-session.service.js';
import { PortalSessionController } from './portal-session.controller.js';
import { PortalSessionsController } from './portal-sessions.controller.js';
import { PortalSessionGuard } from './portal-session.guard.js';
import { AbuseLimitService, MysqlAbuseLimitService } from '../common/security/abuse-limits.js';
import { PortalPreAuthController, SUITE4_EMBED_ALLOWED_ORIGINS } from '../auth-exchange/portal-preauth.controller.js';
import { PrivacyModule, PRIVACY_AUDIT_WRITER } from '../privacy/privacy.module.js';
import type { AuditEventWriter } from '../privacy/audit.service.js';

@Module({})
export class IdentityModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: IdentityModule,
      imports: [PrivacyModule.register(environment)],
      providers: [
        { provide: SUITE4_EMBED_ALLOWED_ORIGINS, useValue: environment.suite4EmbedOrigins ?? [] },
        {
          provide: PORTAL_SESSION_STORE,
          useFactory: () => new MysqlPortalSessionStore(environment),
        },
        {
          provide: PortalSessionVerifier,
          useFactory: (store: MysqlPortalSessionStore) => new PortalSessionVerifier(store),
          inject: [PORTAL_SESSION_STORE],
        },
        {
          provide: MysqlPortalSessionService,
          useFactory: (store: MysqlPortalSessionStore, contexts: TenantContextService) =>
            new MysqlPortalSessionService(store, contexts, environment.portalSessionRecoveryKey),
          inject: [PORTAL_SESSION_STORE, TenantContextService],
        },
        { provide: PortalPreAuthService, useExisting: MysqlPortalSessionService },
        { provide: PortalSessionIssuer, useExisting: MysqlPortalSessionService },
        {
          provide: PortalSessionGuard,
          useFactory: (sessions: PortalSessionVerifier) => new PortalSessionGuard(sessions),
          inject: [PortalSessionVerifier],
        },
        {
          provide: AbuseLimitService,
          useFactory: () => new MysqlAbuseLimitService(environment.database),
        },
        {
          provide: IDENTITY_REPOSITORY,
          useFactory: () => new MysqlIdentityRepository(environment.database),
        },
        {
          provide: TenantContextService,
          useFactory: (repository: MysqlIdentityRepository) => new TenantContextService(repository),
          inject: [IDENTITY_REPOSITORY],
        },
        {
          provide: TenantAuthorizationService,
          useFactory: (repository: MysqlIdentityRepository) => new TenantAuthorizationService(repository),
          inject: [IDENTITY_REPOSITORY],
        },
        {
          provide: ServiceTenantAuthorizationService,
          useFactory: (repository: MysqlIdentityRepository) => new ServiceTenantAuthorizationService(repository),
          inject: [IDENTITY_REPOSITORY],
        },
        {
          provide: IDENTITY_ADMINISTRATION_REPOSITORY,
          useFactory: () => new MysqlIdentityAdministrationRepository(environment.database),
        },
        {
          provide: PlatformIdentityAdminAuthority,
          useValue: new PlatformIdentityAdminAuthority(environment.identity?.platformIdentityAdmins ?? []),
        },
        {
          provide: IdentityAdministrationService,
          useFactory: (repository: MysqlIdentityAdministrationRepository, contexts: TenantContextService, audit: AuditEventWriter) =>
            new IdentityAdministrationService(repository, contexts, audit),
          inject: [IDENTITY_ADMINISTRATION_REPOSITORY, TenantContextService, PRIVACY_AUDIT_WRITER],
        },
      ],
      exports: [TenantContextService, TenantAuthorizationService, ServiceTenantAuthorizationService,
        IdentityAdministrationService, PlatformIdentityAdminAuthority, PortalSessionVerifier,
        PortalSessionIssuer, PortalPreAuthService, AbuseLimitService],
      controllers: [PortalSessionController, PortalSessionsController, PortalPreAuthController],
    };
  }
}
