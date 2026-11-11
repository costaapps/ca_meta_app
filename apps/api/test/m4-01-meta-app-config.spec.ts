import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { validateEnvironment, EnvironmentValidationError } from '../src/config/environment.js';
import {
  buildMetaBootstrap,
  parseMetaAppConfigurations,
  parseTrustedMetaProviderAppIds,
  type MetaAppConfiguration,
} from '../src/meta-config/meta-app-config.configuration.js';
import { META_CAPABILITY_MANIFEST, META_CAPABILITY_MANIFEST_VERSION } from '../src/meta-config/capability-manifest.js';
import { MetaAppConfigController } from '../src/meta-config/meta-app-config.controller.js';
import { META_APP_CONFIG_REGISTRY, MetaAppConfigRegistry } from '../src/meta-config/meta-app-config.registry.js';
import { PortalSessionGuard } from '../src/identity/portal-session.guard.js';
import { PortalSessionVerifier } from '../src/identity/identity.trust.js';
import { PORTAL_SESSION_COOKIE } from '../src/identity/portal-session.service.js';

const testOrigin = 'https://meta-test.example.invalid';
const testCallback = `${testOrigin}/api/v1/meta/callback/whatsapp-coexistence`;
const activePortalSessionCookie = 'synthetic-active-portal-session-cookie-value-1234567890';
// Numeric IDs below are isolated parser fixtures only, never real Meta app IDs.
const testProviderAppId = '1234567890';
const testProviderAppIdRef = 'wa-coexistence-test-app';
const syntheticProductionProviderAppId = '9999999999';
const syntheticProductionProviderAppIdRef = 'wa-coexistence-production-app';

function rawProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configurationRef: 'wa-coexistence-test-v1',
    environment: 'test',
    flowVariant: 'WHATSAPP_COEXISTENCE',
    authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
    providerAppIdRef: testProviderAppIdRef,
    publicConfigId: 'synthetic-public-config',
    appMode: 'DEVELOPMENT',
    appDomain: 'meta-test.example.invalid',
    callbackUri: testCallback,
    redirectAllowlist: [testCallback],
    appSecretRef: 'vault://meta-app/test/wa-coexistence/app-secret',
    tokenConfigurationRef: 'vault://meta-app/test/wa-coexistence/token-config',
    capabilityManifestVersion: META_CAPABILITY_MANIFEST_VERSION,
    enabled: true,
    versions: {
      graphApi: { value: 'v27.0', status: 'NOT_CONFIRMED' },
      javascriptSdk: { value: 'v0.0', status: 'NOT_CONFIRMED' },
      embeddedSignup: { value: 'v0.0', status: 'NOT_CONFIRMED' },
    },
    capabilityEvidence: [],
    ...overrides,
  };
}

function parseProfiles(
  values: readonly Record<string, unknown>[],
  environment: 'development' | 'test' | 'staging' | 'production' = 'test',
  allowedOrigins: readonly string[] = [testOrigin],
  trustedProviderAppId = testProviderAppId,
) {
  const invalid: string[] = [];
  const trustedAppIds = parseTrustedMetaProviderAppIds(JSON.stringify([{
    environment,
    flowVariant: 'WHATSAPP_COEXISTENCE',
    authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
    providerAppIdRef: testProviderAppIdRef,
    providerAppId: trustedProviderAppId,
  }]), environment, invalid);
  const profiles = parseMetaAppConfigurations(JSON.stringify(values), environment, allowedOrigins, invalid, trustedAppIds);
  return { profiles, invalid };
}

function validEnvironment(values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    API_PORT: '0',
    API_BIND_ADDRESS: '127.0.0.1',
    API_ALLOWED_HOSTS: 'localhost',
    API_ALLOWED_ORIGINS: testOrigin,
    API_META_TRUSTED_APP_IDS_JSON: JSON.stringify([{
      environment: 'test',
      flowVariant: 'WHATSAPP_COEXISTENCE',
      authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
      providerAppIdRef: testProviderAppIdRef,
      providerAppId: testProviderAppId,
    }]),
    API_TRUSTED_PROXIES: 'none',
    API_DATABASE_HOST: '127.0.0.1',
    API_DATABASE_PORT: '3306',
    API_DATABASE_NAME: 'synthetic',
    API_DATABASE_USER: 'synthetic',
    API_DATABASE_PASSWORD: 'synthetic-only',
    API_DATABASE_CONNECT_TIMEOUT_MS: '1000',
    API_PORTAL_SESSION_RECOVERY_KEY: 'synthetic-session-recovery-key-123456',
    ...values,
  };
}

