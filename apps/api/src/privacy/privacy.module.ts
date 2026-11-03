import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { DURABLE_WORK_DATABASE, JobsModule } from '../jobs/jobs.module.js';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { AuditEventWriter, FailClosedSupportAccessAuthorization, SupportDiagnosticService, type SupportAccessAuthorizationPort } from './audit.service.js';
import { DeletionRequestService, FailClosedDeletionAuthorization, type DeletionAuthorizationPort } from './deletion.service.js';
import { FailClosedRetentionAuthorization, RetentionService, type RetentionAuthorizationPort } from './retention.service.js';

export const PRIVACY_AUDIT_WRITER = Symbol('PRIVACY_AUDIT_WRITER');
export const DELETION_AUTHORIZATION_PORT = Symbol('DELETION_AUTHORIZATION_PORT');
export const RETENTION_AUTHORIZATION_PORT = Symbol('RETENTION_AUTHORIZATION_PORT');
export const SUPPORT_ACCESS_AUTHORIZATION_PORT = Symbol('SUPPORT_ACCESS_AUTHORIZATION_PORT');

@Module({})
export class PrivacyModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: PrivacyModule,
      imports: [JobsModule.register(environment)],
      providers: [
        { provide: PRIVACY_AUDIT_WRITER, useFactory: (database: DurableWorkDatabase) => new AuditEventWriter(database), inject: [DURABLE_WORK_DATABASE] },
        { provide: DELETION_AUTHORIZATION_PORT, useClass: FailClosedDeletionAuthorization },
        { provide: RETENTION_AUTHORIZATION_PORT, useClass: FailClosedRetentionAuthorization },
        { provide: SUPPORT_ACCESS_AUTHORIZATION_PORT, useClass: FailClosedSupportAccessAuthorization },
        {
          provide: DeletionRequestService,
          useFactory: (database: DurableWorkDatabase, audit: AuditEventWriter, authorization: DeletionAuthorizationPort) =>
            new DeletionRequestService(database, audit, authorization),
          inject: [DURABLE_WORK_DATABASE, PRIVACY_AUDIT_WRITER, DELETION_AUTHORIZATION_PORT],
        },
        {
          provide: RetentionService,
          useFactory: (database: DurableWorkDatabase, audit: AuditEventWriter, authorization: RetentionAuthorizationPort) =>
            new RetentionService(database, audit, authorization),
          inject: [DURABLE_WORK_DATABASE, PRIVACY_AUDIT_WRITER, RETENTION_AUTHORIZATION_PORT],
        },
        {
          provide: SupportDiagnosticService,
          useFactory: (audit: AuditEventWriter, authorization: SupportAccessAuthorizationPort) =>
            new SupportDiagnosticService(audit, authorization),
          inject: [PRIVACY_AUDIT_WRITER, SUPPORT_ACCESS_AUTHORIZATION_PORT],
        },
      ],
      exports: [DeletionRequestService, RetentionService, SupportDiagnosticService, PRIVACY_AUDIT_WRITER],
    };
  }
}
