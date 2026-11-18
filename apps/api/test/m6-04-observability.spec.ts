import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { isMetricsAuthorizationValid, MetricsController } from '../src/observability/metrics.controller.js';
import { ObservabilityRegistry, classifyHttpRoute } from '../src/observability/observability.registry.js';
import { redactStructuredLogRecord } from '../src/privacy/redaction.js';
import type { StructuredLogger, StructuredLogRecord } from '../src/common/http/request-context.js';

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
  assert.match(exposition, /ca_meta_webhook_ingress_items_total\{environment="test",outcome="duplicate"\} 1/);
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
