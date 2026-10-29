import type { components, paths } from '../src/index.js';

type Expect<T extends true> = T;
type PublicPath = Expect<'/health' extends keyof paths ? true : false>;
type InternalRouteExcluded = Expect<'/internal/v1/assets/{assetId}/operations' extends keyof paths ? false : true>;
type ErrorCodes = components['schemas']['ErrorEnvelope']['code'];
const internalError: ErrorCodes = 'INTERNAL_ERROR';
const hostError: ErrorCodes = 'HOST_NOT_ALLOWED';
type HealthResponse = paths['/health']['get']['responses']['200']['content']['application/json'];
const healthResponse: HealthResponse = { status: 'ok' };
const typedErrorCodes: [ErrorCodes, ErrorCodes] = [internalError, hostError];
void healthResponse;
void typedErrorCodes;

// @ts-expect-error Tenant authority is not an accepted public error/health DTO field.
const forbiddenTenantField: components['schemas']['HealthStatus'] = { status: 'ok', company_uuid: 'synthetic' };
void forbiddenTenantField;
