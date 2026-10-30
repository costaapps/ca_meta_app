const { readFileSync } = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020.js').default;
const addFormats = require('ajv-formats').default;
const schemas = JSON.parse(readFileSync(path.join(__dirname, 'generated/runtime-schemas.json'), 'utf8'));

function rewriteRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    typeof child === 'string' && child.startsWith('#/components/schemas/')
      ? child.replace('#/components/schemas/', '#/$defs/')
      : rewriteRefs(child),
  ]));
}

const schemaBundle = { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: rewriteRefs(schemas) };
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addKeyword({
  keyword: 'x-error-policy-by-code',
  schemaType: 'object',
  type: 'object',
  errors: false,
  validate(policyByCode, value) {
    if (!value || typeof value.code !== 'string') return true;
    const policy = policyByCode[value.code];
    return !policy || (
      value.retryable === policy.retryable &&
      value.action === policy.action
    );
  },
});
const errorValidator = ajv.compile({ $ref: '#/$defs/ErrorEnvelope', ...schemaBundle });
const healthValidator = ajv.compile({ $ref: '#/$defs/HealthStatus', ...schemaBundle });

function validateErrorEnvelope(value) {
  return errorValidator(value) === true;
}

function validateHealthStatus(value) {
  return healthValidator(value) === true;
}

function isErrorCode(value) {
  return typeof value === 'string' && schemas.ErrorEnvelope.properties.code.enum.includes(value);
}

function isErrorAction(value) {
  return typeof value === 'string' && schemas.ErrorAction.enum.includes(value);
}

module.exports = { validateErrorEnvelope, validateHealthStatus, isErrorCode, isErrorAction };
