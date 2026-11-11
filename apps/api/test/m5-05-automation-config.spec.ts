import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { components } from '@ca-meta/contracts';
import { BadRequestException } from '@nestjs/common';
import { AutomationConfigController } from '../src/automation-config/automation-config.controller.js';
import { AutomationConfigService } from '../src/automation-config/automation-config.service.js';
import { IdentityDeniedError } from '../src/identity/identity.errors.js';
import type { IdentityRepository } from '../src/identity/identity.repository.js';
import { TenantAuthorizationService, TenantContextService, hashTenantContextReference } from '../src/identity/identity.service.js';
import { PortalSessionVerifier, type VerifiedPortalSession } from '../src/identity/identity.trust.js';
import type { PortalRequest } from '../src/identity/portal-session.guard.js';
import type { AuthorizedTenantScope, MembershipRole } from '../src/identity/identity.types.js';
import type { AssetCatalogReadModel, MetaEnvironment } from '../src/meta-assets/meta-assets.types.js';
import type { MetaAssetsRepository } from '../src/meta-assets/mysql-meta-assets.repository.js';
import {
  AutomationConfigNotFoundError,
  AutomationConfigValidationError,
  AutomationConfigVersionConflictError,
  type AutomationConfigPatch,
  type AutomationConfigRepository,
  type AutomationConfigState,
} from '../src/automation-config/automation-config.types.js';

const tenantA = '00000000-0000-4000-8000-000000000001';
const tenantB = '00000000-0000-4000-8000-000000000002';
const principalId = '00000000-0000-4000-8000-000000000003';
const appConfigurationId = '00000000-0000-4000-8000-000000000004';
const numberOne = '00000000-0000-4000-8000-000000000011';
const numberTwo = '00000000-0000-4000-8000-000000000012';
const facebookPage = '00000000-0000-4000-8000-000000000013';
const instagramAccount = '00000000-0000-4000-8000-000000000014';
const contextRef = 'synthetic-current-tenant-context-01';
const sessionToken = 'synthetic-portal-session-token-value-00000001';

function asset(assetRef: string, kind: AssetCatalogReadModel['kind']): AssetCatalogReadModel {
  return {
    assetRef,
    appConfigurationId,
    kind,
    displayLabel: `Synthetic ${kind}`,
    status: 'ACTIVE',
    authorizationStatus: 'VERIFIED',
    observedAt: '2026-11-11T10:00:00.000Z',
    lastVerifiedAt: '2026-11-11T10:00:00.000Z',
    verificationSource: 'META_API',
    stale: false,
    capabilityEvidence: [],
    diagnostics: {
      onboardingStatus: 'UNKNOWN',
      onboardingReadiness: 'UNKNOWN',
      onboardingNextAction: 'UNKNOWN',
      tokenHealth: 'UNKNOWN',
      tokenHealthObservedAt: null,
      metaState: 'UNKNOWN',
      metaObservedAt: null,
      subscriptionState: 'UNKNOWN',
      projectionState: 'UNKNOWN',
    },
    reauthorizationRequired: false,
  };
}

