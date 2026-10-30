import { DynamicModule, Module } from '@nestjs/common';
import type { ApiEnvironment } from '../config/environment.js';
import { JobsModule, DURABLE_WORK_DATABASE } from '../jobs/jobs.module.js';
import { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { OutboxService } from '../outbox/outbox-service.js';
import { META_ASSETS_REPOSITORY, MysqlMetaAssetsRepository } from './mysql-meta-assets.repository.js';

@Module({})
export class MetaAssetsModule {
  static register(environment: ApiEnvironment): DynamicModule {
    return {
      module: MetaAssetsModule,
      imports: [JobsModule.register(environment)],
      providers: [{
        provide: META_ASSETS_REPOSITORY,
        useFactory: (database: DurableWorkDatabase, outbox: OutboxService) =>
          new MysqlMetaAssetsRepository(database, outbox),
        inject: [DURABLE_WORK_DATABASE, OutboxService],
      }],
      exports: [META_ASSETS_REPOSITORY, JobsModule],
    };
  }
}
