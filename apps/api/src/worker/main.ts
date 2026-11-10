import 'reflect-metadata';
import { EnvironmentValidationError, validateEnvironment } from '../config/environment.js';
import { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import { DurableJobStore } from '../jobs/job-store.js';
import { FailClosedJobExecutionAuthorizationPort, MysqlJobExecutionAuthorizationPort } from '../jobs/job-execution-authorization.js';
import type { JobExecutionAuthorizationPort } from '../jobs/job-execution-authorization.js';
import { CredentialInspectionWorker, CredentialLifecycleScheduler } from '../credentials/credential-lifecycle.service.js';
import type { CredentialInspectionPort, CredentialLifecyclePolicyPort, CredentialLifecycleSecretPort } from '../credentials/credential-lifecycle.types.js';
import type { JobType } from '../jobs/event-validation.js';
import { DurableWorker, type JobFinalizer, type JobHandler } from './durable-worker.js';
import type { MetaAssetRefreshAdapter } from '../meta-assets/asset-refresh.service.js';
import { MetaWebhookRepository } from '../meta-webhooks/meta-webhook.repository.js';
import { MetaWebhookWorker } from '../meta-webhooks/meta-webhook-worker.js';
import type { MetaWebhookItemProcessor, MetaWebhookPayloadProtector } from '../meta-webhooks/meta-webhook.types.js';
import { MysqlIdentityRepository } from '../identity/mysql-identity.repository.js';
import { ServiceTenantAuthorizationService } from '../identity/identity.service.js';
import { WorkerServiceIdentityVerifier } from '../identity/identity.trust.js';
import type { OnboardingSagaAdapter } from '../onboarding/onboarding-saga.types.js';
import { OnboardingCodeProtector } from '../onboarding/onboarding-code-crypto.js';
import { MysqlOnboardingCodeConsumer } from '../onboarding/onboarding-code-submission.store.js';
import { createOnboardingSagaHandler } from '../onboarding/onboarding-saga.worker.js';
import { MetaOnboardingConfigurationResolver } from '../onboarding/meta-onboarding-configuration.resolver.js';
import { MetaAppConfigRegistry } from '../meta-config/meta-app-config.registry.js';

interface CredentialLifecycleAdapters {
  readonly policies: CredentialLifecyclePolicyPort;
  readonly secrets: CredentialLifecycleSecretPort;
  readonly inspector: CredentialInspectionPort;
}

/** No provider adapter set is installed in this package; an environment flag alone is not capability. */
function configuredCredentialLifecycleAdapters(): CredentialLifecycleAdapters | undefined {
  return undefined;
}

/** A job handler is registered only alongside an installed provider adapter. */
function configuredMetaAssetRefreshAdapter(): MetaAssetRefreshAdapter | undefined {
  return undefined;
}

/** No reviewed Meta onboarding adapter is installed; all provider exchange effects stay disabled. */
function configuredMetaOnboardingSagaAdapter(): OnboardingSagaAdapter | undefined {
  return undefined;
}

interface MetaWebhookWorkerAdapters {
  readonly payloadProtector: MetaWebhookPayloadProtector;
  readonly processor: MetaWebhookItemProcessor;
}

/** Durable webhook items stay unclaimed until both the protected store and local processor exist. */
function configuredMetaWebhookWorkerAdapters(): MetaWebhookWorkerAdapters | undefined {
  return undefined;
}

export async function bootstrapWorker(): Promise<void> {
  let database: DurableWorkDatabase | undefined;
  let identityRepository: MysqlIdentityRepository | undefined;
  try {
    const environment = validateEnvironment(process.env);
    database = new DurableWorkDatabase(environment);
    const handlers = new Map<JobType, JobHandler>();
    const finalizers = new Map<JobType, JobFinalizer>();
    const webhookAdapters = configuredMetaWebhookWorkerAdapters();
    const webhookWorker = webhookAdapters
      ? new MetaWebhookWorker(new MetaWebhookRepository(database), webhookAdapters.payloadProtector,
        webhookAdapters.processor, `meta-webhook-worker:${process.pid}`)
      : undefined;
    let lifecycleScheduler: CredentialLifecycleScheduler | undefined;
    const lifecycleAdapters = environment.credentialLifecycleSchedulerEnabled
      ? configuredCredentialLifecycleAdapters() : undefined;
    if (lifecycleAdapters) {
      const inspection = new CredentialInspectionWorker(database, lifecycleAdapters.policies, lifecycleAdapters.secrets,
        lifecycleAdapters.inspector, Math.random);
      handlers.set('CREDENTIAL_INSPECTION', inspection.handler);
      finalizers.set('CREDENTIAL_INSPECTION', inspection.finalizer);
      lifecycleScheduler = new CredentialLifecycleScheduler(database, new DurableJobStore(database), `api-worker:${process.pid}`);
    }
    const assetRefreshAdapter = configuredMetaAssetRefreshAdapter();
    if (assetRefreshAdapter) {
      handlers.set('ASSET_REFRESH', async (job, signal) => {
        if (job.payload.kind !== 'ASSET_REFRESH') return { kind: 'PERMANENT_FAILURE', safeErrorCode: 'INVALID_REFERENCE' };
        try {
          await assetRefreshAdapter.refresh({ tenantId: job.tenantId, assetId: job.payload.assetId,
            appConfigurationId: job.payload.appConfigurationId, environment: job.payload.environment }, signal);
          return { kind: 'SUCCEEDED' };
        } catch {
          return { kind: 'RETRYABLE_FAILURE', safeErrorCode: 'DEPENDENCY_UNAVAILABLE' };
        }
      });
    }
    const onboardingSagaAdapter = configuredMetaOnboardingSagaAdapter();
    if (onboardingSagaAdapter) {
      const codeConsumer = new MysqlOnboardingCodeConsumer(database,
        new OnboardingCodeProtector(environment.onboardingStateSigningKey));
      const configurations = new MetaOnboardingConfigurationResolver(
        new MetaAppConfigRegistry(environment.metaAppConfigurations ?? []), environment.nodeEnv);
      handlers.set('ONBOARDING_STEP', createOnboardingSagaHandler(database, codeConsumer, onboardingSagaAdapter, undefined, configurations));
    }
    let authorization: JobExecutionAuthorizationPort = new FailClosedJobExecutionAuthorizationPort();
    if (handlers.size > 0) {
      const configuredIdentity = new WorkerServiceIdentityVerifier(environment.identity?.workerServiceCredentials ?? [])
        .verify(process.env.API_JOB_WORKER_CREDENTIAL);
      if (!configuredIdentity) throw new Error('Job worker identity is not configured.');
      identityRepository = new MysqlIdentityRepository(environment.database);
      authorization = new MysqlJobExecutionAuthorizationPort(
        database,
        new ServiceTenantAuthorizationService(identityRepository),
        configuredIdentity,
      );
    }
    // M2.05 provides the durable runner. M3.09 and M3.12 remain without provider adapters here.
    const worker = new DurableWorker(new DurableJobStore(database), {
      workerRef: `api-worker:${process.pid}`,
      leaseMs: 30_000,
    }, handlers, authorization, finalizers);
    const stopping = new AbortController();
    const stop = () => stopping.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const scheduleTask = lifecycleScheduler?.run(stopping.signal, () => {
      process.stderr.write(`${JSON.stringify({ level: 'error', event: 'credential_lifecycle.schedule_failed' })}\n`);
    });
    const webhookTask = webhookWorker?.run(stopping.signal, (safeCode) => {
      process.stderr.write(`${JSON.stringify({ level: 'error', event: 'meta_webhook.worker_failed', safeCode })}\n`);
    });
    process.stdout.write(`${JSON.stringify({ level: 'info', event: 'worker.started', handlers: handlers.size,
      credentialLifecycleSchedulerRequested: environment.credentialLifecycleSchedulerEnabled,
      credentialLifecycleScheduler: Boolean(lifecycleScheduler), metaWebhookWorker: Boolean(webhookWorker) })}\n`);
    try {
      await worker.run(stopping.signal);
    } finally {
      stopping.abort();
      await Promise.all([scheduleTask, webhookTask].filter((task): task is Promise<void> => task !== undefined));
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    }
  } catch (error) {
    const fields = error instanceof EnvironmentValidationError ? error.fieldNames : undefined;
    process.stderr.write(`${JSON.stringify({ level: 'error', event: fields ? 'configuration.invalid' : 'worker.failed', ...(fields ? { fields } : {}) })}\n`);
    process.exitCode = 1;
  } finally {
    if (identityRepository) await identityRepository.onApplicationShutdown().catch(() => { process.exitCode = 1; });
    if (database) await database.close().catch(() => { process.exitCode = 1; });
  }
}

if (require.main === module) void bootstrapWorker();