function versionedProfile(): Record<string, unknown> {
  const value = rawProfile();
  value.versions = {
    graphApi: {
      value: 'v27.0', status: 'VERIFIED',
      evidenceUrl: 'https://developers.facebook.com/docs/graph-api/overview/', verifiedAt: '2026-11-06',
    },
    javascriptSdk: {
      value: 'v24.0', status: 'VERIFIED',
      evidenceUrl: 'https://developers.facebook.com/docs/javascript/quickstart/', verifiedAt: '2026-11-06',
    },
    embeddedSignup: {
      value: 'v1.0', status: 'VERIFIED',
      evidenceUrl: 'https://developers.facebook.com/docs/whatsapp/embedded-signup/', verifiedAt: '2026-11-06',
    },
  };
  return value;
}

test('missing Meta configuration safely disables the five explicit flow/auth profiles', () => {
  const invalid: string[] = [];
  const profiles = parseMetaAppConfigurations(undefined, 'test', [testOrigin], invalid);
  assert.equal(profiles, undefined);
  assert.deepEqual(invalid, []);

  const bootstrap = buildMetaBootstrap(profiles);
  assert.equal(bootstrap.profiles.length, 5);
  assert.deepEqual(bootstrap.profiles.map(({ flowVariant, authVariant }) => `${flowVariant}:${authVariant}`), [
    'FACEBOOK:FACEBOOK_LOGIN_FOR_BUSINESS',
    'INSTAGRAM:INSTAGRAM_VIA_FACEBOOK_LOGIN',
    'INSTAGRAM:INSTAGRAM_LOGIN',
    'WHATSAPP_EXCLUSIVE:WHATSAPP_EMBEDDED_SIGNUP',
    'WHATSAPP_COEXISTENCE:WHATSAPP_BUSINESS_APP_ONBOARDING',
  ]);
  assert.ok(bootstrap.profiles.every((profile) => !profile.enabled && profile.reasonCode === 'CONFIGURATION_MISSING'));
});

test('a profile parses only when environment, auth variant, redirect origin and secret references match', () => {
  const parsed = parseProfiles([rawProfile()]);
  assert.deepEqual(parsed.invalid, []);
  assert.equal(parsed.profiles?.length, 1);
  assert.equal(parsed.profiles?.[0]?.authVariant, 'WHATSAPP_BUSINESS_APP_ONBOARDING');
  assert.equal(parsed.profiles?.[0]?.versions.graphApi.status, 'NOT_CONFIRMED');

  for (const invalidProfile of [
    rawProfile({ environment: 'production', appMode: 'LIVE' }),
    rawProfile({ authVariant: 'WHATSAPP_EMBEDDED_SIGNUP' }),
    rawProfile({ callbackUri: 'https://prod.example.invalid/callback' }),
    rawProfile({ appDomain: 'another.example.invalid' }),
    rawProfile({ appSecretRef: 'plaintext-app-secret-marker' }),
    rawProfile({ tokenConfigurationRef: 'plaintext-token-marker' }),
    rawProfile({ callbackUri: 'https://meta-test.example.invalid/callback', redirectAllowlist: [testCallback] }),
    rawProfile({ capabilityManifestVersion: 'unreviewed-version' }),
    rawProfile({ versions: { graphApi: { value: 'v27.0', status: 'VERIFIED', evidenceUrl: 'https://evil.example/docs', verifiedAt: '2026-11-06' }, javascriptSdk: { value: 'v24.0', status: 'NOT_CONFIRMED' }, embeddedSignup: { value: 'v1.0', status: 'NOT_CONFIRMED' } } }),
  ]) {
    const result = parseProfiles([invalidProfile]);
    assert.equal(result.profiles, undefined);
    assert.deepEqual(result.invalid, ['API_META_APP_CONFIGS_JSON']);
  }

  const normalizedDomain = parseProfiles([rawProfile({ appDomain: 'META-TEST.EXAMPLE.INVALID' })]);
  assert.deepEqual(normalizedDomain.invalid, []);
  assert.equal(normalizedDomain.profiles?.[0]?.appDomain, 'META-TEST.EXAMPLE.INVALID');
});

