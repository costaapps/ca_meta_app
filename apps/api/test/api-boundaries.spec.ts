import 'reflect-metadata';
import { Body, Controller, Get, Inject, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString, MaxLength } from 'class-validator';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ApiModule } from '../src/app.module.js';
import { DATABASE_READINESS_PORT, type DatabaseReadinessPort } from '../src/database/database-readiness.port.js';
import type { ApiEnvironment } from '../src/config/environment.js';
import { STRUCTURED_LOGGER, type StructuredLogRecord, type StructuredLogger } from '../src/common/http/request-context.js';
import { PublicRoute } from '../src/common/security/public-route.decorator.js';
import { configureHttpBoundaries } from '../src/http-boundaries.js';
import { CLOCK, type MonotonicClock } from '../src/common/time/clock.port.js';

const PROBE_STATE = Symbol('PROBE_STATE');

interface ProbeState {
  signalStarted(): void;
  readonly started: Promise<void>;
  waitForRelease(): Promise<void>;
  release(): void;
}

class ProbeStateValue implements ProbeState {
  private resolveStarted!: () => void;
  private resolveRelease!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.resolveRelease = resolve;
  });

  signalStarted(): void {
    this.resolveStarted();
  }

  async waitForRelease(): Promise<void> {
    await this.released;
  }

  release(): void {
    this.resolveRelease();
  }
}

class FakeMonotonicClock implements MonotonicClock {
  private tick = 0;

  now(): number {
    this.tick += 7;
    return this.tick;
  }
}

class ProbeDto {
  @IsString()
  @MaxLength(16)
  value!: string;
}

class CapturingLogger implements StructuredLogger {
  readonly records: StructuredLogRecord[] = [];

  write(record: StructuredLogRecord): void {
    this.records.push(record);
  }
}

class FakeDatabaseReadiness implements DatabaseReadinessPort {
  available = false;
  checks = 0;

  async check(): Promise<void> {
    this.checks += 1;
    if (!this.available) throw new Error('synthetic database diagnostic secret');
  }
}

@Controller('probe')
class BoundaryProbeController {
  constructor(@Inject(PROBE_STATE) private readonly state: ProbeState) {}

  @Post('validation')
  @PublicRoute()
  validate(@Body() body: ProbeDto): { readonly accepted: true; readonly value: string } {
    return { accepted: true, value: body.value };
  }

  @Get('failure')
  @PublicRoute()
  fail(): never {
    throw new Error('synthetic-marker-password-should-never-leak');
  }

  @Get('in-flight')
  @PublicRoute()
  async inFlight(): Promise<{ readonly completed: true }> {
    this.state.signalStarted();
    await this.state.waitForRelease();
    return { completed: true };
  }

  @Get('private')
  privateRoute(): { readonly reachable: true } {
    return { reachable: true };
  }
}

const TEST_ENVIRONMENT: ApiEnvironment = {
  nodeEnv: 'test',
  port: 0,
  bindAddress: '127.0.0.1',
  trustedProxyCidrs: false,
  database: {
    host: '127.0.0.1',
    port: 3306,
    name: 'synthetic_test',
    user: 'synthetic_test',
    password: 'synthetic-test-password',
    connectTimeoutMs: 250,
  },
};

async function startBoundaryApp(): Promise<{
  readonly baseUrl: string;
  readonly app: INestApplication;
  readonly database: FakeDatabaseReadiness;
  readonly logger: CapturingLogger;
  readonly state: ProbeStateValue;
  readonly clock: FakeMonotonicClock;
}> {
  const database = new FakeDatabaseReadiness();
  const logger = new CapturingLogger();
  const state = new ProbeStateValue();
  const clock = new FakeMonotonicClock();
  const module = await Test.createTestingModule({
    imports: [ApiModule.register(TEST_ENVIRONMENT)],
    controllers: [BoundaryProbeController],
    providers: [{ provide: PROBE_STATE, useValue: state }],
  })
    .overrideProvider(DATABASE_READINESS_PORT)
    .useValue(database)
    .overrideProvider(STRUCTURED_LOGGER)
    .useValue(logger)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();

  const app = module.createNestApplication({ bodyParser: false });
  configureHttpBoundaries(app, TEST_ENVIRONMENT);
  await app.init();
  await app.listen(0, TEST_ENVIRONMENT.bindAddress);
  const address = app.getHttpServer().address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, app, database, logger, state, clock };
}

test('configuration validation requires typed fields, reports names only, and rejects remote test DBs', async (t) => {
  const { EnvironmentValidationError, validateEnvironment } = await import('../src/config/environment.js');
  const valid = {
    NODE_ENV: 'test',
    API_PORT: '0',
    API_BIND_ADDRESS: '127.0.0.1',
    API_TRUSTED_PROXIES: 'none',
    API_DATABASE_HOST: '127.0.0.1',
    API_DATABASE_PORT: '3306',
    API_DATABASE_NAME: 'synthetic_test',
    API_DATABASE_USER: 'synthetic_user',
    API_DATABASE_PASSWORD: 'synthetic-marker-value',
    API_DATABASE_CONNECT_TIMEOUT_MS: '250',
  };

  await t.test('accepts a complete explicit configuration', () => {
    const parsed = validateEnvironment(valid);
    assert.equal(parsed.port, 0);
    assert.equal(parsed.database.host, '127.0.0.1');
    assert.equal(parsed.trustedProxyCidrs, false);
    assert.equal(parsed.database.password, 'synthetic-marker-value');
  });

  await t.test('reports absent and malformed field names without values', () => {
    const invalid = { ...valid, API_PORT: 'bad-port', API_DATABASE_PASSWORD: 'synthetic-marker-value' };
    delete (invalid as Partial<typeof invalid>).API_DATABASE_USER;
    assert.throws(
      () => validateEnvironment(invalid),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentValidationError);
        assert.ok(error.fieldNames.includes('API_PORT'));
        assert.ok(error.fieldNames.includes('API_DATABASE_USER'));
        assert.ok(!error.message.includes('synthetic-marker-value'));
        return true;
      },
    );
  });

  await t.test('requires a loopback DB and valid explicit proxy ranges in test', () => {
    assert.throws(() => validateEnvironment({ ...valid, API_DATABASE_HOST: 'db.prod.example' }));
    assert.throws(() => validateEnvironment({ ...valid, API_TRUSTED_PROXIES: '0.0.0.0/99' }));
  });
});

