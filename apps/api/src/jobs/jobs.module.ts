import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { InboxService } from '../inbox/inbox-service.js';
import { OutboxService } from '../outbox/outbox-service.js';
import { DurableWorkDatabase } from './durable-work-database.js';
import { DurableJobStore } from './job-store.js';
import { FailClosedReplayAuthorizationPort, ReplayDryRunService } from './replay-dry-run.js';

export const DURABLE_WORK_DATABASE = Symbol('DURABLE_WORK_DATABASE');
export const DURABLE_JOB_STORE = Symbol('DURABLE_JOB_STORE');
export const REPLAY_AUTHORIZATION_PORT = Symbol('REPLAY_AUTHORIZATION_PORT');

@Module({})
export class JobsModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: JobsModule,
      providers: [
        { provide: DURABLE_WORK_DATABASE, useFactory: () => new DurableWorkDatabase(environment) },
        { provide: DURABLE_JOB_STORE, useFactory: (database: DurableWorkDatabase) => new DurableJobStore(database), inject: [DURABLE_WORK_DATABASE] },
        {
          provide: REPLAY_AUTHORIZATION_PORT,
          useFactory: () => new FailClosedReplayAuthorizationPort(),
        },
        {
          provide: InboxService,
          useFactory: (database: DurableWorkDatabase, jobs: DurableJobStore) => new InboxService(database, jobs),
          inject: [DURABLE_WORK_DATABASE, DURABLE_JOB_STORE],
        },
        {
          provide: OutboxService,
          useFactory: (database: DurableWorkDatabase, jobs: DurableJobStore) =>
            new OutboxService(database, jobs),
          inject: [DURABLE_WORK_DATABASE, DURABLE_JOB_STORE],
        },
        {
          provide: ReplayDryRunService,
          useFactory: (database: DurableWorkDatabase, authorization: FailClosedReplayAuthorizationPort, jobs: DurableJobStore) =>
            new ReplayDryRunService(database, authorization, jobs),
          inject: [DURABLE_WORK_DATABASE, REPLAY_AUTHORIZATION_PORT, DURABLE_JOB_STORE],
        },
      ],
      exports: [DURABLE_WORK_DATABASE, DURABLE_JOB_STORE, InboxService, OutboxService, ReplayDryRunService],
    };
  }
}