test('staging cannot select production/live config', () => {
  const productionProfile = rawProfile({
    environment: 'production', appMode: 'LIVE', appDomain: 'meta-test.example.invalid',
  });
  const mixed = parseProfiles([productionProfile], 'staging');
  assert.equal(mixed.profiles, undefined);
  assert.deepEqual(mixed.invalid, ['API_META_APP_CONFIGS_JSON']);
});

test('staging resolves app IDs only from its trusted namespace and rejects production refs', () => {
  const stagingProfile = rawProfile({
    environment: 'staging',
    appSecretRef: 'vault://meta-app/staging/wa-coexistence/app-secret',
    tokenConfigurationRef: 'vault://meta-app/staging/wa-coexistence/token-config',
  });
  const trustedStaging = parseProfiles([stagingProfile], 'staging', [testOrigin], '2222222222');
  assert.deepEqual(trustedStaging.invalid, []);
  assert.equal(trustedStaging.profiles?.[0]?.providerAppId, '2222222222');

  const productionIdRefInStagingProfile = parseProfiles([{
    ...stagingProfile,
    providerAppIdRef: syntheticProductionProviderAppIdRef,
  }], 'staging', [testOrigin], '2222222222');
  assert.equal(productionIdRefInStagingProfile.profiles, undefined);
  assert.deepEqual(productionIdRefInStagingProfile.invalid, ['API_META_APP_CONFIGS_JSON']);

  const productionRefsInStaging = parseProfiles([rawProfile({
    environment: 'staging',
    appSecretRef: 'vault://meta-app/production/wa-coexistence/app-secret',
    tokenConfigurationRef: 'vault://meta-app/production/wa-coexistence/token-config',
  })], 'staging', [testOrigin], '2222222222');
  assert.equal(productionRefsInStaging.profiles, undefined);
  assert.deepEqual(productionRefsInStaging.invalid, ['API_META_APP_CONFIGS_JSON']);

  const invalidStagingAllowlist: string[] = [];
  const productionAllowlistForStaging = parseTrustedMetaProviderAppIds(JSON.stringify([{
    environment: 'production',
    flowVariant: 'WHATSAPP_COEXISTENCE',
    authVariant: 'WHATSAPP_BUSINESS_APP_ONBOARDING',
    providerAppIdRef: testProviderAppIdRef,
    providerAppId: syntheticProductionProviderAppId,
  }]), 'staging', invalidStagingAllowlist);
  assert.equal(productionAllowlistForStaging, undefined);
  assert.deepEqual(invalidStagingAllowlist, ['API_META_TRUSTED_APP_IDS_JSON']);
});

test('duplicate profile selection is rejected', () => {
  const duplicate = parseProfiles([rawProfile(), rawProfile({ configurationRef: 'wa-coexistence-test-v2' })]);
  assert.equal(duplicate.profiles, undefined);
  assert.deepEqual(duplicate.invalid, ['API_META_APP_CONFIGS_JSON']);

  const archivedRollback = parseProfiles([rawProfile({ rollbackConfigurationRef: 'wa-coexistence-test-v0' })]);
  assert.deepEqual(archivedRollback.invalid, []);
  assert.equal(archivedRollback.profiles?.[0]?.rollbackConfigurationRef, 'wa-coexistence-test-v0');

  const selfRollback = parseProfiles([rawProfile({ rollbackConfigurationRef: 'wa-coexistence-test-v1' })]);
  assert.equal(selfRollback.profiles, undefined);
  assert.deepEqual(selfRollback.invalid, ['API_META_APP_CONFIGS_JSON']);

  const malformedRollback = parseProfiles([rawProfile({ rollbackConfigurationRef: '../unsafe-ref' })]);
  assert.equal(malformedRollback.profiles, undefined);
  assert.deepEqual(malformedRollback.invalid, ['API_META_APP_CONFIGS_JSON']);
});

