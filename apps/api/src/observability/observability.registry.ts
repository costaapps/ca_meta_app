import type { RuntimeEnvironment } from '../config/environment.js';
import type { StructuredLogger } from '../common/http/request-context.js';
import type { MetaGraphMetricLabels, MetaGraphMetrics } from '../meta-graph/meta-graph.types.js';

export const OBSERVABILITY_REGISTRY = Symbol('OBSERVABILITY_REGISTRY');
export const OBSERVABILITY_METRICS_TOKEN = Symbol('OBSERVABILITY_METRICS_TOKEN');

export type HttpRouteGroup = 'auth' | 'onboarding' | 'meta' | 'webhook' | 'jobs' | 'operations' |
  'assets' | 'health' | 'metrics' | 'internal' | 'other';
export type HttpOutcome = 'success' | 'redirect' | 'client_failure' | 'auth_failure' |
  'dependency_failure' | 'internal_failure' | 'rate_limited';
export type WebhookOutcome = 'accepted' | 'invalid_content_type' | 'signature_rejected' |
  'payload_rejected' | 'configuration_unavailable' | 'ingress_failure';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'OTHER'] as const;
const HTTP_OUTCOMES: readonly HttpOutcome[] = ['success', 'redirect', 'client_failure', 'auth_failure',
  'dependency_failure', 'internal_failure', 'rate_limited'];
const ROUTE_GROUPS: readonly HttpRouteGroup[] = ['auth', 'onboarding', 'meta', 'webhook', 'jobs', 'operations',
  'assets', 'health', 'metrics', 'internal', 'other'];
const PRODUCTS = ['FACEBOOK', 'INSTAGRAM', 'WHATSAPP_EXCLUSIVE', 'WHATSAPP_COEXISTENCE'] as const;
const ENVIRONMENTS: readonly RuntimeEnvironment[] = ['development', 'test', 'staging', 'production'];
const OPERATIONS = ['ASSET_DISCOVERY', 'SEND_MESSAGE', 'MANAGE_COMMENTS', 'MANAGE_TEMPLATES', 'READ_STATUS',
  'SUBSCRIBE_WEBHOOKS', 'SYNC_HISTORY', 'PHONE_REGISTRATION_CONVENTIONAL'] as const;
const META_CATEGORIES = ['CAPABILITY_DISABLED', 'CONFIGURATION_UNAVAILABLE', 'CREDENTIAL_UNAVAILABLE', 'CREDENTIAL_REJECTED',
  'PERMISSION_REQUIRED', 'REQUEST_BUDGET_EXHAUSTED', 'REQUEST_INVALID', 'RESPONSE_INVALID', 'NETWORK_ERROR', 'RATE_LIMITED',
  'TRANSIENT_PROVIDER_FAILURE', 'INVALID_REQUEST', 'AUTHORIZATION_FAILED', 'PROVIDER_ERROR', 'PROVIDER_UNAVAILABLE',
  'REDIRECT_REFUSED', 'RESPONSE_TOO_LARGE', 'PAGINATION_INVALID', 'PAGINATION_LOOP', 'LIMIT_REACHED', 'BUSY',
  'AMBIGUOUS_POST', 'NONE'] as const;
const HTTP_BUCKETS_MS = [25, 50, 100, 250, 500, 1_000, 3_000, 10_000] as const;
const WEBHOOK_BUCKETS_MS = [100, 250, 500, 1_000, 3_000, 10_000] as const;
const SOURCE_AVAILABILITY = Object.freeze({
  http_api: 1,
  meta_graph: 1,
  webhook_ingress: 1,
  expected_webhook_activity: 0,
  credential_health: 0,
  subscription_drift: 0,
  queue_backlog: 0,
  dead_letter: 0,
  projection_lag: 0,
});

interface HistogramSeries {
  count: number;
  sum: number;
  readonly buckets: Map<number | '+Inf', number>;
}

interface HistogramRow {
  readonly dimensions: Readonly<Record<string, string>>;
  readonly series: HistogramSeries;
}

function tupleKey(values: readonly (string | number)[]): string {
  return JSON.stringify(values);
}

