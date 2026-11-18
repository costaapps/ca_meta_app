import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SafeExceptionFilter } from '../src/common/http/safe-exception.filter.js';
import { OnboardingCoexistenceActiveSessionConflictError } from '../src/onboarding/onboarding-session.types.js';
import type { StructuredLogger } from '../src/common/http/request-context.js';

test('M5.03 maps a distinct-key Coexistence conflict to its stable non-retryable 409 envelope', () => {
  const captured: { status: number; body: unknown } = { status: 0, body: undefined };
  const logger: StructuredLogger = { write() {} };
  const filter = new SafeExceptionFilter(logger);
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ requestId: 'req-m5-03-conflict-123456' }),
      getResponse: () => ({
        status: (status: number) => ({
          json: (body: unknown) => { captured.status = status; captured.body = body; },
        }),
      }),
    }),
  };

  filter.catch(new OnboardingCoexistenceActiveSessionConflictError(), host as never);

  assert.equal(captured.status, 409);
  assert.deepEqual(captured.body, {
    code: 'COEXISTENCE_SESSION_ACTIVE',
    safeMessage: 'A WhatsApp Coexistence onboarding session is already active for this company.',
    requestId: 'req-m5-03-conflict-123456',
    retryable: false,
    action: 'CHECK_STATUS',
  });
});
