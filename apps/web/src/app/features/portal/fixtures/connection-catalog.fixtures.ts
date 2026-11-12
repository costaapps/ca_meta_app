import type { components } from '@ca-meta/contracts';

export type ConnectionFixture = components['schemas']['Connection'];
export type ConnectionDetailFixture = components['schemas']['ConnectionDetail'];

export const connectionFixtures: readonly ConnectionFixture[] = Object.freeze([
  { id: '00000000-0000-4000-8000-000000000001', flowVariant: 'FACEBOOK_LOGIN', status: 'ACTIVE', readiness: 'READY', observedAt: '2026-11-10T10:00:00Z', lastVerifiedAt: '2026-11-10T10:00:00Z', verificationSource: 'META_API', stale: false, assetCount: 1 },
  { id: '00000000-0000-4000-8000-000000000002', flowVariant: 'INSTAGRAM_VIA_FACEBOOK_LOGIN', status: 'PARTIAL', readiness: 'PARTIAL', observedAt: '2026-11-10T10:01:00Z', lastVerifiedAt: '2026-11-10T10:01:00Z', verificationSource: 'SIGNED_WEBHOOK', stale: false, assetCount: 1 },
  { id: '00000000-0000-4000-8000-000000000003', flowVariant: 'INSTAGRAM_LOGIN', status: 'REAUTH_REQUIRED', readiness: 'PARTIAL', observedAt: '2026-11-10T10:02:00Z', lastVerifiedAt: '2026-11-10T10:02:00Z', verificationSource: 'META_API', stale: false, assetCount: 1, diagnostics: { onboardingStatus: 'UNKNOWN', onboardingReadiness: 'UNKNOWN', onboardingNextAction: 'UNKNOWN', tokenHealth: 'ACTION_REQUIRED', tokenHealthObservedAt: '2026-11-10T10:02:00Z', metaState: 'REAUTH_REQUIRED', metaObservedAt: '2026-11-10T10:02:00Z', subscriptionState: 'UNKNOWN', projectionState: 'UNKNOWN' } },
  { id: '00000000-0000-4000-8000-000000000004', flowVariant: 'WHATSAPP_CLOUD_API', status: 'UNKNOWN', readiness: 'UNKNOWN', observedAt: '2026-11-10T10:03:00Z', lastVerifiedAt: null, verificationSource: null, stale: true, assetCount: 1 },
  { id: '00000000-0000-4000-8000-000000000005', flowVariant: 'WHATSAPP_COEXISTENCE', status: 'DISCONNECTED', readiness: 'UNKNOWN', observedAt: '2026-11-10T10:04:00Z', lastVerifiedAt: '2026-11-10T10:04:00Z', verificationSource: 'META_API', stale: false, assetCount: 4 },
]);

const unknownDiagnostics: components['schemas']['AssetDiagnostics'] = {
  onboardingStatus: 'UNKNOWN', onboardingReadiness: 'UNKNOWN', onboardingNextAction: 'UNKNOWN',
  tokenHealth: 'UNKNOWN', tokenHealthObservedAt: null, metaState: 'UNKNOWN', metaObservedAt: null,
  subscriptionState: 'UNKNOWN', projectionState: 'UNKNOWN',
};

export const fourWhatsAppNumbers: ConnectionDetailFixture['assets'] = Object.freeze([
  '1111', '2222', '3333', '4444',
].map((suffix, index) => ({
  id: `00000000-0000-4000-8000-00000000001${index}`,
  kind: 'PHONE_NUMBER' as const,
  displayLabel: `Atendimento ••••${suffix}`,
  status: 'ACTIVE' as const,
  authorizationStatus: 'VERIFIED' as const,
  observedAt: '2026-11-10T10:05:00Z',
  lastVerifiedAt: '2026-11-10T10:05:00Z',
  verificationSource: 'META_API' as const,
  stale: false,
  diagnostics: unknownDiagnostics,
  capabilities: { canSend: false, canManageTemplates: false, canSubscribe: false, canReauthorize: false, canDisconnect: false },
})));

export const coexistenceDetailFixture: ConnectionDetailFixture = {
  id: connectionFixtures[4]!.id,
  flowVariant: 'WHATSAPP_COEXISTENCE',
  status: 'PARTIAL',
  readiness: 'PARTIAL',
  observedAt: '2026-11-10T10:05:00Z',
  lastVerifiedAt: '2026-11-10T10:05:00Z',
  verificationSource: 'META_API',
  stale: false,
  assetCount: 4,
  diagnostics: unknownDiagnostics,
  assets: fourWhatsAppNumbers,
  requestId: 'req-synthetic-connection-01',
};

export const staleRevokedPageFixture: ConnectionDetailFixture = {
  id: '00000000-0000-4000-8000-000000000011',
  flowVariant: 'FACEBOOK_LOGIN',
  status: 'UNKNOWN',
  readiness: 'UNKNOWN',
  observedAt: '2026-10-01T08:00:00Z',
  lastVerifiedAt: '2026-10-01T08:00:00Z',
  verificationSource: 'SIGNED_WEBHOOK',
  stale: true,
  assetCount: 1,
  diagnostics: unknownDiagnostics,
  assets: [{
    id: '00000000-0000-4000-8000-000000000012', kind: 'PAGE', displayLabel: 'Página de atendimento',
    status: 'STALE', authorizationStatus: 'REVOKED', observedAt: '2026-10-01T08:00:00Z',
    lastVerifiedAt: '2026-10-01T08:00:00Z', verificationSource: 'SIGNED_WEBHOOK', stale: true,
    diagnostics: { ...unknownDiagnostics, subscriptionState: 'UNKNOWN', projectionState: 'STALE' },
    capabilities: { canSend: false, canManageTemplates: false, canSubscribe: false, canReauthorize: true, canDisconnect: true },
  }],
  requestId: 'req-synthetic-connection-02',
};
