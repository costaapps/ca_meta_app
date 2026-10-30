import { createHash } from 'node:crypto';
import type { MigrationStep } from './migration.types.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function migrationStepDefinition(step: MigrationStep): string {
  if ('sql' in step) {
    return [step.id, step.phase, step.definitionVersion, step.definition, step.retryWhenAbsent, step.sql, step.verify.toString()].join('\n');
  }
  if ('runBatch' in step) {
    return [step.id, step.phase, step.definitionVersion, step.definition, step.batchSize, step.runBatch.toString()].join('\n');
  }
  return [step.id, step.phase, step.definitionVersion, step.definition, step.validate.toString()].join('\n');
}

export function migrationStepChecksum(step: MigrationStep): string {
  return sha256(migrationStepDefinition(step));
}

export function migrationChecksum(
  migration: { readonly id: string; readonly schemaVersion: number; readonly steps: readonly MigrationStep[] },
): string {
  return sha256([
    migration.id,
    String(migration.schemaVersion),
    ...migration.steps.map(migrationStepDefinition),
  ].join('\n---\n'));
}
