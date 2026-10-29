export type { components, operations, paths } from './generated/openapi.js';
import type { components } from './generated/openapi.js';

export type ErrorEnvelope = components['schemas']['ErrorEnvelope'];
export type ErrorCode = ErrorEnvelope['code'];
export type ErrorAction = components['schemas']['ErrorAction'];
export type HealthStatus = components['schemas']['HealthStatus'];
