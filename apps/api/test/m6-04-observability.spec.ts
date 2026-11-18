import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { isMetricsAuthorizationValid, MetricsController } from '../src/observability/metrics.controller.js';
import { ObservabilityRegistry, classifyHttpRoute } from '../src/observability/observability.registry.js';
import { redactStructuredLogRecord } from '../src/privacy/redaction.js';
import { requestContextMiddleware, type StructuredLogger, type StructuredLogRecord } from '../src/common/http/request-context.js';
import { MetaWebhookController } from '../src/meta-webhooks/meta-webhook.controller.js';

test('M6.04 bounds metric labels, correlates safe failures, and keeps the scrape endpoint closed by default', () => {
  const emitted: Readonly<Record<string, unknown>>[] = [];
  const logger: StructuredLogger = { write: (record: StructuredLogRecord) => {
    emitted.push(redactStructuredLogRecord({ ...record }));
  } };
  const registry = new ObservabilityRegistry('test', 3_600, logger, () => 1_800_000_000_000);
  const request = registry.recordHttpRequest({
    path: '/api/v1/onboarding/sessions/tenant-specific-id', method: 'POST', statusCode: 503, durationMs: 280,
  });
  assert.deepEqual(request, { routeGroup: 'onboarding', method: 'POST', outcome: 'dependency_failure' });
  assert.equal(classifyHttpRoute('/webhooks/meta/app-config-secret'), 'webhook');
  assert.equal(classifyHttpRoute('/api/v1/webhooks/meta/app-config-secret'), 'webhook');

  const correlationId = '57b0f4cb-b6fa-45c4-b3cc-bebf1929b661';
  registry.record({ operation: 'ASSET_DISCOVERY', product: 'FACEBOOK', environment: 'test', outcome: 'FAILED',
    category: 'NETWORK_ERROR', attempts: 1, retries: 0 }, { correlationId });
  registry.recordWebhookRequest('accepted', 175, { received: 3, inserted: 2, duplicate: 1, quarantined: 0 });
  registry.recordWebhookRequest('signature_rejected', 11);

  const maliciousLabels = {
    operation: 'ASSET_DISCOVERY', product: 'tenant-7-provider-object-101', environment: 'test', outcome: 'FAILED',
    category: 'NETWORK_ERROR', attempts: 1, retries: 0,
  } as unknown as Parameters<ObservabilityRegistry['record']>[0];
  registry.record(maliciousLabels, { correlationId });

  const exposition = registry.renderPrometheus();
  assert.match(exposition, /ca_meta_api_http_requests_total\{environment="test",route_group="onboarding",method="POST",outcome="dependency_failure"\} 1/);
  assert.match(exposition, /ca_meta_graph_calls_total\{environment="test",product="FACEBOOK",operation="ASSET_DISCOVERY",outcome="FAILED",category="NETWORK_ERROR"\} 1/);
  assert.match(exposition, /ca_meta_webhook_ingress_items_total\{environment="test",item_type="duplicate"\} 1/);
  assert.match(exposition, /ca_meta_webhook_last_ack_timestamp_seconds\{environment="test"\} 1800000000/);
  assert.match(exposition, /ca_meta_webhook_expected_activity_interval_seconds\{environment="test"\} 3600/);
  assert.doesNotMatch(exposition, /tenant-7-provider-object|correlationId|57b0f4cb/);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    level: 'warn', event: 'meta.graph.operation', correlationId,
    operation: 'ASSET_DISCOVERY', product: 'FACEBOOK', environment: 'test', outcome: 'FAILED', category: 'NETWORK_ERROR',
  });

  const protectedRecord = redactStructuredLogRecord({ event: 'meta.graph.operation', correlationId,
    product: 'FACEBOOK', outcome: 'FAILED', accessToken: 'synthetic-secret', payload: { message: 'private' },
    phone: '+1 555 555 0199', internalAssetId: '2c0e36f8-91f8-4f1e-bcde-a3a80db86f12' });
  assert.deepEqual(protectedRecord, { event: 'meta.graph.operation', correlationId, product: 'FACEBOOK', outcome: 'FAILED' });

  const configured = 'm6-04-test-metrics-token-with-32-plus-characters';
  assert.equal(isMetricsAuthorizationValid(undefined, configured), false);
  assert.equal(isMetricsAuthorizationValid(`Bearer ${configured}`, undefined), false);
  assert.equal(isMetricsAuthorizationValid(`Bearer ${configured}`, configured), true);
  assert.equal(isMetricsAuthorizationValid(`Bearer ${configured}x`, configured), false);
  assert.equal(isMetricsAuthorizationValid(`Bearer ${configured}`, 'short'), false);

  const response = {
    status() { return this; },
    type() { return this; },
    send() { return this; },
  } as unknown as import('express').Response;
  const closedController = new MetricsController(registry, undefined);
  assert.throws(() => closedController.scrape(`Bearer ${configured}`, response),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 404);
});

test('webhook latency starts before parsing and records the completed HTTP response', async () => {
  let emitted = 0;
  const logger: StructuredLogger = { write: () => { emitted += 1; } };
  const registry = new ObservabilityRegistry('test', 0, logger, () => 1_800_000_000_000);
  let now = 100;
  const clock = { now: () => now };
  const request = {
    method: 'POST',
    path: '/webhooks/meta/synthetic-config',
    route: { path: ':appConfigRef' },
    body: Buffer.from('{}'),
    is: (contentType: string) => contentType === 'application/json',
    get: (name: string) => name === 'x-hub-signature-256' ? 'sha256=synthetic' : undefined,
  };
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(_body: unknown) { return this; },
    setHeader() { return this; },
  });
  requestContextMiddleware(logger, clock, registry)(request as never, response as never, () => undefined);

  // Simulate time spent after the first middleware and before the controller sees the parsed body.
  now = 240;
  const ingress = { ingest: async () => ({ received: 1, inserted: 1, duplicate: 0, quarantined: 0 }) };
  const controller = new MetaWebhookController(ingress as never, registry);
  await controller.receive('synthetic-config', request as never, response as never);
  assert.doesNotMatch(registry.renderPrometheus(), /ca_meta_webhook_ingress_requests_total\{/);

  now = 360;
  response.emit('finish');
  const exposition = registry.renderPrometheus();
  assert.match(exposition, /ca_meta_webhook_ingress_duration_ms_sum\{environment="test",outcome="accepted"\} 260/);
  assert.match(exposition, /ca_meta_webhook_ingress_duration_ms_count\{environment="test",outcome="accepted"\} 1/);
  assert.match(exposition, /ca_meta_webhook_ingress_items_total\{environment="test",item_type="received"\} 1/);
  assert.equal(emitted, 1);
});

test('expected webhook activity alert aggregates replica-local ACKs by environment', async () => {
  const cwd = process.cwd();
  const repositoryRoot = /[\\/]apps[\\/]api$/i.test(cwd) ? resolve(cwd, '../..') : cwd;
  const rules = await readFile(resolve(repositoryRoot, 'tools/m6-04/alerts/prometheus-rules.yml'), 'utf8');
  const expectedActivityRule = rules.split('alert: CaMetaWebhookExpectedActivityMissing')[1] ?? '';
  assert.match(expectedActivityRule, /max by \(environment\) \(ca_meta_webhook_last_ack_timestamp_seconds\)/);
  assert.match(expectedActivityRule, /min by \(environment\) \(ca_meta_api_process_start_timestamp_seconds\)/);
  assert.match(expectedActivityRule, /max by \(environment\) \(ca_meta_webhook_expected_activity_interval_seconds\)/);
});