test('environment errors name the config field but never echo secret or token material', () => {
  const secretMarker = 'must-not-appear-in-error-output';
  const invalidJson = JSON.stringify([rawProfile({ appSecretRef: secretMarker })]);
  assert.throws(() => validateEnvironment(validEnvironment({ API_META_APP_CONFIGS_JSON: invalidJson })), (error: unknown) => {
    assert.ok(error instanceof EnvironmentValidationError);
    assert.deepEqual(error.fieldNames, ['API_META_APP_CONFIGS_JSON']);
    assert.doesNotMatch(error.message, new RegExp(secretMarker));
    return true;
  });
});

test('unverified version and unconfirmed permission mapping keep a profile unavailable', () => {
  const parsed = parseProfiles([rawProfile()]);
  assert.ok(parsed.profiles);
  const versionBlocked = buildMetaBootstrap(parsed.profiles).profiles.find((item) => item.flowVariant === 'WHATSAPP_COEXISTENCE');
  assert.equal(versionBlocked?.enabled, false);
  assert.equal(versionBlocked?.reasonCode, 'VERSION_EVIDENCE_REQUIRED');

  const reviewedShapeButNoOperationEvidence = parseProfiles([versionedProfile()]);
  assert.ok(reviewedShapeButNoOperationEvidence.profiles);
  const capabilityBlocked = buildMetaBootstrap(reviewedShapeButNoOperationEvidence.profiles).profiles
    .find((item) => item.flowVariant === 'WHATSAPP_COEXISTENCE');
  assert.equal(capabilityBlocked?.enabled, false);
  assert.equal(capabilityBlocked?.reasonCode, 'CAPABILITY_EVIDENCE_MISSING');

  const facebook = buildMetaBootstrap([]).profiles.find((item) => item.flowVariant === 'FACEBOOK');
  assert.equal(facebook?.capabilities.find((item) => item.operation === 'ASSET_DISCOVERY')?.reasonCode, 'CONFIGURATION_MISSING');

  const mixedPermissionEvidence = versionedProfile();
  mixedPermissionEvidence.capabilityEvidence = [{
    operation: 'ASSET_DISCOVERY',
    permissions: [
      {
        permission: 'business_management', permissionStatus: 'CONFIRMED', accessLevel: 'ADVANCED',
        appReviewStatus: 'APPROVED', sandboxStatus: 'PASSED', approvalOwner: 'synthetic-reviewer',
        evidenceUrl: 'https://developers.facebook.com/docs/whatsapp/embedded-signup/',
      },
      {
        permission: 'whatsapp_business_management', permissionStatus: 'CONFIRMED', accessLevel: 'NOT_CONFIRMED',
        appReviewStatus: 'SUBMITTED', sandboxStatus: 'NOT_TESTED',
      },
    ],
  }];
  const mixed = parseProfiles([mixedPermissionEvidence]);
  assert.ok(mixed.profiles);
  const mixedCapability = buildMetaBootstrap(mixed.profiles).profiles
    .find((item) => item.flowVariant === 'WHATSAPP_COEXISTENCE')?.capabilities
    .find((item) => item.operation === 'ASSET_DISCOVERY');
  assert.equal(mixedCapability?.enabled, false);
  assert.equal(mixedCapability?.reasonCode, 'ACCESS_LEVEL_NOT_CONFIRMED');
});