function setup(input: { readonly roles?: readonly MembershipRole[] } = {}) {
  const roles = input.roles ?? ['owner'];
  const identityRepository = {
    async findMembership(requestPrincipalId: string, tenantId: string) {
      if (requestPrincipalId !== principalId || ![tenantA, tenantB].includes(tenantId)) return undefined;
      return {
        principalId,
        tenantId,
        principalKind: 'USER' as const,
        principalStatus: 'ACTIVE' as const,
        tenantStatus: 'ACTIVE' as const,
        roles,
        status: 'ACTIVE' as const,
        version: 1,
      };
    },
  } as unknown as IdentityRepository;
  const contexts = new TenantContextService(identityRepository);
  const authorization = new TenantAuthorizationService(identityRepository);
  const contextHash = hashTenantContextReference(contextRef);
  const assets = new Map<string, AssetCatalogReadModel>([
    [`${tenantA}:${numberOne}`, asset(numberOne, 'WHATSAPP_PHONE_NUMBER')],
    [`${tenantA}:${numberTwo}`, asset(numberTwo, 'WHATSAPP_PHONE_NUMBER')],
    [`${tenantA}:${facebookPage}`, asset(facebookPage, 'FACEBOOK_PAGE')],
    [`${tenantA}:${instagramAccount}`, asset(instagramAccount, 'INSTAGRAM_BUSINESS_ACCOUNT')],
  ]);
  const assetLookups: Array<{ tenantId: string; assetRef: string; environment: MetaEnvironment }> = [];
  const assetRepository = {
    async findAssetCatalog(query: { tenantId: string; assetRef: string; environment: MetaEnvironment }) {
      assetLookups.push(query);
      return assets.get(`${query.tenantId}:${query.assetRef}`);
    },
  } as unknown as MetaAssetsRepository;
  const rows = new Map<string, AutomationConfigState>();
  const history: Array<{ tenantId: string; assetId: string; version: number; fields: readonly string[] }> = [];
  const configRepository: AutomationConfigRepository = {
    async read(query) {
      return rows.get(`${query.tenantId}:${query.assetId}`) ?? Object.freeze({
        privateWelcomeMessage: null, commentPublicReply: null, commentPrivateReply: null,
        version: 0, updatedAt: null, projectionState: 'UNKNOWN',
      });
    },
    async update(query) {
      const key = `${query.tenantId}:${query.assetId}`;
      const current = rows.get(key) ?? Object.freeze({
        privateWelcomeMessage: null, commentPublicReply: null, commentPrivateReply: null,
        version: 0, updatedAt: null, projectionState: 'UNKNOWN',
      });
      if (query.patch.version !== current.version) throw new AutomationConfigVersionConflictError();
      const next = Object.freeze({
        privateWelcomeMessage: query.patch.privateWelcomeMessage === undefined ? current.privateWelcomeMessage : query.patch.privateWelcomeMessage || null,
        commentPublicReply: query.patch.commentPublicReply === undefined ? current.commentPublicReply : query.patch.commentPublicReply || null,
        commentPrivateReply: query.patch.commentPrivateReply === undefined ? current.commentPrivateReply : query.patch.commentPrivateReply || null,
        version: current.version + 1,
        updatedAt: '2026-11-11T10:01:00.000Z',
        projectionState: 'PENDING' as const,
      });
      rows.set(key, next);
      history.push({ tenantId: query.tenantId, assetId: query.assetId, version: next.version,
        fields: Object.keys(query.patch).filter((field) => field !== 'version') });
      return next;
    },
  };
  const service = new AutomationConfigService(configRepository, assetRepository, contexts, authorization, 'test');
  const sessions = new PortalSessionVerifier({
    async findActiveBySecretHash() {
      return {
        sessionId: '00000000-0000-4000-8000-000000000005',
        principalId,
        tenantId: tenantA,
        contextVersion: 1,
        contextRefHash: contextHash,
        csrfTokenHash: 'a'.repeat(64),
        entryMode: 'PORTAL_TOP_LEVEL' as const,
      };
    },
  });
  return {
    service,
    sessions,
    rows,
    history,
    assetLookups,
    async session(tenantId: string = tenantA): Promise<VerifiedPortalSession> {
      const tenantSessionVerifier = tenantId === tenantA ? sessions : new PortalSessionVerifier({
        async findActiveBySecretHash() {
          return {
            sessionId: '00000000-0000-4000-8000-000000000006', principalId, tenantId,
            contextVersion: 1, contextRefHash: contextHash, csrfTokenHash: 'b'.repeat(64), entryMode: 'PORTAL_TOP_LEVEL' as const,
          };
        },
      });
      const result = await tenantSessionVerifier.verify(sessionToken);
      assert.ok(result);
      return result;
    },
  };
}

test('channel capabilities keep WhatsApp number and Facebook/Instagram reply fields distinct and non-executable', async () => {
  const state = setup();
  const session = await state.session();
  const whatsapp = await state.service.read(session, contextRef, numberOne, 'req-synthetic-automation-read');
  const facebook = await state.service.read(session, contextRef, facebookPage, 'req-synthetic-automation-read');
  const instagram = await state.service.read(session, contextRef, instagramAccount, 'req-synthetic-automation-read');

  assert.equal(whatsapp.assetKind, 'WHATSAPP_PHONE_NUMBER');
  assert.deepEqual(whatsapp.supportedFields, ['privateWelcomeMessage']);
  assert.deepEqual(facebook.supportedFields, ['commentPublicReply', 'commentPrivateReply']);
  assert.deepEqual(instagram.supportedFields, ['commentPublicReply', 'commentPrivateReply']);
  assert.equal(whatsapp.inheritanceMode, 'ASSET_ONLY');
  assert.equal(whatsapp.capabilities.executable, false);
  assert.equal(whatsapp.capabilities.canEdit, true);
});

test('controller returns strong version ETags and rejects malformed preconditions', async () => {
  const responseBody: components['schemas']['AutomationConfig'] = {
    assetId: numberOne,
    assetKind: 'WHATSAPP_PHONE_NUMBER',
    inheritanceMode: 'ASSET_ONLY',
    supportedFields: ['privateWelcomeMessage'],
    privateWelcomeMessage: null,
    commentPublicReply: null,
    commentPrivateReply: null,
    capabilities: { canEdit: true, executable: false },
    version: 0,
    updatedAt: null,
    projectionState: 'UNKNOWN',
    requestId: 'req-synthetic-controller-01',
  };
  const controller = new AutomationConfigController({
    async read() { return responseBody; },
    async update() { return { ...responseBody, version: 1, projectionState: 'PENDING' }; },
  } as unknown as AutomationConfigService);
  const request = { requestId: 'req-synthetic-controller-01', portalSession: {} as VerifiedPortalSession } as PortalRequest;
  const headers = new Map<string, string>();
  const response = { setHeader(name: string, value: string) { headers.set(name, value); } } as unknown as import('express').Response;
  const currentContext = 'synthetic-current-tenant-context-01';

  await controller.read(numberOne, request, currentContext, response);
  assert.equal(headers.get('ETag'), '"automation-v0"');
  const updated = await controller.update(numberOne, { version: 0, privateWelcomeMessage: 'Synthetic' },
    request, currentContext, '"automation-v0"', response);
  assert.equal(updated.version, 1);
  assert.equal(headers.get('ETag'), '"automation-v1"');
  await assert.rejects(controller.update(numberOne, { version: 1, privateWelcomeMessage: 'stale' },
    request, currentContext, 'W/"automation-v1"', response), BadRequestException);
});