test('health paths follow the canonical contract and liveness is independent of MariaDB', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const liveness = await fetch(`${context.baseUrl}/health`);
  assert.equal(liveness.status, 200);
  assert.deepEqual(await liveness.json(), { status: 'ok' });
  assert.match(liveness.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/i);
  assert.equal(context.database.checks, 0);

  const legacyLiveAlias = await fetch(`${context.baseUrl}/health/live`);
  const legacyReadyAlias = await fetch(`${context.baseUrl}/health/ready`);
  assert.equal(legacyLiveAlias.status, 404);
  assert.equal(legacyReadyAlias.status, 404);
});

test('the private route is denied and request IDs are returned in headers and error envelopes', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const response = await fetch(`${context.baseUrl}/api/v1/probe/private`, {
    headers: { 'X-Request-Id': 'malformed-request-id' },
  });
  assert.equal(response.status, 401);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, 'AUTH_REQUIRED');
  assert.equal(body.requestId, response.headers.get('x-request-id'));
  assert.match(String(body.requestId), /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  assert.deepEqual(Object.keys(body).sort(), ['action', 'code', 'requestId', 'retryable', 'safeMessage']);
  const requestLog = context.logger.records.find((record) => record.event === 'http.request');
  assert.equal(requestLog?.requestId, response.headers.get('x-request-id'));
  assert.equal(requestLog?.durationMs, 7);
});

test('strict DTO validation rejects extra fields, malformed JSON, and oversized bodies safely', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const valid = await fetch(`${context.baseUrl}/api/v1/probe/validation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'okay' }),
  });
  assert.equal(valid.status, 201);
  assert.deepEqual(await valid.json(), { accepted: true, value: 'okay' });
  assert.ok(valid.headers.get('x-request-id'));

  const extra = await fetch(`${context.baseUrl}/api/v1/probe/validation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'okay', unexpected: 'private-field' }),
  });
  assert.equal(extra.status, 400);
  const extraBody = await extra.text();
  assert.match(extraBody, /VALIDATION_FAILED/);
  assert.doesNotMatch(extraBody, /private-field|unexpected/);

  const malformed = await fetch(`${context.baseUrl}/api/v1/probe/validation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'also-not-valid' },
    body: '{"value":',
  });
  assert.equal(malformed.status, 400);
  assert.match(await malformed.text(), /VALIDATION_FAILED/);
  assert.match(malformed.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/i);

  const oversized = await fetch(`${context.baseUrl}/api/v1/probe/validation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(70_000) }),
  });
  assert.equal(oversized.status, 413);
  assert.match(await oversized.text(), /PAYLOAD_TOO_LARGE/);
});

test('internal errors are sanitized and logs correlate without raw errors or request payloads', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const response = await fetch(`${context.baseUrl}/api/v1/probe/failure`);
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /DEPENDENCY_UNAVAILABLE/);
  assert.doesNotMatch(body, /synthetic-marker-password|synthetic database diagnostic/);
  assert.equal(JSON.parse(body).requestId, response.headers.get('x-request-id'));

  await new Promise((resolve) => setTimeout(resolve, 0));
  const serializedLogs = JSON.stringify(context.logger.records);
  assert.doesNotMatch(serializedLogs, /synthetic-marker-password|synthetic database diagnostic/);
  assert.ok(context.logger.records.some((record) => record.requestId === response.headers.get('x-request-id')));
});

test('readiness reports only status while MariaDB is down and recovers when it is up', async (t) => {
  const context = await startBoundaryApp();
  t.after(() => context.app.close());

  const down = await fetch(`${context.baseUrl}/ready`);
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { status: 'unavailable' });
  assert.equal(context.database.checks, 1);

  context.database.available = true;
  const up = await fetch(`${context.baseUrl}/ready`);
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { status: 'ok' });
  assert.equal(context.database.checks, 2);
  assert.doesNotMatch(JSON.stringify(context.logger.records), /synthetic database diagnostic/);
});

test('graceful close drains an in-flight request and stops accepting new requests', async (t) => {
  const context = await startBoundaryApp();
  let closing: Promise<void> | undefined;
  t.after(async () => {
    if (closing) await closing;
    else await context.app.close();
  });

  const inFlight = fetch(`${context.baseUrl}/api/v1/probe/in-flight`);
  await context.state.started;

  closing = context.app.close();
  await assert.rejects(fetch(`${context.baseUrl}/api/v1/probe/in-flight`));
  context.state.release();
  const response = await inFlight;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { completed: true });
  await closing;
});
