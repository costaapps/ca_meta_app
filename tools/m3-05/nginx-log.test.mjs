import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const nginxConfig = readFileSync(new URL('../../infra/docker/nginx.conf', import.meta.url), 'utf8');

test('Nginx access logging is path-only and callback error logs cannot expose query-bearing request lines', () => {
  const format = nginxConfig.match(/^\s*log_format\s+m3_safe\s+'([^']*)';\s*$/m)?.[1];
  assert.equal(format, '$uri $status');

  const variables = [...format.matchAll(/\$[a-zA-Z_]+/g)].map(([value]) => value);
  assert.deepEqual(variables, ['$uri', '$status']);

  const accessLogDirectives = [...nginxConfig.matchAll(/^\s*access_log\s+([^;]+);\s*$/gm)]
    .map(([, directive]) => directive.trim());
  assert.ok(accessLogDirectives.includes('/dev/stdout m3_safe'));
  assert.ok(accessLogDirectives.every((directive) => directive === '/dev/stdout m3_safe' || directive === 'off'));
  assert.equal(accessLogDirectives.includes('/dev/stdout'), false);

  for (const unsafeVariable of ['$request', '$request_uri', '$args', '$arg_code', '$arg_state', '$http_referer', '$http_cookie']) {
    assert.equal(format.includes(unsafeVariable), false, `unsafe Nginx log variable ${unsafeVariable}`);
  }

  const callbackLocation = nginxConfig.match(
    /^\s*location\s+~\s+\^\/api\/v1\/meta\/\[\^\/\]\+\/callback\$\s+\{([\s\S]*?)^\s*\}/m,
  )?.[1];
  assert.ok(callbackLocation, 'the provider callback route has an explicit location');
  assert.match(callbackLocation, /^\s*error_log\s+\/dev\/null\s+emerg;\s*$/m,
    'request-level errors on the callback route are discarded instead of logging the original request line');
  assert.doesNotMatch(callbackLocation, /^\s*error_log\s+\/dev\/(?:stdout|stderr)/m);
});
