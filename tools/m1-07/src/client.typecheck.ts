import type { components, paths } from './generated/openapi.js';
import { createMetaApiClient } from './client.js';

type Expect<T extends true> = T;
type PublicReadDtoSecretKey = Extract<
  keyof components['schemas']['SessionContext'] | keyof components['schemas']['Connection'] | keyof components['schemas']['Asset'] | keyof components['schemas']['Notification'],
  'accessToken' | 'refreshToken' | 'token' | 'secret' | 'ciphertext' | 'authorizationCode' | 'sessionCookie'
>;
type ReadDtosHaveNoSecretFields = Expect<PublicReadDtoSecretKey extends never ? true : false>;
type InternalRouteIsNotPublic = Expect<'/internal/v1/assets/{assetId}/operations' extends keyof paths ? false : true>;

const checkTypeConstraints: [ReadDtosHaveNoSecretFields, InternalRouteIsNotPublic] = [true, true];
void checkTypeConstraints;

const api = createMetaApiClient('https://api.example.invalid');
const createOnboarding = api.POST('/api/v1/onboarding-sessions', {
  params: {
    header: {
      Origin: 'https://portal.example.invalid',
      'Sec-Fetch-Site': 'same-origin',
      'X-CSRF-Token': 'synthetic-csrf-token-value',
      'X-Tenant-Context': 'synthetic-context-reference',
      'Idempotency-Key': 'idem_example_01',
    },
  },
  body: {
    flowVariant: 'WHATSAPP_COEXISTENCE',
    requestedCapabilities: ['READ_STATUS'],
    returnRoute: 'connections',
  },
});
void createOnboarding;

const listTemplates = api.GET('/api/v1/whatsapp/accounts/{assetId}/templates', {
  params: {
    path: { assetId: 'asset_example_01' },
    header: { 'X-Tenant-Context': 'synthetic-context-reference' },
  },
});
void listTemplates;

// @ts-expect-error Tenant authority is derived from the session; no tenant/company_uuid body field exists.
api.POST('/api/v1/onboarding-sessions', { body: { flowVariant: 'WHATSAPP_COEXISTENCE', requestedCapabilities: [], returnRoute: 'connections', company_uuid: 'forbidden' } });

// @ts-expect-error Internal service operations are intentionally absent from the public generated client.
api.POST('/internal/v1/assets/{assetId}/operations', { params: { path: { assetId: 'asset_example_01' } }, body: { kind: 'MARK_READ' } });

type OperationIds = components['schemas']['JobStatus']['operation'];
const typedJobOperation: OperationIds = 'SEND_REPLY';
void typedJobOperation;

async function assertTypedSuccessAndError() {
  const result = await createOnboarding;
  if (result.data) {
    const id: string = result.data.id;
    const status: 'AWAITING_PROVIDER' = result.data.status;
    void id;
    void status;
  }
  if (result.error) {
    const code: components['schemas']['ErrorEnvelope']['code'] = result.error.code;
    const action: components['schemas']['ErrorAction'] = result.error.action;
    void code;
    void action;
  }
}
void assertTypedSuccessAndError;
