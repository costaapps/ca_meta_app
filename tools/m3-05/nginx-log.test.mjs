import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const nginxConfig = readFileSync(new URL('../../infra/docker/nginx.conf', import.meta.url), 'utf8');

test('Nginx access logging is path-only and OAuth callback error logs cannot expose query-bearing request lines', () => {
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

  const oauthLocations = [
    ['browser OAuth return route', /^\s*location\s+=\s+\/oauth\/return\s+\{([\s\S]*?)^\s*\}/m],
    ['legacy product callback routes', /^\s*location\s+~\s+\^\/setup\/\(\?:callback\|\(\?:whatsapp\|facebook\|instagram\)\/callback\)\$\s+\{([\s\S]*?)^\s*\}/m],
    ['SPA fallback reached by internal redirect', /^\s*location\s+=\s+\/index\.html\s+\{([\s\S]*?)^\s*\}/m],
    ['provider API callback route', /^\s*location\s+~\s+\^\/api\/v1\/meta\/\[\^\/\]\+\/callback\$\s+\{([\s\S]*?)^\s*\}/m],
  ];
  for (const [label, locationPattern] of oauthLocations) {
    const location = nginxConfig.match(locationPattern)?.[1];
    assert.ok(location, `the ${label} has an explicit location`);
    assert.match(location, /^\s*error_log\s+\/dev\/null\s+emerg;\s*$/m,
      `request-level errors for the ${label} are discarded instead of logging the original request line`);
    assert.doesNotMatch(location, /^\s*error_log\s+\/dev\/(?:stdout|stderr)/m);
  }
});
