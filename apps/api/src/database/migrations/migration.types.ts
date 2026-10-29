export interface MigrationStepContext {
  readonly queryRunner: import('typeorm').QueryRunner;
  readonly migrationId: string;
  readonly stepId: string;
}

export interface DdlStep {
  readonly id: string;
  readonly phase: 'expand' | 'switch' | 'contract';
  readonly sql: string;
  readonly definitionVersion: string;
  readonly definition: string;
  readonly verify: (context: MigrationStepContext) => Promise<boolean>;
  /** DDL steps must be safe to retry when verify returns false after a crash. */
  readonly retryWhenAbsent: true;
}

export interface BackfillStep {
  readonly id: string;
  readonly phase: 'backfill';
  readonly definitionVersion: string;
  readonly definition: string;
  readonly batchSize: number;
  readonly runBatch: (
    context: MigrationStepContext,
    cursor: string | null,
    batchSize: number,
  ) => Promise<{ readonly nextCursor: string | null; readonly done: boolean }>;
}

export interface ValidationStep {
  readonly id: string;
  readonly phase: 'validate';
  readonly definitionVersion: string;
  readonly definition: string;
  readonly validate: (context: MigrationStepContext) => Promise<void>;
}

export type MigrationStep = DdlStep | BackfillStep | ValidationStep;

export interface VersionedMigration {
  readonly id: string;
  readonly schemaVersion: number;
  readonly checksum: string;
  readonly minimumSupportedApiVersion: number;
  readonly steps: readonly MigrationStep[];
}