test('public bootstrap is an allowlist projection and never serializes private profile fields', () => {
  const secretRef = 'vault://meta-app/test/private/app-secret';
  const tokenRef = 'vault://meta-app/test/private/token-config';
  const values = parseProfiles([rawProfile({ appSecretRef: secretRef, tokenConfigurationRef: tokenRef })]);
  assert.ok(values.profiles);
  const registry = new MetaAppConfigRegistry(values.profiles as readonly MetaAppConfiguration[]);
  const serialized = JSON.stringify(registry.bootstrap());
  assert.doesNotMatch(serialized, /appSecretRef|tokenConfigurationRef|callbackUri|redirectAllowlist/);
  assert.doesNotMatch(serialized, /vault:\/\/meta-app\/test\/private/);
  assert.doesNotMatch(serialized, /v27\.0/);
  assert.equal(registry.resolve('WHATSAPP_COEXISTENCE', 'WHATSAPP_BUSINESS_APP_ONBOARDING', 'test'), undefined);
});

test('the bootstrap route requires a portal session and returns only its allowlist DTO', async (t) => {
  const parsed = parseProfiles([rawProfile()]);
  assert.ok(parsed.profiles);
  const sessionDigest = createHash('sha256').update(activePortalSessionCookie, 'utf8').digest();
  const sessions = new PortalSessionVerifier({
    async findActiveBySecretHash(secretHash) {
      if (!Buffer.from(secretHash).equals(sessionDigest)) return undefined;
      return {
        sessionId: 'synthetic-session-id',
        principalId: 'synthetic-principal-id',
        tenantId: 'synthetic-tenant-id',
        contextVersion: 1,
        contextRefHash: 'c'.repeat(64),
        csrfTokenHash: 'd'.repeat(64),
        entryMode: 'PORTAL_TOP_LEVEL',
      };
    },
  });
  const moduleRef = await Test.createTestingModule({
    controllers: [MetaAppConfigController],
    providers: [
      PortalSessionGuard,
      { provide: PortalSessionVerifier, useValue: sessions },
      {
        provide: META_APP_CONFIG_REGISTRY,
        useValue: new MetaAppConfigRegistry(parsed.profiles as readonly MetaAppConfiguration[]),
      },
    ],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  t.after(async () => app.close());
  const address = app.getHttpServer().address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/api/v1/meta/bootstrap`;

  const unauthenticated = await fetch(endpoint);
  assert.equal(unauthenticated.status, 401);

  const authenticated = await fetch(endpoint, {
    headers: { cookie: `${PORTAL_SESSION_COOKIE}=${activePortalSessionCookie}` },
  });
  assert.equal(authenticated.status, 200);
  const body = await authenticated.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['manifestVersion', 'profiles', 'requestId']);
  const profile = (body.profiles as Record<string, unknown>[])
    .find((item) => item.flowVariant === 'WHATSAPP_COEXISTENCE');
  assert.ok(profile);
  assert.deepEqual(Object.keys(profile).sort(), ['authVariant', 'capabilities', 'enabled', 'flowVariant', 'reasonCode']);
  assert.equal(profile.enabled, false);
  assert.doesNotMatch(JSON.stringify(body), /vault:\/\/meta-app|callbackUri|redirectAllowlist|tokenConfigurationRef/);
});

test('each product/auth profile has an explicit versioned operation policy', () => {
  const rows = META_CAPABILITY_MANIFEST;
  assert.equal(rows.length, 26);
  assert.ok(rows.every((row) => row.evidenceSources.length >= 2));
  assert.ok(rows.every((row) => row.approvalOwner === 'UNASSIGNED'));
  assert.ok(rows.some((row) => row.flowVariant === 'WHATSAPP_COEXISTENCE' && row.operation === 'SYNC_HISTORY'));
  assert.ok(rows.some((row) => row.flowVariant === 'WHATSAPP_EXCLUSIVE' && row.operation === 'PHONE_REGISTRATION_CONVENTIONAL'));
  assert.ok(rows.some((row) => row.flowVariant === 'INSTAGRAM' && row.authVariant === 'INSTAGRAM_LOGIN' && row.operation === 'SEND_MESSAGE'));
  assert.ok(rows.some((row) => row.flowVariant === 'INSTAGRAM' && row.authVariant === 'INSTAGRAM_VIA_FACEBOOK_LOGIN' && row.operation === 'MANAGE_COMMENTS'));
});
