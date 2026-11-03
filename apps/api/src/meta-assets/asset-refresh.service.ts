import { randomUUID } from 'node:crypto';
import type { components } from '@ca-meta/contracts';
import type { DurableWorkDatabase } from '../jobs/durable-work-database.js';
import type { DurableJobStore } from '../jobs/job-store.js';
import type { MetaEnvironment } from './meta-assets.types.js';

export const META_ASSET_REFRESH_ADAPTER = Symbol('META_ASSET_REFRESH_ADAPTER');

export interface MetaAssetRefreshAdapter {
  refresh(input: { readonly tenantId: string; readonly assetId: string; readonly appConfigurationId: string;
    readonly environment: MetaEnvironment }, signal: AbortSignal): Promise<void>;
}

/** Serializes admissions by tenant and asset. The adapter is absent until a real provider implementation is installed. */
export class AssetRefreshCoordinator {
  constructor(
    private readonly database: DurableWorkDatabase,
    private readonly jobs: DurableJobStore,
    readonly adapter: MetaAssetRefreshAdapter | null | undefined,
  ) {}

  get available(): boolean { return Boolean(this.adapter); }

  async enqueue(input: {
    readonly tenantId: string;
    readonly assetId: string;
    readonly appConfigurationId: string;
    readonly environment: MetaEnvironment;
    readonly requestId: string;
  }): Promise<components['schemas']['JobAccepted']> {
    if (!this.adapter) throw new AssetRefreshUnavailableError();
    const database = await this.database.getDataSource();
    const result = await database.transaction(async (manager) => {
      const tenants = await manager.query(
        'SELECT id FROM ca_meta_tenants WHERE id = ? FOR UPDATE', [input.tenantId],
      ) as Array<{ id: string }>;
      if (tenants.length !== 1) throw new AssetRefreshUnavailableError();

      const active = await manager.query(
        `SELECT id FROM ca_meta_jobs
         WHERE tenant_id = ? AND job_type = 'ASSET_REFRESH' AND resource_scope_ref = ?
           AND status IN ('QUEUED', 'RETRY_PENDING', 'RUNNING')
         ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
        [input.tenantId, input.assetId],
      ) as Array<{ id: string }>;
      if (active[0]) return { id: active[0].id };

      const queued = await this.jobs.enqueueWithin(manager, {
        tenantId: input.tenantId,
        type: 'ASSET_REFRESH',
        idempotencyKey: randomUUID(),
        correlationId: input.requestId,
        resourceScopeRef: input.assetId,
        payload: {
          kind: 'ASSET_REFRESH', assetId: input.assetId,
          appConfigurationId: input.appConfigurationId, environment: input.environment,
        },
      });
      return { id: queued.id };
    });
    return Object.freeze({ jobId: result.id, status: 'PENDING', location: `/api/v1/jobs/${result.id}`, requestId: input.requestId });
  }
}

export class AssetRefreshUnavailableError extends Error {
  constructor() { super('Asset refresh is unavailable.'); this.name = 'AssetRefreshUnavailableError'; }
}
