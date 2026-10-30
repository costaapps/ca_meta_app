const assert = require('node:assert/strict');
const test = require('node:test');
const { validateErrorEnvelope, validateHealthStatus } = require('../src/runtime.cjs');

const base = {
  code: 'INTERNAL_ERROR',
  safeMessage: 'The service could not complete this request.',
  requestId: '6bd67c2c-95d5-45de-a350-ded2baf7bf3c',
  retryable: false,
  action: 'CONTACT_ADMIN',
};

test('runtime validator accepts canonical error and health responses', () => {
  assert.equal(validateErrorEnvelope(base), true);
  assert.equal(validateHealthStatus({ status: 'ok' }), true);
});

test('runtime validator rejects unknown codes, extra data, and unsafe retry policy', () => {
  assert.equal(validateErrorEnvelope({ ...base, code: 'FUTURE_ERROR' }), false);
  assert.equal(validateErrorEnvelope({ ...base, code: 'INTERNAL_SCOPE_DENIED' }), false);
  assert.equal(validateErrorEnvelope({ ...base, retryable: true }), false);
  assert.equal(validateErrorEnvelope({ ...base, diagnostics: 'should not cross the boundary' }), false);
  assert.equal(validateHealthStatus({ status: 'not-ok' }), false);
});
