import type { ErrorEnvelope, HealthStatus } from './index.js';

export function validateErrorEnvelope(value: unknown): value is ErrorEnvelope;
export function validateHealthStatus(value: unknown): value is HealthStatus;
export function isErrorCode(value: unknown): value is ErrorEnvelope['code'];
export function isErrorAction(value: unknown): value is ErrorEnvelope['action'];
