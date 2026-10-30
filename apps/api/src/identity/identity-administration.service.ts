import { createHash, randomUUID } from 'node:crypto';
import { IdentityDeniedError } from './identity.errors.js';
import type { IdentityAdministrationRepository, IdentityAdministrationReason } from './identity-administration.repository.js';
import { isAuthorizedTenantScope } from './identity.types.js';
import { TenantContextService } from './identity.service.js';
import {
  isVerifiedIdentityAssertion,
  isVerifiedPlatformIdentityAdmin,
  isVerifiedPortalSession,
  type VerifiedIdentityAssertion,
  type VerifiedPlatformIdentityAdmin,
  type VerifiedPortalSession,
} from './identity.trust.js';

const REASONS = new Set<IdentityAdministrationReason>([
  'INITIAL_PROVISIONING', 'MEMBERSHIP_GRANT', 'ROLE_CHANGE', 'MEMBERSHIP_REVOCATION',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}

function assertCommandInputs(assertion: VerifiedIdentityAssertion, idempotencyKey: string, reasonCode: IdentityAdministrationReason): void {
  if (!isVerifiedIdentityAssertion(assertion) || !UUID.test(idempotencyKey) || !REASONS.has(reasonCode)) {
    throw new IdentityDeniedError();
  }
}

/** Internal operation service. It has no controller and accepts only server-issued capabilities. */
export class IdentityAdministrationService {
  constructor(
    private readonly repository: IdentityAdministrationRepository,
    private readonly contexts: TenantContextService,
  ) {}

  async bootstrapTenant(
    actor: VerifiedPlatformIdentityAdmin,
    target: VerifiedIdentityAssertion,
    idempotencyKey: string,
  ) {
    if (!isVerifiedPlatformIdentityAdmin(actor)) throw new IdentityDeniedError();
    assertCommandInputs(target, idempotencyKey, 'INITIAL_PROVISIONING');
    return this.repository.execute({
      action: 'BOOTSTRAP_TENANT', actor, target, tenantId: randomUUID(),
      reasonCode: 'INITIAL_PROVISIONING', idempotencyKey,
      requestHash: requestHash(['BOOTSTRAP_TENANT', target.issuer, target.subject, 'owner', 'INITIAL_PROVISIONING']),
    });
  }

  async grantMembership(
    actor: VerifiedPortalSession,
    contextRef: string,
    target: VerifiedIdentityAssertion,
    role: 'admin' | 'operator' | 'viewer',
    reasonCode: 'MEMBERSHIP_GRANT' | 'ROLE_CHANGE',
    idempotencyKey: string,
  ) {
    if (!isVerifiedPortalSession(actor)) throw new IdentityDeniedError();
    assertCommandInputs(target, idempotencyKey, reasonCode);
    const scope = await this.contexts.resolveCurrent(actor, contextRef);
    if (!isAuthorizedTenantScope(scope) || (!scope.roles.includes('owner') && !scope.roles.includes('admin'))) {
      throw new IdentityDeniedError();
    }
    if (role === 'admin' && !scope.roles.includes('owner')) throw new IdentityDeniedError();
    return this.repository.execute({
      action: 'GRANT_MEMBERSHIP', actor, scope, target, role, reasonCode, idempotencyKey,
      requestHash: requestHash(['GRANT_MEMBERSHIP', scope.tenantId, target.issuer, target.subject, role, reasonCode]),
    });
  }

  async revokeMembership(
    actor: VerifiedPortalSession,
    contextRef: string,
    targetPrincipalId: string,
    idempotencyKey: string,
  ) {
    if (!isVerifiedPortalSession(actor) || !targetPrincipalId || !UUID.test(targetPrincipalId) || !UUID.test(idempotencyKey)) {
      throw new IdentityDeniedError();
    }
    const scope = await this.contexts.resolveCurrent(actor, contextRef);
    if (!isAuthorizedTenantScope(scope) || (!scope.roles.includes('owner') && !scope.roles.includes('admin'))) {
      throw new IdentityDeniedError();
    }
    const reasonCode: IdentityAdministrationReason = 'MEMBERSHIP_REVOCATION';
    return this.repository.execute({
      action: 'REVOKE_MEMBERSHIP', actor, scope, targetPrincipalId, reasonCode, idempotencyKey,
      requestHash: requestHash(['REVOKE_MEMBERSHIP', scope.tenantId, targetPrincipalId, reasonCode]),
    });
  }
}
