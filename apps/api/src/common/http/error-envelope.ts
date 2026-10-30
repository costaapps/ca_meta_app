import type { ErrorAction, ErrorCode, ErrorEnvelope } from '@ca-meta/contracts';
import { validateErrorEnvelope } from '@ca-meta/contracts/runtime';
export type { ErrorAction, ErrorCode, ErrorEnvelope } from '@ca-meta/contracts';

export function errorEnvelope(
  code: ErrorCode,
  safeMessage: string,
  requestId: string,
  retryable: boolean,
  action: ErrorAction,
): ErrorEnvelope {
  const envelope: ErrorEnvelope = { code, safeMessage, requestId, retryable, action };
  if (!validateErrorEnvelope(envelope)) {
    throw new Error('Server generated an ErrorEnvelope that does not match the public contract.');
  }
  return envelope;
}