function boundedNumber(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(86_400_000, value) : 0;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function labels(values: Readonly<Record<string, string>>): string {
  return `{${Object.entries(values).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function safeOutcome(statusCode: number): HttpOutcome {
  if (statusCode >= 200 && statusCode < 300) return 'success';
  if (statusCode >= 300 && statusCode < 400) return 'redirect';
  if (statusCode === 401 || statusCode === 403) return 'auth_failure';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) return 'dependency_failure';
  if (statusCode >= 500) return 'internal_failure';
  return 'client_failure';
}

export function classifyHttpRoute(path: string): HttpRouteGroup {
  const normalized = path.toLowerCase().split('?', 1)[0] ?? '';
  if (normalized === '/health' || normalized === '/ready' || normalized === '/api/v1/health' || normalized === '/api/v1/ready') return 'health';
  if (normalized === '/internal/metrics' || normalized === '/internal/metrics/') return 'metrics';
  if (normalized.startsWith('/webhooks/meta/') || normalized === '/webhooks/meta') return 'webhook';
  const withoutPrefix = normalized.replace(/^\/api\/v1(?=\/|$)/, '');
  if (withoutPrefix.startsWith('/webhooks/meta/') || withoutPrefix === '/webhooks/meta' ||
      withoutPrefix.startsWith('/webhooks/meta-lifecycle/')) return 'webhook';
  const root = withoutPrefix.split('/').filter(Boolean)[0] ?? '';
  if (['auth', 'magic-links', 'magic-link'].includes(root)) return 'auth';
  if (root.startsWith('onboarding')) return 'onboarding';
  if (root.startsWith('meta')) return 'meta';
  if (root === 'jobs') return 'jobs';
  if (root === 'operations' || root === 'diagnostics') return 'operations';
  if (root === 'assets' || root === 'channels') return 'assets';
  if (root === 'internal') return 'internal';
  return 'other';
}

export function normalizeHttpMethod(method: string): typeof HTTP_METHODS[number] {
  return (HTTP_METHODS as readonly string[]).includes(method) ? method as typeof HTTP_METHODS[number] : 'OTHER';
}

export class ObservabilityRegistry implements MetaGraphMetrics {
  private readonly counters = new Map<string, number>();
  private readonly httpHistograms = new Map<string, HistogramRow>();
  private readonly webhookHistograms = new Map<string, HistogramRow>();
  private lastWebhookAckSeconds = 0;
  private readonly processStartSeconds: number;
  private readonly expectedWebhookIntervalSeconds: number;

  constructor(
    private readonly environment: RuntimeEnvironment,
    expectedWebhookIntervalSeconds: number,
    private readonly logger: StructuredLogger,
    private readonly now: () => number = Date.now,
  ) {
    this.expectedWebhookIntervalSeconds = Number.isSafeInteger(expectedWebhookIntervalSeconds) && expectedWebhookIntervalSeconds > 0
      ? Math.min(expectedWebhookIntervalSeconds, 2_592_000) : 0;
    this.processStartSeconds = Math.floor(this.now() / 1_000);
  }

  recordHttpRequest(input: { readonly path: string; readonly method: string; readonly statusCode: number; readonly durationMs: number }): {
    readonly routeGroup: HttpRouteGroup; readonly method: typeof HTTP_METHODS[number]; readonly outcome: HttpOutcome;
  } {
    const routeGroup = classifyHttpRoute(input.path);
    const method = normalizeHttpMethod(input.method);
    const outcome = safeOutcome(input.statusCode);
    const key = tupleKey([this.environment, routeGroup, method, outcome]);
    this.increment('http', key);
    this.observeHistogram(this.httpHistograms, key, { route_group: routeGroup, method, outcome }, boundedNumber(input.durationMs), HTTP_BUCKETS_MS);
    return Object.freeze({ routeGroup, method, outcome });
  }

  record(labelsInput: MetaGraphMetricLabels, context?: { readonly correlationId: string }): void {
    if (!ENVIRONMENTS.includes(labelsInput.environment) || !PRODUCTS.includes(labelsInput.product) ||
        !(OPERATIONS as readonly string[]).includes(labelsInput.operation) || !(META_CATEGORIES as readonly string[]).includes(labelsInput.category) ||
        !['SUCCEEDED', 'PARTIAL', 'FAILED', 'UNKNOWN'].includes(labelsInput.outcome)) return;
    const key = tupleKey([labelsInput.environment, labelsInput.product, labelsInput.operation,
      labelsInput.outcome, labelsInput.category]);
    this.increment('meta_graph', key);
    const correlationId = context?.correlationId;
    if (typeof correlationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(correlationId)) return;
    this.logger.write({
      level: labelsInput.outcome === 'SUCCEEDED' ? 'info' : labelsInput.outcome === 'UNKNOWN' ? 'error' : 'warn',
      event: 'meta.graph.operation',
      correlationId,
      operation: labelsInput.operation,
      product: labelsInput.product,
      environment: labelsInput.environment,
      outcome: labelsInput.outcome,
      category: labelsInput.category,
    });
  }

  recordWebhookRequest(outcome: WebhookOutcome, durationMs: number, itemCounts?: {
    readonly received: number; readonly inserted: number; readonly duplicate: number; readonly quarantined: number;
  }): void {
    const accepted = outcome === 'accepted';
    const key = tupleKey([this.environment, outcome]);
    this.increment('webhook_request', key);
    this.observeHistogram(this.webhookHistograms, key, { outcome }, boundedNumber(durationMs), WEBHOOK_BUCKETS_MS);
    if (!accepted) return;
    this.lastWebhookAckSeconds = Math.floor(this.now() / 1_000);
    if (itemCounts) {
      for (const itemType of ['received', 'inserted', 'duplicate', 'quarantined'] as const) {
        const value = itemCounts[itemType];
        if (Number.isSafeInteger(value) && value > 0) this.increment('webhook_items', tupleKey([this.environment, itemType]), value);
      }
    }
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    lines.push('# HELP ca_meta_api_http_requests_total Completed API requests grouped by finite route and outcome classes.',
      '# TYPE ca_meta_api_http_requests_total counter');
    for (const [key, value] of sorted(this.counters, 'http')) {
      const [environment, routeGroup, method, outcome] = JSON.parse(key) as string[];
      lines.push(`ca_meta_api_http_requests_total${labels({ environment: environment!, route_group: routeGroup!, method: method!, outcome: outcome! })} ${value}`);
    }
    lines.push('# HELP ca_meta_api_http_request_duration_ms API request duration in milliseconds.',
      '# TYPE ca_meta_api_http_request_duration_ms histogram');
    for (const [key, row] of sortedHistogram(this.httpHistograms)) {
      const [environment] = JSON.parse(key) as string[];
      appendHistogram(lines, 'ca_meta_api_http_request_duration_ms', { environment: environment!, ...row.dimensions }, row.series, HTTP_BUCKETS_MS);
    }
    lines.push('# HELP ca_meta_graph_calls_total Meta Graph operation outcomes; correlation IDs are excluded from labels.',
      '# TYPE ca_meta_graph_calls_total counter');
    for (const [key, value] of sorted(this.counters, 'meta_graph')) {
      const [environment, product, operation, outcome, category] = JSON.parse(key) as string[];
      lines.push(`ca_meta_graph_calls_total${labels({ environment: environment!, product: product!, operation: operation!, outcome: outcome!, category: category! })} ${value}`);
    }
    lines.push('# HELP ca_meta_webhook_ingress_requests_total Webhook ingress outcomes after signature and payload checks.',
      '# TYPE ca_meta_webhook_ingress_requests_total counter');
    for (const [key, value] of sorted(this.counters, 'webhook_request')) {
      const [environment, outcome] = JSON.parse(key) as string[];
      lines.push(`ca_meta_webhook_ingress_requests_total${labels({ environment: environment!, outcome: outcome! })} ${value}`);
    }
    lines.push('# HELP ca_meta_webhook_ingress_items_total Durable webhook inbox item counts.',
      '# TYPE ca_meta_webhook_ingress_items_total counter');
    for (const [key, value] of sorted(this.counters, 'webhook_items')) {
      const [environment, itemType] = JSON.parse(key) as string[];
      lines.push(`ca_meta_webhook_ingress_items_total${labels({ environment: environment!, item_type: itemType! })} ${value}`);
    }
    lines.push('# HELP ca_meta_webhook_ingress_duration_ms Time from request-context middleware start through HTTP response finish.',
      '# TYPE ca_meta_webhook_ingress_duration_ms histogram');
    for (const [key, row] of sortedHistogram(this.webhookHistograms)) {
      const [environment] = JSON.parse(key) as string[];
      appendHistogram(lines, 'ca_meta_webhook_ingress_duration_ms', { environment: environment!, ...row.dimensions }, row.series, WEBHOOK_BUCKETS_MS);
    }
    lines.push('# HELP ca_meta_webhook_last_ack_timestamp_seconds Last successful durable webhook inbox acknowledgement in this process; zero means not observed since start.',
      '# TYPE ca_meta_webhook_last_ack_timestamp_seconds gauge',
      `ca_meta_webhook_last_ack_timestamp_seconds${labels({ environment: this.environment })} ${this.lastWebhookAckSeconds}`,
      '# HELP ca_meta_webhook_expected_activity_interval_seconds Expected webhook interval; zero disables inactivity alerts.',
      '# TYPE ca_meta_webhook_expected_activity_interval_seconds gauge',
      `ca_meta_webhook_expected_activity_interval_seconds${labels({ environment: this.environment })} ${this.expectedWebhookIntervalSeconds}`,
      '# HELP ca_meta_api_process_start_timestamp_seconds Process start timestamp used only to bound first-webhook silence checks.',
      '# TYPE ca_meta_api_process_start_timestamp_seconds gauge',
      `ca_meta_api_process_start_timestamp_seconds${labels({ environment: this.environment })} ${this.processStartSeconds}`,
      '# HELP ca_meta_observability_source_available Whether a safe aggregate runtime source is instrumented (1) or unavailable (0).',
      '# TYPE ca_meta_observability_source_available gauge');
    for (const [signal, available] of Object.entries(SOURCE_AVAILABILITY)) {
      const value = signal === 'expected_webhook_activity' ? Number(this.expectedWebhookIntervalSeconds > 0) : available;
      lines.push(`ca_meta_observability_source_available${labels({ environment: this.environment, signal })} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }

  private increment(namespace: string, key: string, amount = 1): void {
    this.counters.set(`${namespace}:${key}`, (this.counters.get(`${namespace}:${key}`) ?? 0) + amount);
  }

  private observeHistogram(
    registry: Map<string, HistogramRow>, key: string, dimensions: Readonly<Record<string, string>>,
    value: number, boundaries: readonly number[],
  ): void {
    let row = registry.get(key);
    if (!row) {
      const buckets = new Map<number | '+Inf', number>([...boundaries.map((boundary) => [boundary, 0] as const), ['+Inf', 0]]);
      row = { dimensions, series: { count: 0, sum: 0, buckets } };
      registry.set(key, row);
    }
    row.series.count += 1;
    row.series.sum += value;
    const firstMatchingBoundary = boundaries.find((boundary) => value <= boundary);
    if (firstMatchingBoundary !== undefined) {
      row.series.buckets.set(firstMatchingBoundary, (row.series.buckets.get(firstMatchingBoundary) ?? 0) + 1);
    }
    row.series.buckets.set('+Inf', row.series.count);
  }
}

function sorted(registry: Map<string, number>, namespace: string): Array<[string, number]> {
  return [...registry.entries()].filter(([key]) => key.startsWith(`${namespace}:`))
    .map(([key, value]) => [key.slice(namespace.length + 1), value] as [string, number]).sort(([left], [right]) => left.localeCompare(right));
}

function sortedHistogram(registry: Map<string, HistogramRow>): Array<[string, HistogramRow]> {
  return [...registry.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function appendHistogram(
  lines: string[], name: string, dimensions: Readonly<Record<string, string>>, series: HistogramSeries, boundaries: readonly number[],
): void {
  let cumulative = 0;
  for (const boundary of boundaries) {
    cumulative += series.buckets.get(boundary) ?? 0;
    lines.push(`${name}_bucket${labels({ ...dimensions, le: String(boundary) })} ${cumulative}`);
  }
  lines.push(`${name}_bucket${labels({ ...dimensions, le: '+Inf' })} ${series.count}`,
    `${name}_sum${labels(dimensions)} ${series.sum}`, `${name}_count${labels(dimensions)} ${series.count}`);
}
