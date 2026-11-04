import type { JobExecutionAuthorizationPort, VerifiedJobExecutionContext } from '../../src/jobs/job-execution-authorization.js';
import type { ClaimedJob } from '../../src/jobs/job-store.js';
import type { VerifiedServiceTenantScope } from '../../src/identity/identity.types.js';

/** Test-only authorization stub. Production uses MysqlJobExecutionAuthorizationPort. */
export const syntheticJobAuthorization: JobExecutionAuthorizationPort = {
  async authorize(job: ClaimedJob): Promise<VerifiedJobExecutionContext> {
    return {
      jobId: job.id,
      tenantId: job.tenantId,
      principalId: 'synthetic-service-principal',
      resourceRef: job.resourceScopeRef,
      serviceScope: {} as VerifiedServiceTenantScope,
    } as VerifiedJobExecutionContext;
  },
};
