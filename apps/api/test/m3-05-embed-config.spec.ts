import assert from 'node:assert/strict';
import test from 'node:test';
import { EnvironmentValidationError, validateEnvironment } from '../src/config/environment.js';

const baseEnvironment = {
  NODE_ENV: 'test',
  API_PORT: '0',
  API_BIND_ADDRESS: '127.0.0.1',
  API_ALLOWED_HOSTS: '127.0.0.1,localhost',
  API_ALLOWED_ORIGINS: 'http://127.0.0.1,http://localhost',
  API_TRUSTED_PROXIES: 'none',
  API_DATABASE_HOST: '127.0.0.1',
  API_DATABASE_PORT: '3306',
  API_DATABASE_NAME: 'synthetic_test',
  API_DATABASE_USER: 'synthetic_user',
  API_DATABASE_PASSWORD: 'synthetic-marker-value',
  API_DATABASE_CONNECT_TIMEOUT_MS: '250',
  API_PORTAL_SESSION_RECOVERY_KEY: 'synthetic-test-session-recovery-key-32-bytes-minimum',
} satisfies NodeJS.ProcessEnv;

test('Suite4 embed origin configuration fails closed and accepts only unique exact HTTPS origins', () => {
  assert.deepEqual(validateEnvironment(baseEnvironment).suite4EmbedOrigins, []);
  assert.deepEqual(validateEnvironment({
    ...baseEnvironment,
    API_SUITE4_EMBED_ORIGINS: 'https://suite4.synthetic.invalid,https://suite4-staging.synthetic.invalid:8443',
  }).suite4EmbedOrigins, [
    'https://suite4.synthetic.invalid',
    'https://suite4-staging.synthetic.invalid:8443',
  ]);

  for (const invalidOrigin of [
    'https://*.example.test',
    'http://suite4.example.test',
    'https://suite4.example.test/path',
    'https://suite4.example.test,https://suite4.example.test',
    'https://user:password@suite4.example.test',
    'https://suite4.example.test,',
  ]) {
    assert.throws(
      () => validateEnvironment({ ...baseEnvironment, API_SUITE4_EMBED_ORIGINS: invalidOrigin }),
      (error: unknown) => error instanceof EnvironmentValidationError &&
        error.fieldNames.includes('API_SUITE4_EMBED_ORIGINS'),
      invalidOrigin,
    );
  }
});