test('updates stay isolated per number and only supported fields create history', async () => {
  const state = setup();
  const session = await state.session();
  const saved = await state.service.update(session, contextRef, numberOne, 'req-synthetic-automation-save', 0, {
    version: 0,
    privateWelcomeMessage: 'Synthetic welcome',
  });
  const untouchedNumber = await state.service.read(session, contextRef, numberTwo, 'req-synthetic-automation-read');
  assert.equal(saved.privateWelcomeMessage, 'Synthetic welcome');
  assert.equal(saved.version, 1);
  assert.equal(saved.projectionState, 'PENDING');
  assert.equal(untouchedNumber.privateWelcomeMessage, null);
  assert.equal(untouchedNumber.version, 0);
  assert.deepEqual(state.history.map((entry) => [entry.assetId, entry.version, entry.fields]), [
    [numberOne, 1, ['privateWelcomeMessage']],
  ]);

  const cleared = await state.service.update(session, contextRef, numberOne, 'req-synthetic-automation-clear', 1, {
    version: 1,
    privateWelcomeMessage: '',
  });
  assert.equal(cleared.privateWelcomeMessage, null);
  assert.equal(cleared.version, 2);

  await assert.rejects(state.service.update(session, contextRef, numberOne, 'req-synthetic-automation-save', 1, {
    version: 1,
    privateWelcomeMessage: 'not supported here',
    commentPublicReply: 'unsupported on a WhatsApp number',
  }), AutomationConfigValidationError);
  await assert.rejects(state.service.update(session, contextRef, facebookPage, 'req-synthetic-automation-save', 0, {
    version: 0,
    privateWelcomeMessage: 'unsupported on a Facebook page',
  }), AutomationConfigValidationError);
});

test('stale ETag/body version cannot overwrite a newer configuration', async () => {
  const state = setup();
  const session = await state.session();
  await state.service.update(session, contextRef, facebookPage, 'req-synthetic-automation-save', 0, {
    version: 0,
    commentPublicReply: 'Synthetic public reply',
  });
  await assert.rejects(state.service.update(session, contextRef, facebookPage, 'req-synthetic-automation-stale', 0, {
    version: 0,
    commentPrivateReply: 'stale update',
  }), AutomationConfigVersionConflictError);
  await assert.rejects(state.service.update(session, contextRef, facebookPage, 'req-synthetic-automation-stale', 1, {
    version: 0,
    commentPrivateReply: 'mismatched ETag and body',
  }), AutomationConfigVersionConflictError);
  const current = await state.service.read(session, contextRef, facebookPage, 'req-synthetic-automation-read');
  assert.equal(current.version, 1);
  assert.equal(current.commentPublicReply, 'Synthetic public reply');
  assert.equal(current.commentPrivateReply, null);
});

test('viewer reads are safe but cannot update; foreign-tenant asset IDs are not found', async () => {
  const viewerState = setup({ roles: ['viewer'] });
  const viewer = await viewerState.session();
  const readable = await viewerState.service.read(viewer, contextRef, numberOne, 'req-synthetic-automation-read');
  assert.equal(readable.capabilities.canEdit, false);
  await assert.rejects(viewerState.service.update(viewer, contextRef, numberOne, 'req-synthetic-automation-save', 0, {
    version: 0, privateWelcomeMessage: 'blocked viewer write',
  }), IdentityDeniedError);

  const ownerState = setup();
  const foreignTenantSession = await ownerState.session(tenantB);
  await assert.rejects(ownerState.service.read(foreignTenantSession, contextRef, numberOne, 'req-synthetic-automation-read'), AutomationConfigNotFoundError);
  assert.ok(ownerState.assetLookups.every((lookup) => lookup.tenantId === tenantB));
  assert.equal(ownerState.rows.size, 0);
});

test('oversized and control-character message bodies fail validation before persistence', async () => {
  const state = setup();
  const session = await state.session();
  await assert.rejects(state.service.update(session, contextRef, numberOne, 'req-synthetic-automation-invalid', 0, {
    version: 0,
    privateWelcomeMessage: 'x'.repeat(4097),
  }), AutomationConfigValidationError);
  await assert.rejects(state.service.update(session, contextRef, numberOne, 'req-synthetic-automation-invalid', 0, {
    version: 0,
    privateWelcomeMessage: 'bad\u0000text',
  }), AutomationConfigValidationError);
  assert.equal(state.rows.size, 0);
});
